#!/bin/sh
# Run in the documented disposable Linux container, with the repository mounted read-only at /source.
set -eu
mkdir -p /work
cp -R /source/package.json /source/pnpm-lock.yaml /source/pnpm-workspace.yaml /source/mise.toml \
  /source/tsconfig.json /source/tsconfig.tools.json /source/vite.config.ts \
  /source/src /source/web /source/tests /source/scripts /source/clash-example.yaml /work/
cd /work
node --input-type=module <<'JS'
import { writeFile } from 'node:fs/promises';
const response = await fetch('https://github.com/jdx/mise/releases/download/v2026.10.25/mise-v2026.10.25-linux-x64.tar.gz', {signal: AbortSignal.timeout(45000)});
if (!response.ok) throw new Error('Unable to obtain pinned mise release');
await writeFile('/tmp/mise.tar.gz', Buffer.from(await response.arrayBuffer()));
JS
tar -xzf /tmp/mise.tar.gz -C /tmp
export MISE_TRUSTED_CONFIG_PATHS=/work
/tmp/mise/bin/mise install
/tmp/mise/bin/mise run setup
/tmp/mise/bin/mise run check
