import { AppError, invariant, safeError } from '../errors.js';
import {
  profileFrom,
  initialConfig,
  runtimeConfig,
  validateSettings,
  type Config,
  type Settings,
  type Selection,
  type Subscription,
} from './model.js';
import { ConfigStore } from './storage.js';
import { Router } from '../routing/router.js';
import { ProxyService } from '../proxy/service.js';
import {
  probeNodes,
  fastestNode,
  AUTO_PROBE_SAMPLES,
  AUTO_PROBE_INTERVAL,
  type ProbeResult,
} from '../proxy/probe.js';
import { downloadConfig } from '../import/download.js';
import { importClash } from '../import/clash.js';

export class ConfigManager {
  private queue: Promise<unknown> = Promise.resolve();
  private service?: ProxyService;
  private measurements = new Map<string, ProbeResult[]>();
  private probeJobs = new Map<
    string,
    { cancel: AbortController; fingerprint: string }
  >();
  private probeErrors = new Map<string, ReturnType<typeof safeError>>();
  private probeVersions = new Map<string, number>();
  private probeCompletedVersions = new Map<string, number>();
  private probeStarts = new Map<string, number>();
  private probeScheduleStart = Date.now();
  private refreshJobs = new Map<string, Promise<Config>>();
  private refreshControllers = new Map<string, AbortController>();
  private refreshAttempts = new Map<
    string,
    { time: number; error?: ReturnType<typeof safeError> }
  >();
  private state:
    'stopped' | 'starting' | 'running' | 'applying' | 'stopping' | 'error' =
    'stopped';
  private lastError?: ReturnType<typeof safeError>;
  private editableRevision: number;
  private constructor(
    readonly store: ConfigStore,
    private settings: Settings,
    private probe = probeNodes,
    private download = downloadConfig,
  ) {
    this.editableRevision = settings.revision;
  }
  get editRevision() {
    return this.editableRevision;
  }
  static async create(
    store: ConfigStore,
    probe = probeNodes,
    download = downloadConfig,
  ) {
    return new ConfigManager(store, await store.load(), probe, download);
  }
  get config(): Config {
    return runtimeConfig(this.settings);
  }
  profiles() {
    return {
      activeProfileId: this.settings.activeProfileId,
      revision: this.settings.revision,
      profiles: this.settings.profiles.map((p) => ({
        id: p.id,
        name: p.name,
        nodes: p.nodes.length,
        ...(p.subscription
          ? {
              subscription: {
                ...p.subscription,
                nextUpdateAt: this.nextUpdateAt(p.id, p.subscription),
                updating: this.refreshJobs.has(p.id),
                lastError: this.refreshAttempts.get(p.id)?.error,
              },
            }
          : {}),
      })),
    };
  }
  selection() {
    const profile = this.settings.profiles.find(
      (p) => p.id === this.settings.activeProfileId,
    )!;
    return {
      ...profile.selection,
      latencies: this.measurements.get(profile.id) ?? [],
      probing: this.probeJobs.has(profile.id),
      probeError: this.probeErrors.get(profile.id),
      probeVersion: this.probeVersions.get(profile.id) ?? 0,
      probeCompletedVersion: this.probeCompletedVersions.get(profile.id) ?? 0,
    };
  }
  async selectNode(
    revision: number,
    selection: Selection,
    signal?: AbortSignal,
    background = false,
  ) {
    const result = await this.update(
      revision,
      (s) => {
        const profile = s.profiles.find((p) => p.id === s.activeProfileId)!;
        profile.selection = {
          mode: selection.mode,
          target:
            background && selection.mode === 'auto'
              ? profile.selection.target
              : selection.target,
        };
        return s;
      },
      selection.mode === 'auto' && !background,
      signal,
    );
    if (background && selection.mode === 'auto') this.launchProbe();
    return result;
  }
  private probeFingerprint(id: string) {
    const profile = this.settings.profiles.find((p) => p.id === id);
    return profile
      ? JSON.stringify({
          nodes: profile.nodes,
          dns: profile.dns,
          hosts: profile.hosts,
          selection: profile.selection,
        })
      : '';
  }
  private cancelProbe(id: string) {
    const job = this.probeJobs.get(id);
    if (!job) return;
    this.probeJobs.delete(id);
    job.cancel.abort();
    this.probeVersions.set(id, (this.probeVersions.get(id) ?? 0) + 1);
  }
  private discardStaleProbes(automaticTarget = false) {
    for (const [id, job] of this.probeJobs) {
      if (automaticTarget && id === this.settings.activeProfileId)
        job.fingerprint = this.probeFingerprint(id);
      if (
        id !== this.settings.activeProfileId ||
        job.fingerprint !== this.probeFingerprint(id)
      )
        this.cancelProbe(id);
    }
  }
  async probeActive(revision: number) {
    return this.serial(async () => {
      if (revision !== this.config.revision)
        throw new AppError(
          'REVISION_CONFLICT',
          '配置已变更，请刷新后重试',
          409,
        );
      invariant(this.config.nodes.length, '没有可测速的节点');
      this.launchProbe();
      return this.selection();
    });
  }
  async probeIfDue(now = Date.now()) {
    return this.serial(async () => {
      const id = this.settings.activeProfileId;
      if (
        this.selection().mode === 'auto' &&
        this.config.nodes.length &&
        !this.probeJobs.has(id) &&
        now - (this.probeStarts.get(id) ?? this.probeScheduleStart) >=
          AUTO_PROBE_INTERVAL
      )
        this.launchProbe(now);
    });
  }
  private launchProbe(now = Date.now()) {
    const id = this.settings.activeProfileId;
    if (!this.config.nodes.length) return;
    const fingerprint = this.probeFingerprint(id);
    if (this.probeJobs.get(id)?.fingerprint === fingerprint) return;
    this.cancelProbe(id);
    const cancel = new AbortController();
    const config = structuredClone(this.config);
    const sampleCount =
      this.selection().mode === 'auto' ? AUTO_PROBE_SAMPLES : 1;
    this.probeStarts.set(id, now);
    this.probeErrors.delete(id);
    this.probeVersions.set(id, (this.probeVersions.get(id) ?? 0) + 1);
    const job = { cancel, fingerprint };
    this.probeJobs.set(id, job);
    void (async () => {
      try {
        const results = await this.probe(
          config,
          cancel.signal,
          undefined,
          sampleCount,
        );
        await this.serial(async () => {
          if (
            cancel.signal.aborted ||
            this.probeJobs.get(id) !== job ||
            id !== this.settings.activeProfileId ||
            this.probeFingerprint(id) !== fingerprint
          )
            return;
          this.measurements.set(id, results);
          if (this.selection().mode === 'auto') {
            const target = { kind: 'node' as const, id: fastestNode(results) };
            if (
              JSON.stringify(target) !== JSON.stringify(this.selection().target)
            )
              await this.apply(
                this.config.revision,
                (s) => {
                  s.profiles.find((p) => p.id === id)!.selection.target =
                    target;
                  return s;
                },
                false,
                undefined,
                true,
              );
          }
        });
      } catch (error) {
        if (!cancel.signal.aborted && this.probeJobs.get(id) === job)
          this.probeErrors.set(id, safeError(error));
      } finally {
        if (this.probeJobs.get(id) === job) {
          this.probeJobs.delete(id);
          this.probeVersions.set(id, (this.probeVersions.get(id) ?? 0) + 1);
          this.probeCompletedVersions.set(id, this.probeVersions.get(id)!);
        }
      }
    })();
  }
  async addProfile(
    revision: number,
    name: string,
    config: Config,
    subscription?: Subscription,
    signal?: AbortSignal,
  ) {
    return this.update(
      revision,
      (s) => {
        const profile = profileFrom(
          config,
          name,
          undefined,
          'auto',
          subscription,
        );
        s.profiles.push(profile);
        s.activeProfileId = profile.id;
        return s;
      },
      true,
      signal,
    );
  }
  downloadProfile(url: string, signal?: AbortSignal) {
    return this.download(url, signal);
  }
  async setUpdateInterval(revision: number, id: string, intervalHours: number) {
    return this.setSubscription(revision, id, { intervalHours });
  }
  async setSubscription(
    revision: number,
    id: string,
    changes: { url?: string; intervalHours?: number },
  ) {
    const oldUrl = this.settings.profiles.find((p) => p.id === id)?.subscription
      ?.url;
    const result = await this.update(revision, (s) => {
      const profile = s.profiles.find((p) => p.id === id);
      invariant(profile?.subscription, '该配置没有 HTTP(S) 更新地址');
      Object.assign(profile.subscription, changes);
      if (profile.subscription.url !== oldUrl)
        profile.subscription.lastUpdatedAt = 0;
      return s;
    });
    if (
      this.settings.profiles.find((p) => p.id === id)?.subscription?.url !==
      oldUrl
    ) {
      this.cancelRefresh(id);
      this.refreshAttempts.delete(id);
    }
    return result;
  }
  private cancelRefresh(id: string) {
    this.refreshControllers.get(id)?.abort();
    this.refreshControllers.delete(id);
    this.refreshJobs.delete(id);
  }
  async deleteProfile(revision: number, id: string) {
    const deletingActive = this.settings.activeProfileId === id;
    const result = await this.update(revision, (s) => {
      invariant(
        s.profiles.some((p) => p.id === id),
        '配置不存在',
      );
      s.profiles = s.profiles.filter((p) => p.id !== id);
      if (!s.profiles.length)
        s.profiles.push(
          profileFrom(initialConfig(), '默认配置', undefined, 'auto'),
        );
      if (s.activeProfileId === id) s.activeProfileId = s.profiles[0].id;
      return s;
    });
    this.cancelProbe(id);
    this.cancelRefresh(id);
    this.measurements.delete(id);
    this.probeErrors.delete(id);
    this.probeVersions.delete(id);
    this.probeCompletedVersions.delete(id);
    this.probeStarts.delete(id);
    this.refreshAttempts.delete(id);
    if (deletingActive && this.selection().mode === 'auto') this.launchProbe();
    return result;
  }
  private nextUpdateAt(id: string, subscription: Subscription) {
    return (
      Math.max(
        subscription.lastUpdatedAt,
        this.refreshAttempts.get(id)?.time ?? 0,
      ) +
      subscription.intervalHours * 3600000
    );
  }
  async refreshDueProfiles(signal?: AbortSignal, now = Date.now()) {
    for (const profile of this.settings.profiles) {
      signal?.throwIfAborted();
      if (
        !profile.subscription ||
        this.nextUpdateAt(profile.id, profile.subscription) > now
      )
        continue;
      try {
        await this.refreshProfile(profile.id, signal);
      } catch {
        signal?.throwIfAborted();
        // Each profile reports its own failure and retries at its configured interval.
      }
    }
  }
  refreshProfile(id: string, signal?: AbortSignal): Promise<Config> {
    const currentJob = this.refreshJobs.get(id);
    if (currentJob) return currentJob;
    const cancel = new AbortController();
    this.refreshControllers.set(id, cancel);
    const job = this.refreshProfileContent(
      id,
      AbortSignal.any([cancel.signal, ...(signal ? [signal] : [])]),
    ).finally(() => {
      if (this.refreshJobs.get(id) === job) {
        this.refreshJobs.delete(id);
        this.refreshControllers.delete(id);
      }
    });
    this.refreshJobs.set(id, job);
    return job;
  }
  private async refreshProfileContent(
    id: string,
    signal?: AbortSignal,
  ): Promise<Config> {
    const source = this.settings.profiles.find(
      (p) => p.id === id,
    )?.subscription;
    try {
      invariant(source, '该配置没有 HTTP(S) 更新地址');
      const parsed = importClash(await this.download(source.url, signal));
      signal?.throwIfAborted();
      const result = await this.serial(() =>
        this.apply(
          this.config.revision,
          (s) => {
            const index = s.profiles.findIndex((p) => p.id === id);
            const previous = s.profiles[index];
            invariant(
              previous?.subscription?.url === source.url,
              '配置更新地址已变更，请重试',
            );
            const config = structuredClone(parsed.config);
            // Subscription refreshes retain IDs and the user's manual selection when names/types match.
            for (const node of config.nodes) {
              const old = previous.nodes.find(
                (n) => n.name === node.name && n.type === node.type,
              );
              if (old) node.id = old.id;
            }
            const target = previous.selection.target;
            config.rules[0].target =
              target.kind !== 'node' ||
              config.nodes.some((n) => n.id === target.id)
                ? target
                : config.nodes[0]
                  ? { kind: 'node', id: config.nodes[0].id }
                  : { kind: 'direct' };
            s.profiles[index] = profileFrom(
              config,
              previous.name,
              id,
              previous.selection.mode,
              {
                ...previous.subscription,
                lastUpdatedAt: Date.now(),
              },
            );
            return s;
          },
          id === this.settings.activeProfileId,
          signal,
        ),
      );
      this.refreshAttempts.set(id, { time: Date.now() });
      // Inactive profiles are probed on activation; their old latencies no longer apply.
      if (id !== this.settings.activeProfileId) this.measurements.delete(id);
      return result;
    } catch (error) {
      if (
        source &&
        this.settings.profiles.find((p) => p.id === id)?.subscription?.url ===
          source.url
      )
        this.refreshAttempts.set(id, {
          time: Date.now(),
          error: safeError(error),
        });
      throw error;
    }
  }
  async activateProfile(revision: number, id: string) {
    const result = await this.update(
      revision,
      (s) => {
        invariant(
          s.profiles.some((p) => p.id === id),
          '配置不存在',
        );
        s.activeProfileId = id;
        return s;
      },
      false,
    );
    if (this.selection().mode === 'auto') this.launchProbe();
    return result;
  }
  status() {
    return {
      state:
        this.state === 'running' && !this.service?.listening
          ? 'error'
          : this.state,
      activeProfileId: this.settings.activeProfileId,
      revision: this.config.revision,
      activeRevision: this.service?.listening ? this.config.revision : null,
      listener: this.service?.listening
        ? { host: this.config.socks.host, port: this.config.socks.port }
        : null,
      connections: this.service?.connections ?? 0,
      lastError: this.service?.lastError ?? this.lastError,
      probe: {
        profileId: this.settings.activeProfileId,
        running: this.selection().probing,
        version: this.selection().probeVersion,
      },
    };
  }
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => {});
    return result;
  }
  async start() {
    return this.serial(async () => {
      if (this.service?.listening) return this.status();
      if (this.selection().mode === 'auto' && this.config.nodes.length)
        await this.apply(this.config.revision, (s) => s, true);
      this.state = 'starting';
      let router: Router | undefined;
      try {
        router = await Router.compile(this.config);
        const service = new ProxyService(router);
        await service.bind();
        service.activate();
        this.service = service;
        this.state = 'running';
        this.lastError = undefined;
      } catch (error) {
        router?.close();
        this.state = 'error';
        this.lastError = safeError(error);
        throw error;
      }
      return this.status();
    });
  }
  async stop() {
    for (const id of this.probeJobs.keys()) this.cancelProbe(id);
    return this.serial(async () => {
      for (const id of this.probeJobs.keys()) this.cancelProbe(id);
      this.state = 'stopping';
      await this.service?.stop();
      this.service?.router.close();
      this.service = undefined;
      this.state = 'stopped';
      return this.status();
    });
  }
  async change(
    revision: number,
    modify: (config: Config) => Config,
  ): Promise<Config> {
    return this.update(revision, (s) => {
      const config = modify(runtimeConfig(s));
      s.socks = config.socks;
      s.logLevel = config.logLevel;
      const target = config.rules.at(-1)!.target;
      if (
        target.kind === 'node' &&
        !config.nodes.some((n) => n.id === target.id)
      )
        config.rules.at(-1)!.target = config.nodes[0]
          ? { kind: 'node', id: config.nodes[0].id }
          : { kind: 'direct' };
      s.profiles = s.profiles.map((p) =>
        p.id === s.activeProfileId
          ? profileFrom(config, p.name, p.id, p.selection.mode, p.subscription)
          : p,
      );
      return s;
    });
  }
  private async update(
    revision: number,
    modify: (settings: Settings) => Settings,
    detect = false,
    signal?: AbortSignal,
  ): Promise<Config> {
    return this.serial(() => this.apply(revision, modify, detect, signal));
  }
  private async apply(
    revision: number,
    modify: (settings: Settings) => Settings,
    detect: boolean,
    signal?: AbortSignal,
    automaticTarget = false,
  ): Promise<Config> {
    if (revision !== this.config.revision)
      throw new AppError('REVISION_CONFLICT', '配置已变更，请刷新后重试', 409);
    const settings = validateSettings(modify(structuredClone(this.settings)));
    settings.revision = this.config.revision + 1;
    const profile = settings.profiles.find(
      (p) => p.id === settings.activeProfileId,
    )!;
    const previousProfile = this.settings.profiles.find(
      (p) => p.id === profile.id,
    );
    const nodesChanged =
      JSON.stringify(previousProfile?.nodes) !== JSON.stringify(profile.nodes);
    let measured: ProbeResult[] | undefined;
    let probedAt: number | undefined;
    if (
      (detect || nodesChanged) &&
      profile.selection.mode === 'auto' &&
      profile.nodes.length
    ) {
      probedAt = Date.now();
      measured = await this.probe(
        runtimeConfig(settings),
        signal,
        undefined,
        AUTO_PROBE_SAMPLES,
      );
      profile.selection.target = { kind: 'node', id: fastestNode(measured) };
    }
    validateSettings(settings);
    signal?.throwIfAborted();
    const candidate = runtimeConfig(settings);
    const contentChanged =
      JSON.stringify({ ...candidate, revision: 0 }) !==
      JSON.stringify({ ...this.config, revision: 0 });
    if (!contentChanged) {
      await this.store.save(settings);
      this.settings = settings;
      if (!automaticTarget) this.editableRevision = settings.revision;
      this.discardStaleProbes(automaticTarget);
      if (measured) {
        this.measurements.set(profile.id, measured);
        this.probeStarts.set(profile.id, probedAt!);
      }
      return this.config;
    }
    const router = await Router.compile(candidate);
    const previous = this.service;
    const running = !!previous?.listening;
    const smooth =
      running &&
      JSON.stringify(previous!.router.config.socks) ===
        JSON.stringify(candidate.socks);
    this.state = 'applying';
    let next: ProxyService | undefined;
    try {
      if (previous && !smooth) await previous.stop();
      if (running && !smooth) {
        next = new ProxyService(router);
        await next.bind();
      }
      await this.store.save(settings);
      this.settings = settings;
      if (!automaticTarget) this.editableRevision = settings.revision;
      this.discardStaleProbes(automaticTarget);
      if (measured) {
        this.measurements.set(profile.id, measured);
        this.probeStarts.set(profile.id, probedAt!);
      } else if (nodesChanged) this.measurements.delete(profile.id);
      if (smooth) {
        previous!.replaceRouter(router);
        this.service = previous;
        this.state = 'running';
      } else if (next) {
        previous?.router.close();
        this.service = next;
        next.activate();
        this.state = 'running';
      } else {
        previous?.router.close();
        this.service = undefined;
        router.close();
        this.state = 'stopped';
      }
      this.lastError = undefined;
      return this.config;
    } catch (error) {
      await next?.stop();
      router.close();
      this.lastError = safeError(error);
      if (smooth) {
        this.state = 'running';
        throw error;
      }
      if (running && previous) {
        try {
          await previous.bind();
          previous.activate();
          this.service = previous;
          this.state = 'running';
        } catch {
          this.service = undefined;
          previous.router.close();
          this.state = 'error';
          this.lastError = {
            code: 'RESTORE_FAILED',
            message: '应用失败且旧监听恢复失败，代理已停止',
          };
        }
      } else {
        this.service = undefined;
        previous?.router.close();
        this.state = 'stopped';
      }
      throw error;
    }
  }
}
