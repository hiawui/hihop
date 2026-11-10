import './style.css';

type Data = Record<string, any>;
const app = document.querySelector<HTMLDivElement>('#app')!;
let token = sessionStorage.getItem('hihop-token') ?? '';
let config: Data;
let tab = 'overview';
let proxyTab = 'nodes';
let importWarnings: string[] = [];
let importing = false;
let selecting = false;
let refreshingSubscription = false;
let controllingService = false;
const probeRequests = new Set<string>();
const observedProbeCompletions = new Map<string, number>();
const esc = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
function toast(message: string, error = false) {
  document.querySelector('#toast')?.remove();
  const el = document.createElement('div');
  el.id = 'toast';
  el.className = error ? 'error' : '';
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 6500);
}
function editableConfig(c: Data) {
  return JSON.stringify({
    activeProfileId: c.activeProfileId,
    nodes: c.nodes,
    dns: c.dns,
    hosts: c.hosts,
    socks: c.socks,
    logLevel: c.logLevel,
    profiles: c.profiles.map((p: Data) => ({
      id: p.id,
      name: p.name,
      nodes: p.nodes,
      subscription: p.subscription
        ? {
            url: p.subscription.url,
            intervalHours: p.subscription.intervalHours,
            lastUpdatedAt: p.subscription.lastUpdatedAt,
          }
        : undefined,
    })),
  });
}
async function api(
  path: string,
  method = 'GET',
  body?: unknown,
  retry = true,
): Promise<any> {
  const baseline = config;
  const result = await fetch(`/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await result.json();
  if (
    result.status === 409 &&
    data.code === 'REVISION_CONFLICT' &&
    retry &&
    baseline?.selection.mode === 'auto' &&
    body &&
    typeof body === 'object' &&
    'revision' in body
  ) {
    const latest = await api('/config');
    // A background target change does not invalidate edits to unchanged configuration data.
    if (
      latest.selection.mode === 'auto' &&
      latest.editRevision === baseline.editRevision &&
      editableConfig(baseline) === editableConfig(latest) &&
      config.activeProfileId === latest.activeProfileId
    ) {
      config = latest;
      return api(path, method, { ...body, revision: latest.revision }, false);
    }
  }
  if (!result.ok)
    throw new Error(
      `${data.message ?? '操作失败'}${data.path ? ` (${data.path})` : ''}${data.line ? ` · 第 ${data.line} 行` : ''}`,
    );
  return data;
}
const targetValue = (t: Data) => (t.kind === 'node' ? t.id : t.kind);
const targetFrom = (value: string) =>
  value === 'direct' || value === 'reject'
    ? { kind: value }
    : { kind: 'node', id: value };
const endpoint = (e: Data) =>
  e.transport === 'udp'
    ? e.host
    : `${e.transport}://${e.host.includes(':') ? `[${e.host}]` : e.host}:${e.port}`;
function parseEndpoint(value: string): Data {
  if (!value.includes('://'))
    return { transport: 'udp', host: value, port: 53 };
  const u = new URL(value);
  if (
    !['tls:', 'tcp:'].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    (u.pathname && u.pathname !== '/')
  )
    throw new Error('无效 DNS 上游');
  return {
    transport: u.protocol.slice(0, -1),
    host: u.hostname.replace(/^\[|\]$/g, ''),
    port: Number(u.port || (u.protocol === 'tls:' ? 853 : 53)),
  };
}
const lines = (value: string) =>
  value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
function pairs(value: string, map: (v: string) => any): Data {
  return Object.fromEntries(
    lines(value).map((line) => {
      const i = line.indexOf('=');
      if (i < 1) throw new Error('请使用 域名 = 值 的格式');
      return [line.slice(0, i).trim(), map(line.slice(i + 1).trim())];
    }),
  );
}
const titles: Record<string, string[]> = {
  overview: ['运行概览', '配置好出口，让每个连接各就其位。'],
  proxy: ['配置管理', '管理当前配置的代理节点、DNS 和 hosts。'],
  settings: ['监听设置', '仅提供 SOCKS5 TCP 入口，Web 管理独立运行。'],
};
function routeHash(section = tab, child = proxyTab): string {
  return `#/${section}${section === 'proxy' ? `/${child}` : ''}`;
}
function syncRoute() {
  const match = location.hash.match(
    /^#\/(overview|settings|proxy(?:\/(nodes|dns|hosts))?)\/?$/,
  );
  const nextTab = match?.[1].startsWith('proxy')
    ? 'proxy'
    : (match?.[1] ?? 'overview');
  const nextProxyTab = nextTab === 'proxy' ? (match?.[2] ?? 'nodes') : proxyTab;
  const changed = tab !== nextTab || proxyTab !== nextProxyTab;
  tab = nextTab;
  proxyTab = nextProxyTab;
  const hash = routeHash();
  if (location.hash !== hash) history.replaceState(null, '', hash);
  if (changed && config) {
    render();
    void poll();
  }
}
function login() {
  app.innerHTML = `<section class="panel login"><div class="brand">HiHop<span>YOUR LOCAL PROXY</span></div><h1>连接管理面板</h1><p>从应用数据目录的 <code>admin-token</code> 文件中读取管理员 token。</p><form id="login"><label>管理员 token<input name="token" type="password" required autocomplete="current-password"></label><button class="primary">进入管理面板</button></form></section>`;
}
async function refresh() {
  config = await api('/config');
  render();
  notifyProbeCompletion();
  await poll();
}
function render() {
  app.innerHTML = `<div class="shell"><aside><div class="brand">HiHop<span>YOUR LOCAL PROXY</span></div><nav>${Object.entries(
    titles,
  )
    .map(
      ([id, [title]]) =>
        `<a href="${routeHash(id)}" data-tab="${id}" class="button ${tab === id ? 'active' : ''}"${tab === id ? ' aria-current="page"' : ''}>${title}</a>`,
    )
    .join(
      '',
    )}</nav><footer>TypeScript · TCP only<br>本地管理，轻松连接<br><button data-action="logout">退出面板</button></footer></aside><main><header><div><h1>${titles[tab][0]}</h1><p>${titles[tab][1]}</p></div><span class="badge" id="config-revision">配置 v${config.revision}</span></header><div id="content">${content()}</div><div class="status-line" id="last-error"></div></main></div><dialog id="node-dialog"></dialog><dialog id="profile-delete-dialog"></dialog><dialog id="profile-config-dialog" aria-labelledby="profile-config-title"></dialog>`;
}
const selectedName = () =>
  config.selection.target.kind === 'node'
    ? (config.nodes.find((n: Data) => n.id === config.selection.target.id)
        ?.name ?? '未选择')
    : config.selection.target.kind === 'direct'
      ? '直连'
      : '拒绝连接';
function overview(): string {
  return `<div class="cards"><div class="card"><small>代理服务</small><div class="metric" id="service-state">—</div><p id="listener">正在读取状态</p></div><div class="card"><small>已配置节点</small><div class="metric">${config.nodes.length}</div><p>节点配置不代表实际在线</p></div><div class="card"><small>当前出口</small><div class="metric">${esc(selectedName())}</div><p>${config.selection.mode === 'auto' ? '自动选择最低延迟节点' : '手动选择'}</p></div></div><section class="panel"><div class="toolbar"><h2>服务控制</h2><div class="actions"><button data-action="stop" disabled>停止代理</button><button class="primary" data-action="start" disabled>启动代理</button></div></div><p>SOCKS5 监听 ${esc(config.socks.host)}:${config.socks.port}。切换节点或配置仅影响新连接；停止代理或修改监听、认证会关闭现有连接。</p></section><section class="panel"><h2>开始使用</h2><p>在配置管理中添加节点，或直接导入 Clash 配置文件及 HTTP(S) 地址。每份配置独立保存节点选择、DNS 与 hosts。</p><a class="button" href="${routeHash('proxy', 'nodes')}" data-tab="proxy" data-proxy-tab="nodes">配置管理</a></section>`;
}
type ImportType = 'url' | 'file' | 'blank';
function importForm(type: ImportType): string {
  if (type === 'blank')
    return `<form id="profile-form"><label>配置名称<input name="name" required maxlength="255"></label><button class="primary">创建并切换</button></form><p class="hint">创建空白配置，之后可分别添加代理节点、DNS 和 hosts。</p>`;
  const hint =
    '<p class="hint">导入后新增并切换配置，原配置保留。忽略 Clash 的节点选择方式、路由规则、策略组与监听端口，默认自动探测。</p>';
  if (type === 'file')
    return `<label>选择 Clash 配置文件<input type="file" id="yaml-file" accept=".yaml,.yml,text/yaml"></label><p class="hint" id="file-import-status">选择 YAML 文件后直接导入，文件大小不超过 2 MiB。</p>${hint}`;
  return `<form id="url-form"><label>配置名称（可选）<input name="name" maxlength="255" placeholder="订阅配置"></label><label>HTTP(S) 配置地址<input name="url" type="url" placeholder="https://example.com/config.yaml" required></label><label>自动更新周期（小时）<input name="intervalHours" type="number" min="0.25" max="8760" step="0.25" value="4" required><span class="hint">此 HTTP(S) 配置按该周期重新下载，默认 4 小时。</span></label><button class="primary">直接导入</button></form><p class="hint">只接受公网 HTTP(S) 地址；下载限时 15 秒、大小 2 MiB。</p>${hint}`;
}
function importPanel(): string {
  return `<section id="import-panel"><div class="toolbar"><h2 id="profile-config-title">导入配置</h2><button data-action="close-config-dialog">关闭</button></div><label>配置类型<select id="import-type"><option value="url">HTTP(S) URL</option><option value="file">Clash 配置文件</option><option value="blank">空白配置</option></select></label><div id="import-form">${importForm('url')}</div>${importWarnings.length ? `<div class="notice"><strong>最近一次导入结果</strong><ul>${importWarnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}</section>`;
}
function subscriptionPanel(): string {
  const subscription = config.profiles.find(
    (p: Data) => p.id === config.activeProfileId,
  )?.subscription;
  if (!subscription) return '';
  const date = (time: number) =>
    time ? new Date(time).toLocaleString() : '尚未更新';
  return `<section id="subscription-panel"><div class="toolbar"><h2 id="profile-config-title">HTTP(S) 配置管理</h2><button data-action="close-config-dialog">关闭</button></div><div class="actions"><button data-action="refresh-subscription" ${refreshingSubscription || subscription.updating ? 'disabled' : ''}>${refreshingSubscription || subscription.updating ? '正在更新…' : '立即更新'}</button></div><form id="subscription-form" data-id="${esc(config.activeProfileId)}"><label>HTTP(S) 配置地址<input name="url" type="url" maxlength="8192" value="${esc(subscription.url)}" required><span class="hint">修改后，下次更新使用新地址；也可保存后点击立即更新。</span></label><label>更新周期（小时）<input name="intervalHours" type="number" min="0.25" max="8760" step="0.25" value="${subscription.intervalHours}" required><span class="hint">仅修改当前配置的更新周期，默认 4 小时；应用运行时，所有 HTTP(S) 配置按各自周期自动更新。</span></label><button>保存更新设置</button></form><p class="hint">上次成功：${esc(date(subscription.lastUpdatedAt))} · 下次更新：${subscription.lastUpdatedAt || subscription.lastError ? esc(date(subscription.nextUpdateAt)) : '即将更新'}</p>${subscription.lastError ? `<p class="notice">最近更新失败：${esc(subscription.lastError.message)}。保留原配置，按设定周期重试，也可立即更新。</p>` : ''}</section>`;
}
function deleteProfileButton(): string {
  return '<button class="danger" data-action="delete-profile">删除配置</button>';
}
function nodeListControls(): string {
  const probing =
    config.selection.probing || probeRequests.has(config.activeProfileId);
  return `<div class="actions node-controls"><select aria-label="节点选择方式" title="自动模式每小时探测一轮；连续测量 5 次，去掉最快和最慢后按平均延迟选择节点" name="mode" id="selection-mode" ${selecting ? 'disabled' : ''}><option value="manual" ${config.selection.mode === 'manual' ? 'selected' : ''}>手动选择</option><option value="auto" ${config.selection.mode === 'auto' ? 'selected' : ''}>自动探测</option></select><button data-action="probe-nodes" ${probing || selecting || !config.nodes.length ? 'disabled' : ''}>${probing ? '测速中…' : '测速'}</button><span class="badge">当前出口：${esc(selectedName())}</span></div>${config.selection.probeError ? `<p class="probe-error">${esc(config.selection.probeError.message)}</p>` : ''}`;
}
function nodeList(): string {
  return `<section class="panel" id="node-list"><div class="toolbar"><h2>节点列表 <span class="badge">${config.nodes.length}</span></h2>${nodeListControls()}<button class="primary" data-action="add-node">＋ 添加节点</button></div>${config.nodes.length ? `<div class="table-wrap"><table><thead><tr><th>名称 / 地址</th><th>协议</th><th>传输与认证</th><th title="绿色 ≤200 ms，橙色 ≤500 ms，红色 >500 ms 或不可用">延迟</th><th>操作</th></tr></thead><tbody>${config.nodes.map((n: Data) => `<tr><td><span class="node-title">${esc(n.name)}</span><span class="secret">${esc(n.server)}:${n.port}</span></td><td><span class="badge">${esc(n.type.toUpperCase())}</span></td><td>${n.type === 'ss' ? esc(n.cipher) : `${esc(n.network.toUpperCase())}${n.tls ? ' + TLS' : ''} · ${esc(n.authentication)}<br><span class="secret">AES-128-GCM</span>`}</td><td>${nodeLatency(n.id)}</td><td><div class="actions"><button data-action="select-node" data-id="${n.id}" ${selecting ? 'disabled' : ''}>${targetValue(config.selection.target) === n.id ? '已选择' : '选择'}</button><button data-action="edit-node" data-id="${n.id}">编辑</button><button class="danger" data-action="delete-node" data-id="${n.id}">删除</button></div></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty"><strong>还没有代理节点</strong>添加 SS / VMess 节点，或从 Clash 文件导入。</div>'}</section>`;
}
const proxyTabs: Record<string, string> = {
  nodes: '代理节点',
  dns: 'DNS',
  hosts: 'hosts',
};
function profileConfigDialog(kind: 'import' | 'subscription') {
  const dialog = document.querySelector<HTMLDialogElement>(
    '#profile-config-dialog',
  )!;
  dialog.innerHTML = kind === 'import' ? importPanel() : subscriptionPanel();
  if (dialog.innerHTML) dialog.showModal();
}
function proxyConfiguration(): string {
  const subscription = config.profiles.find(
    (p: Data) => p.id === config.activeProfileId,
  )?.subscription;
  return `<section class="panel profile-switcher"><div class="profile-picker"><label for="active-profile">当前配置</label><select id="active-profile">${config.profiles.map((p: Data) => `<option value="${esc(p.id)}" ${p.id === config.activeProfileId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div><div class="actions profile-actions">${subscription ? '<button data-action="edit-subscription">修改配置</button>' : ''}<button data-action="open-import">导入配置</button>${deleteProfileButton()}</div></section><div class="proxy-tabs" role="tablist" aria-label="配置管理">${Object.entries(
    proxyTabs,
  )
    .map(
      ([id, title]) =>
        `<a href="${routeHash('proxy', id)}" id="proxy-tab-${id}" role="tab" aria-selected="${proxyTab === id}" aria-controls="proxy-tabpanel" data-proxy-tab="${id}" class="button ${proxyTab === id ? 'active' : ''}">${title}</a>`,
    )
    .join(
      '',
    )}</div><div id="proxy-tabpanel" role="tabpanel" aria-labelledby="proxy-tab-${proxyTab}">${content(proxyTab)}</div>`;
}
function content(section = tab): string {
  if (section === 'proxy') return proxyConfiguration();
  if (section === 'overview') return overview();
  if (section === 'nodes') return nodeList();
  if (section === 'dns')
    return `<form id="dns-form" class="panel"><div class="toolbar"><h2>DNS 配置</h2><button class="primary">保存 DNS</button></div><div class="form-stack"><label><span><input name="enable" type="checkbox" ${config.dns.enable ? 'checked' : ''}>启用内部自定义 DNS</span><span class="hint">开启后使用下方 DNS 配置；关闭后使用系统解析器，hosts 开关仍独立生效。</span></label><label>引导上游 · default-nameserver<textarea name="bootstrap" required>${esc(config.dns.bootstrap.map(endpoint).join('\n'))}</textarea><span class="hint">用于解析 DNS 上游自身的域名，避免解析循环。端点必须使用 IP，可填写裸 IP、tcp://IP:端口 或 tls://IP:端口。</span></label><label>代理服务器上游 · proxy-server-nameserver<textarea name="proxyServerNameservers" placeholder="223.5.5.5">${esc(config.dns.proxyServerNameservers.map(endpoint).join('\n'))}</textarea><span class="hint">专门解析代理节点服务器的域名，实际连接与延迟探测均使用它。留空时遵循域名策略和普通上游；DNS 上游域名仍通过引导上游解析。</span></label><label>普通上游 · nameserver<textarea name="nameservers" required>${esc(config.dns.nameservers.map(endpoint).join('\n'))}</textarea><span class="hint">用于没有命中域名策略的普通域名查询。每行一个，裸 IP 为 UDP，也支持 tcp:// 与 tls:// 和自定义端口。</span></label><label>域名策略 · nameserver-policy<textarea name="policy" placeholder="+.example.com = tcp://dns.example.com:8080">${esc(
      Object.entries(config.dns.policy)
        .map(([k, v]) => `${k} = ${(v as Data[]).map(endpoint).join(', ')}`)
        .join('\n'),
    )}</textarea><span class="hint">为指定域名选择专用上游。精确域名优先，其次为最长 +. 后缀；多个上游用逗号分隔。已设置代理服务器上游时，节点域名不使用此策略。</span></label></div><p class="hint">地址选择为 A 优先、再 AAAA；每连接固定一个地址。转交给代理服务器解析的目标域名由远端处理。</p></form>`;
  if (section === 'hosts')
    return `<form id="hosts-form" class="panel"><div class="toolbar"><h2>hosts 配置</h2><button class="primary">保存 hosts</button></div><label><input name="useHosts" type="checkbox" ${config.dns.useHosts ? 'checked' : ''}>使用 hosts 覆盖</label><label>域名与 IP（每行一条）<textarea name="hosts" placeholder="example.local = 127.0.0.1">${esc(
      Object.entries(config.hosts)
        .map(([k, v]) => `${k} = ${v}`)
        .join('\n'),
    )}</textarea></label><p class="hint">格式为 域名 = IP。hosts 随当前配置独立保存，DNS 关闭时仍可生效。</p></form>`;
  if (section === 'settings')
    return `<form id="settings-form" class="panel"><h2>SOCKS5 监听</h2><div class="form-grid"><label>绑定 IP<input name="host" value="${esc(config.socks.host)}" required></label><label>端口<input name="port" type="number" min="1" max="65535" value="${config.socks.port}" required></label><label class="full"><input name="auth" type="checkbox" ${config.socks.auth ? 'checked' : ''}>启用用户名 / 密码认证（非回环监听必须启用）</label><label>用户名<input name="username" value="${esc(config.socks.auth?.username ?? '')}" autocomplete="off"></label><label>密码<input name="password" type="password" placeholder="${config.socks.auth ? '留空保留原密码' : '输入密码'}" autocomplete="new-password"></label><label>日志级别<select name="logLevel">${['silent', 'error', 'warning', 'info', 'debug'].map((l) => `<option ${config.logLevel === l ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div><p class="hint">监听、认证与日志设置对所有配置生效。Clash 文件中的监听端口会被忽略。Web 管理默认仅回环监听。</p><div class="divider"></div><button class="primary">保存监听设置</button></form>`;
  return '';
}
function nodeLatency(id: string): string {
  const result = config.selection.latencies.find((r: Data) => r.id === id);
  if (!result) return '—';
  if (result.latency === null)
    return `<span class="latency latency-red" title="${esc(result.error)}">不可用</span>`;
  const color =
    result.latency <= 200 ? 'green' : result.latency <= 500 ? 'orange' : 'red';
  const failureScore =
    result.sampleTimeoutMs === undefined
      ? '按测速超时计分'
      : `${result.sampleTimeoutMs} ms，按测速超时计分`;
  const title =
    result.samples?.length === 5
      ? `5 次探测：${result.samples.map((sample: number | null) => (sample === null ? `失败（${failureScore}）` : `${sample} ms`)).join(' / ')}；去掉最快和最慢后的平均延迟${result.error ? `；${result.error}` : ''}`
      : '本次探测延迟';
  return `<span class="latency latency-${color}" title="${esc(title)}">${Math.round(result.latency)} ms</span>`;
}
async function selectNode(mode: string, target: string) {
  if (selecting) return;
  selecting = true;
  render();
  try {
    await api('/selection', 'PUT', {
      revision: config.revision,
      selection: {
        mode,
        target: mode === 'auto' ? config.selection.target : targetFrom(target),
      },
    });
    await refresh();
    if (mode !== 'auto') toast('已切换节点');
    else if (config.selection.probing) toast('已启用自动选择，正在后台测速');
  } finally {
    selecting = false;
    render();
  }
}
async function importConfig(kind: 'file' | 'url', data: Data) {
  if (importing) return;
  importing = true;
  const dialog = document.querySelector<HTMLDialogElement>(
    '#profile-config-dialog',
  )!;
  const controls = [
    ...dialog.querySelectorAll<
      HTMLInputElement | HTMLButtonElement | HTMLSelectElement
    >('input, button, select'),
  ];
  controls.forEach((control) => {
    control.disabled = true;
  });
  const progress = dialog.querySelector(
    '#url-form button, #file-import-status',
  );
  const originalText = progress?.textContent;
  if (progress) progress.textContent = '正在导入并探测…';
  try {
    const result = await api(`/imports/${kind}`, 'POST', {
      ...data,
      revision: config.revision,
    });
    importWarnings = result.warnings;
    await refresh();
    toast('配置已导入并切换');
  } finally {
    importing = false;
    controls.forEach((control) => {
      control.disabled = false;
    });
    if (progress) progress.textContent = originalText ?? '';
  }
}
function nodeEditor(id?: string) {
  const n = config.nodes.find((n: Data) => n.id === id) ?? {
    type: 'ss',
    port: 8388,
    cipher: 'aes-256-gcm',
    network: 'tcp',
    alterId: 0,
    ws: { path: '/' },
  };
  const dialog = document.querySelector<HTMLDialogElement>('#node-dialog')!;
  dialog.innerHTML = `<h2>${id ? '编辑' : '添加'}代理节点</h2><form id="node-form" data-id="${id ?? ''}"><div class="form-grid"><label>名称<input name="name" value="${esc(n.name)}" required></label><label>协议<select name="type" id="node-type"><option value="ss" ${n.type === 'ss' ? 'selected' : ''}>Shadowsocks</option><option value="vmess" ${n.type === 'vmess' ? 'selected' : ''}>VMess</option></select></label><label>服务器<input name="server" value="${esc(n.server)}" required></label><label>端口<input name="port" type="number" min="1" max="65535" value="${n.port}" required></label><div class="full" id="protocol-fields"></div></div><div class="actions"><button class="primary">保存节点</button><button type="button" data-action="close-dialog">取消</button></div></form>`;
  protocolFields(n);
  dialog.showModal();
}
function protocolFields(n: Data = {}) {
  const type = (document.querySelector('#node-type') as HTMLSelectElement)
    .value;
  document.querySelector('#protocol-fields')!.innerHTML =
    type === 'ss'
      ? `<div class="form-grid"><label>加密<select name="cipher">${['aes-128-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305'].map((v) => `<option ${n.cipher === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label><label>密码<input name="password" type="password" placeholder="编辑时留空保留" autocomplete="new-password" ${n.id ? '' : 'required'}></label></div>`
      : `<div class="form-grid"><label>UUID<input name="uuid" type="password" placeholder="编辑时留空保留" autocomplete="new-password" ${n.id && n.type === 'vmess' ? '' : 'required'}></label><label>alterId<input name="alterId" type="number" min="0" max="64" value="${n.alterId ?? 0}" required><span class="hint">0 为 AEAD；非零使用 legacy 认证</span></label><label>传输<select name="network"><option value="tcp">TCP</option><option value="ws" ${n.network === 'ws' ? 'selected' : ''}>WebSocket</option></select></label><label><input name="tls" type="checkbox" ${n.tls ? 'checked' : ''}>启用 TLS（验证证书）</label><label>TLS servername<input name="servername" value="${esc(n.servername)}" placeholder="默认使用服务器域名"></label><label>数据加密<select name="cipher"><option>auto</option><option ${n.cipher === 'aes-128-gcm' ? 'selected' : ''}>aes-128-gcm</option></select><span class="hint">auto 实际使用 AES-128-GCM</span></label><label>WS path<input name="path" value="${esc(n.ws?.path ?? '/')}"></label><label>WS Host<input name="wsHost" value="${esc(n.ws?.host)}"></label></div>`;
}
function notifyProbeCompletion() {
  const id = config.activeProfileId;
  const version = config.selection.probeCompletedVersion ?? 0;
  const previous = observedProbeCompletions.get(id);
  observedProbeCompletions.set(id, version);
  if (previous === undefined || version <= previous || config.selection.probing)
    return;
  const available = config.selection.latencies.filter(
    (r: Data) =>
      r.latency !== null &&
      (!r.samples?.length ||
        r.samples.some((sample: number | null) => sample !== null)),
  ).length;
  const failed = config.nodes.length - available;
  const error = config.selection.probeError;
  toast(
    `测速完成：${available} 个可用，${failed} 个失败${error ? `。${error.message}` : ''}`,
    !!error || available === 0,
  );
}
function updateServiceControls(state?: string) {
  const start = document.querySelector<HTMLButtonElement>(
    '[data-action="start"]',
  );
  const stop = document.querySelector<HTMLButtonElement>(
    '[data-action="stop"]',
  );
  if (start)
    start.disabled =
      controllingService || (state !== 'stopped' && state !== 'error');
  if (stop) stop.disabled = controllingService || state !== 'running';
}
async function poll() {
  if (!config || !token) return;
  try {
    const s = await api('/status');
    if (
      s.probe?.profileId === config.activeProfileId &&
      s.probe.version !== config.selection.probeVersion
    ) {
      const expectedId = config.activeProfileId;
      const expectedVersion = config.selection.probeVersion;
      const latest = await api('/config');
      if (
        latest.activeProfileId === expectedId &&
        config.activeProfileId === expectedId &&
        latest.revision >= config.revision &&
        config.selection.probeVersion === expectedVersion
      ) {
        config = latest;
        const list = document.querySelector('#node-list');
        if (list) list.outerHTML = nodeList();
        if (tab === 'overview')
          document.querySelector('#content')!.innerHTML = overview();
        const revision = document.querySelector('#config-revision');
        if (revision) revision.textContent = `配置 v${config.revision}`;
        notifyProbeCompletion();
      }
    }
    updateServiceControls(s.state);
    const state = document.querySelector('#service-state');
    if (state)
      state.textContent = (
        {
          stopped: '已停止',
          running: '运行中',
          starting: '启动中',
          stopping: '停止中',
          applying: '应用中',
          error: '运行错误',
        } as Data
      )[s.state];
    const listener = document.querySelector('#listener');
    if (listener)
      listener.textContent = s.listener
        ? `${s.listener.host}:${s.listener.port} · ${s.connections} 个连接`
        : '管理页面保持可用';
    const error = document.querySelector('#last-error');
    if (error) {
      error.textContent = s.lastError ? `最近错误：${s.lastError.message}` : '';
      if (s.revision !== config.revision) {
        error.append(document.createTextNode(' 配置已在后台更新。'));
        const reload = document.createElement('button');
        reload.dataset.action = 'reload';
        reload.textContent = '载入最新配置';
        error.append(reload);
      }
    }
  } catch {
    /* explicit operations report errors; polling does not interrupt edits */
  }
}
app.addEventListener('change', (event) => {
  const el = event.target as HTMLInputElement;
  if (el.id === 'node-type') protocolFields();
  if (el.id === 'import-type' && !importing)
    document.querySelector('#import-form')!.innerHTML = importForm(
      el.value as ImportType,
    );
  if (el.id === 'selection-mode') {
    void selectNode(el.value, targetValue(config.selection.target)).catch((e) =>
      toast(e.message, true),
    );
  }
  if (el.id === 'active-profile')
    void (async () => {
      await api(`/profiles/${el.value}/activate`, 'POST', {
        revision: config.revision,
      });
      await refresh();
      toast('已切换配置');
    })().catch(async (e) => {
      await refresh();
      toast(e.message, true);
    });
  if (el.id === 'yaml-file' && el.files?.[0] && !importing)
    void (async () => {
      const file = el.files![0];
      if (file.size > 2097152) throw new Error('文件超过 2 MiB');
      await importConfig('file', {
        content: await file.text(),
        name: file.name?.replace(/\.ya?ml$/i, '') || '导入配置',
      });
    })().catch((e) => toast(e.message, true));
});
app.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  const f = new FormData(form);
  const value = (name: string) => String(f.get(name) ?? '');
  void (async () => {
    if (form.id === 'login') {
      token = value('token').trim();
      await api('/status');
      sessionStorage.setItem('hihop-token', token);
      await refresh();
      return;
    }
    if (form.id === 'node-form') {
      const type = value('type');
      const node: Data = {
        name: value('name'),
        server: value('server'),
        port: Number(value('port')),
        type,
        cipher: value('cipher'),
        udp: false,
      };
      if (type === 'ss') {
        if (value('password')) node.password = value('password');
      } else {
        if (value('uuid')) node.uuid = value('uuid');
        Object.assign(node, {
          alterId: Number(value('alterId')),
          network: value('network'),
          tls: f.has('tls'),
          servername: value('servername') || undefined,
          ws: {
            path: value('path') || '/',
            host: value('wsHost') || undefined,
          },
        });
      }
      const id = form.dataset.id;
      await api(id ? `/nodes/${id}` : '/nodes', id ? 'PATCH' : 'POST', {
        revision: config.revision,
        node,
      });
    }
    if (form.id === 'dns-form')
      await api('/dns', 'PUT', {
        revision: config.revision,
        hosts: config.hosts,
        dns: {
          enable: f.has('enable'),
          useHosts: config.dns.useHosts,
          nameservers: lines(value('nameservers')).map(parseEndpoint),
          proxyServerNameservers: lines(value('proxyServerNameservers')).map(
            parseEndpoint,
          ),
          bootstrap: lines(value('bootstrap')).map(parseEndpoint),
          policy: pairs(value('policy'), (s) =>
            s.split(',').map((x) => parseEndpoint(x.trim())),
          ),
        },
      });
    if (form.id === 'hosts-form')
      await api('/dns', 'PUT', {
        revision: config.revision,
        hosts: pairs(value('hosts'), (s) => s),
        dns: { ...config.dns, useHosts: f.has('useHosts') },
      });
    if (form.id === 'settings-form')
      await api('/settings', 'PATCH', {
        revision: config.revision,
        logLevel: value('logLevel'),
        socks: {
          host: value('host'),
          port: Number(value('port')),
          auth: f.has('auth')
            ? {
                username: value('username'),
                ...(value('password') ? { password: value('password') } : {}),
              }
            : null,
        },
      });
    if (form.id === 'url-form') {
      await importConfig('url', {
        url: value('url'),
        intervalHours: Number(value('intervalHours')),
        ...(value('name').trim() ? { name: value('name').trim() } : {}),
      });
      return;
    }
    if (form.id === 'subscription-form')
      await api(`/profiles/${form.dataset.id}/subscription`, 'PATCH', {
        revision: config.revision,
        url: value('url'),
        intervalHours: Number(value('intervalHours')),
      });
    if (form.id === 'profile-form')
      await api('/profiles', 'POST', {
        revision: config.revision,
        name: value('name'),
      });
    await refresh();
    toast('配置已保存');
  })().catch((e) => toast(e.message, true));
});
app.addEventListener('click', (event) => {
  const link = (event.target as HTMLElement).closest<HTMLAnchorElement>(
    'a[data-tab], a[data-proxy-tab]',
  );
  if (link) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      (link.target && link.target !== '_self')
    )
      return;
    event.preventDefault();
    if (location.hash !== link.hash) history.pushState(null, '', link.hash);
    syncRoute();
    return;
  }
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
    'button',
  );
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  if (!action) return;
  void (async () => {
    if (action === 'logout') {
      token = '';
      sessionStorage.removeItem('hihop-token');
      config = undefined as any;
      observedProbeCompletions.clear();
      login();
      return;
    }
    if (action === 'add-node' || action === 'edit-node') {
      nodeEditor(button.dataset.id);
      return;
    }
    if (action === 'close-dialog') {
      document.querySelector<HTMLDialogElement>('#node-dialog')!.close();
      return;
    }
    if (action === 'delete-profile') {
      const profile = config.profiles.find(
        (p: Data) => p.id === config.activeProfileId,
      );
      const dialog = document.querySelector<HTMLDialogElement>(
        '#profile-delete-dialog',
      )!;
      dialog.innerHTML = `<h2>删除配置</h2><p>删除“${esc(profile.name)}”及其节点、DNS、hosts 和更新设置？</p><p class="hint">${config.profiles.length === 1 ? '删除最后一份配置后会创建空白默认配置，监听设置保留。' : '删除当前配置后会切换到剩余的第一份配置。'}</p><div class="actions"><button class="danger" data-action="confirm-delete-profile" data-id="${esc(profile.id)}">删除</button><button data-action="cancel-delete-profile">取消</button></div>`;
      dialog.showModal();
      return;
    }
    if (action === 'cancel-delete-profile') {
      document
        .querySelector<HTMLDialogElement>('#profile-delete-dialog')!
        .close();
      return;
    }
    if (action === 'confirm-delete-profile') {
      await api(`/profiles/${button.dataset.id}`, 'DELETE', {
        revision: config.revision,
      });
      await refresh();
      toast('配置已删除');
      return;
    }
    if (action === 'probe-nodes') {
      const id = config.activeProfileId;
      const expectedVersion = config.selection.probeVersion;
      if (config.selection.probing || probeRequests.has(id)) return;
      probeRequests.add(id);
      button.disabled = true;
      button.textContent = '测速中…';
      try {
        const selection = await api('/probes', 'POST', {
          revision: config.revision,
        });
        if (
          config.activeProfileId === id &&
          config.selection.probeVersion === expectedVersion
        ) {
          config.selection = selection;
          notifyProbeCompletion();
          void poll();
        }
      } finally {
        probeRequests.delete(id);
        const list = document.querySelector('#node-list');
        if (list && config.activeProfileId === id) list.outerHTML = nodeList();
      }
      return;
    }
    if (action === 'delete-node')
      await api(`/nodes/${button.dataset.id}`, 'DELETE', {
        revision: config.revision,
      });
    if (action === 'start' || action === 'stop') {
      if (controllingService) return;
      controllingService = true;
      updateServiceControls();
      try {
        await api(`/service/${action}`, 'POST');
        await refresh();
        toast(
          action === 'start'
            ? '代理已启动，节点连通性需实际请求验证'
            : '代理已停止',
        );
      } finally {
        controllingService = false;
        await poll();
      }
      return;
    }
    if (action === 'refresh-subscription') {
      const dialog = document.querySelector<HTMLDialogElement>(
        '#profile-config-dialog',
      )!;
      const id = config.activeProfileId;
      refreshingSubscription = true;
      button.disabled = true;
      button.textContent = '正在更新…';
      try {
        await api(`/profiles/${id}/refresh`, 'POST');
        const reopen = dialog.open;
        await refresh();
        if (reopen && config.activeProfileId === id)
          profileConfigDialog('subscription');
        toast('配置已更新');
      } finally {
        refreshingSubscription = false;
        const refreshButton = document.querySelector<HTMLButtonElement>(
          '[data-action="refresh-subscription"]',
        );
        if (refreshButton) {
          refreshButton.disabled = false;
          refreshButton.textContent = '立即更新';
        }
      }
      return;
    }
    if (action === 'open-import' || action === 'edit-subscription') {
      profileConfigDialog(action === 'open-import' ? 'import' : 'subscription');
      return;
    }
    if (action === 'close-config-dialog') {
      document
        .querySelector<HTMLDialogElement>('#profile-config-dialog')!
        .close();
      return;
    }
    if (action === 'select-node') {
      await selectNode('manual', button.dataset.id!);
      return;
    }
    await refresh();
    toast('操作已完成');
  })().catch((e) => toast(e.message, true));
});
window.addEventListener('popstate', syncRoute);
window.addEventListener('hashchange', syncRoute);
syncRoute();
if (token) void refresh().catch(() => login());
else login();
setInterval(() => {
  if (document.visibilityState === 'visible') void poll();
}, 3000);
