# HiHop

使用 Node.js / TypeScript 实现的本地 SOCKS5 TCP 代理，提供 Web 管理、SS / VMess 出站、多配置切换、自动节点选择和内部 DNS。运行时无需外部代理内核、原生代理插件或 WASM。

Clash 配置用于导入节点、DNS 和 hosts；路由规则、策略组及模式会被忽略。全部新连接使用当前配置选定的出口。

## 快速启动

macOS / Linux 安装 [mise](https://mise.jdx.dev/getting-started.html) 后，在仓库目录执行：

```sh
mise trust
mise install
mise run setup
mise run build
mise run start
```

1. 打开 <http://127.0.0.1:7800>。
2. 在本机终端执行 `cat data/admin-token`，将 token 粘贴到登录页。若设置了 `HIHOP_DATA_DIR`，请从对应目录读取。
3. 在「配置管理」中点击「导入配置」，选择 HTTP(S) URL、Clash 配置文件或空白配置。
4. 确认当前出口后启动代理。默认 SOCKS5 地址为 `127.0.0.1:1080`；直接启动应用时代理保持停止，需在页面手动启动；下文的本机后台命令会自动开启代理。

通过 SOCKS5 访问目标：

```sh
curl --proxy socks5h://127.0.0.1:1080 https://example.com/
```

`socks5h` 将域名交给 HiHop。hosts 可以覆盖目标地址，直连出口由本机解析；经代理节点时可保留远端解析。`running` 仅表示 SOCKS5 正在接入连接，节点是否可用需通过测速或实际请求确认。单次连接失败不会自动更换出口或回退直连。

## 本机后台命令

完成依赖安装和构建后，安装本机启动脚本：

```sh
mise run install:launcher
hihop start
hihop status
hihop restart
hihop stop
```

命令安装到 `~/.local/bin/hihop`。如果该目录尚未加入 PATH，在 shell 配置中加入 `export PATH="$HOME/.local/bin:$PATH"`，或直接使用 `~/.local/bin/hihop start`。

`start` 在后台启动管理服务，并通过管理 API 开启当前配置的 SOCKS5 代理；命令仅在代理就绪后成功返回，关闭终端后继续运行。重复启动不会创建第二个进程；若只在页面停止了代理，再执行 `start` 会重新开启。`stop` 优雅退出后台应用并关闭已有连接，`restart` 先停止再启动，`status` 显示后台进程和实际代理状态。自动模式启动可能等待约 60 秒测速。脚本不配置开机自启。

配置和日志统一放在 `~/.hihop/`：

```text
~/.hihop/
  config.json       # 配置、节点凭据和订阅地址
  admin-token       # 管理员 token
  logs/
    hihop.log       # 后台 stdout / stderr
    hihop.log.1     # 上一次轮换的备份
  run/
    process.json    # PID、实例标记和管理端口
    control.lock    # 控制命令执行期间的锁
```

首次安装将当前数据目录的 `config.json` 和 `admin-token` 复制到 `~/.hihop/`，保留源文件，不覆盖目标目录已有文件。此后本机命令始终使用该目录，登录时读取 `~/.hihop/admin-token`；项目 `.env` 的 Web 端口设置仍生效。目录权限为 `0700`，配置、token、运行记录和日志为 `0600`。

查看运行日志：

```sh
tail -f ~/.hihop/logs/hihop.log
```

stdout 与 stderr 合并追加写入同一个文件；每次启动前，若日志达到 10 MiB，轮换为 `hihop.log.1`，仅保留一份备份。运行期间不自动轮换，也不记录完整访问流量。需要其他独立实例时可设置 `HIHOP_HOME=/absolute/path`，但需分配不同的 Web / SOCKS5 端口。

脚本固定使用安装时的 Node 可执行文件和仓库位置，不依赖终端是否加载 mise。移动仓库或更新 Node 安装位置后，重新执行 `mise run install:launcher`；更新源码后先构建，再执行 `hihop restart`。卸载时先停止，再删除 `~/.local/bin/hihop`；数据目录由用户按需保留。

## 配置管理

每份配置独立保存节点、选择方式、DNS 和 hosts，通过「当前配置」选择器整体切换。SOCKS5 监听、认证和日志为全局设置，所有配置共用。导入会新增并激活配置，原配置保留；最多保存 100 份。

[clash-example.yaml](clash-example.yaml) 展示支持的节点、DNS 和 hosts 格式。示例中的节点为占位值，使用前需替换。导入不会更改 HiHop 的监听地址、端口或认证，也不需要 GeoIP 数据库。完整字段行为见[导入兼容矩阵](docs/implementation.md#clash-导入)。

「删除配置」删除当前配置并切换到剩余第一份；删除最后一份时会创建空白默认配置，保留全局设置。无节点的配置使用直连出口。

### 选择节点与测速

新配置默认使用「自动探测」，已有配置保留保存的选择方式。

| 方式     | 行为                                                                     |
| -------- | ------------------------------------------------------------------------ |
| 手动选择 | 点击节点行的「选择」指定出口；「测速」执行一次测量，仅更新延迟。         |
| 自动探测 | 每节点测量 5 次，去掉最快和最慢样本，以剩余 3 次均值最小的节点作为出口。 |

测速经各节点请求 `https://www.gstatic.com/generate_204`，延迟包含 DNS、代理握手及 HTTPS 响应。失败样本按单节点超时 4 秒计分后再求均值；五次全部失败的节点仍以 4 秒得分参与比较，因此被选中不等于节点可用。悬停延迟可查看原始样本与失败说明。

切换配置时先使用已保存出口，再后台测速；启用自动模式和点击「测速」也在后台执行。自动模式下导入、启动代理和修改节点会触发探测；当前配置每小时自动重测，关闭浏览器仍会执行。应用重启后若未触发即时测速，首次定时探测在一小时后进行。完整计分、超时和调度规则见[节点探测](docs/implementation.md#节点探测)。

### HTTP(S) 配置更新

URL 导入的配置默认每 4 小时更新。点击「修改配置」可修改 URL、调整周期（0.25–8760 小时）或立即更新。应用启动时和运行期间每分钟检查到期任务，所有 URL 配置均参与；文件导入和空白配置不自动更新。

更新成功后替换节点、DNS 和 hosts，保留配置名称、ID、周期及选择方式，并尽量保留手动选中的节点。失败时保留原内容，按周期重试。修改 URL 会取消旧下载，现有内容保留到新地址更新成功。早期版本未保存导入地址的配置需重新通过 URL 导入才能启用更新。

### DNS 与连接切换

在 DNS 和 hosts 标签页编辑当前配置。`dns.enable=false` 时使用系统解析器，hosts 仍由 `use-hosts` 控制；启用自定义 DNS 后，只使用指定上游，失败不回退系统或公共 DNS。

- `nameserver`：普通域名上游；`nameserver-policy` 可按精确域名或 `+.` 后缀指定上游。
- `proxy-server-nameserver`：仅解析代理节点的服务器域名，供连接与测速使用；留空时沿用普通策略。
- `default-nameserver`：引导解析 DNS 上游自身的域名，必须使用 IP 地址。

导入支持裸 IP（UDP/53）、`tcp://` 和 `tls://` 端点，后两者可指定端口。

节点切换、配置切换和当前配置更新采用平滑切换：新连接使用新配置，已有连接保留原节点与 DNS/hosts 快照直至结束。停止代理或修改 SOCKS5 监听、认证会关闭已有连接。只修改更新周期或更新非当前配置不影响连接。

页面支持可复制的地址，例如 `/#/overview`、`/#/proxy/nodes`、`/#/proxy/dns`、`/#/proxy/hosts` 和 `/#/settings`；刷新、登录及前进后退会恢复对应页面。

## 本机设置与数据

直接运行 `mise run start` / `dev` 时，服务端自动加载当前工作目录的 `.env`；已有环境变量优先，修改后需重启。可从示例创建本机配置：

```sh
cp .env.example .env
```

| 环境变量         | 默认值   | 用途                                            |
| ---------------- | -------- | ----------------------------------------------- |
| `HIHOP_DATA_DIR` | `./data` | 配置与管理员 token 目录，相对当前工作目录解析。 |
| `HIHOP_WEB_PORT` | `7800`   | Web 端口，始终只绑定 `127.0.0.1`。              |

后台命令的数据目录固定为 `~/.hihop/`（可用 `HIHOP_HOME` 覆盖），优先于 `.env` 中的 `HIHOP_DATA_DIR`。本机后台进程不会自动加载 `mise.local.toml`，请将其端口配置写入项目 `.env` 或调用命令前导出的环境变量。

`.env`、`data/` 和 `mise.local.toml` 已加入 Git 忽略规则；也可在 `mise.local.toml` 的 `[env]` 中保存本机变量。

配置保存于数据目录的 `config.json`，管理员 token 保存于 `admin-token`。目录权限为 `0700`，写入的配置与 token 文件为 `0600`；节点凭据及订阅 URL 在本机明文保存，请保护数据目录。浏览器仅在当前会话保存登录 token，应用日志不打印 token、节点密码、UUID、会话密钥或下载 URL 查询串。

旧版单配置和多配置自动迁移，保留节点、DNS、hosts 和末尾出口，移除分流规则；下次保存使用 `schemaVersion=3`。迁移与保存机制见[配置和运行状态](docs/implementation.md#配置和运行状态)。

| 问题                   | 处理方式                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| 管理员 token 丢失      | 停止应用，删除数据目录内的 `admin-token`，重启后读取新 token。                                    |
| Web 或 SOCKS5 端口占用 | 释放端口或修改对应设置；应用不会自动换端口。Web 端口通过环境变量设置，SOCKS5 端口在管理页面设置。 |
| 配置版本冲突（409）    | 载入最新配置后重新提交；页面会保留尚未提交的表单。                                                |
| 节点被选中但请求失败   | 查看测速样本和失败原因，核对凭据、DNS 与网络；全失败节点也可能被自动选中。                        |

## 开发与验证

工具链由 `mise.toml` 固定为 Node.js 24.22.2 和 pnpm 11.28.5；依赖由 `pnpm-lock.yaml` 锁定。任务命令以 `package.json` 为准，mise 任务调用相同 scripts。

| 命令                        | 用途                                                    |
| --------------------------- | ------------------------------------------------------- |
| `mise run setup`            | 使用 `--frozen-lockfile` 安装依赖。                     |
| `mise run dev`              | Vite 自动重建静态资源，后端 watch；Web 改动后刷新页面。 |
| `mise run typecheck`        | 检查后端、前端和工具脚本类型。                          |
| `mise run test`             | 运行离线单元、固定向量、受控本机网络及 Web DOM 测试。   |
| `mise run build`            | 构建后端和 Web 静态资源。                               |
| `mise run check`            | 类型检查、基础测试和生产构建。                          |
| `mise run install:launcher` | 安装或更新本机后台命令，并复制已有配置（不覆盖）。      |
| `mise run start`            | 启动已构建应用。                                        |
| `mise run test:integration` | 使用 Docker 运行独立协议互通测试。                      |

安装工具链后也可直接运行 `pnpm dev`、`pnpm check` 等同名脚本。添加依赖使用 `pnpm add`，开发依赖使用 `pnpm add -D`，同时提交锁文件。esbuild 的安装脚本已在 `pnpm-workspace.yaml` 中允许执行。

独立互通测试需先启动 Docker 并准备固定镜像：

```sh
docker pull --platform linux/amd64 v2fly/v2fly-core@sha256:fc3df0da123b82d473d5251ece521cfdfa18ac70abd4da9bde4f120c3e17dc82
mise run test:integration
```

测试使用 V2Ray 4.31.3，覆盖 SS 三种算法和 VMess AEAD/legacy × TCP/TLS/WS/WSS 共 11 种组合。测试凭据随机生成，结束后删除容器与临时配置；缺少 Docker 或镜像会明确失败。首次拉取镜像需要网络，测试本身不访问外部目标。Docker 仅用于测试。

可选的干净 Linux 工具链验证会联网安装固定版本的 mise、Node.js、pnpm 和依赖，仓库以只读方式挂载，结束后删除容器：

```sh
docker run --rm --platform linux/amd64 -v "$PWD:/source:ro" \
  node@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 \
  sh /source/scripts/linux-check.sh
```

CI 在 macOS / Linux 运行 `setup` 和 `check`，Linux 另运行独立互通测试。兼容边界、API、资源限制和测试范围见 [实现与兼容说明](docs/implementation.md)，夹具来源与向量生成方法见 [测试夹具说明](tests/fixtures/README.md)。

## 许可证

本项目采用 [BSD-3-Clause](LICENSE) 许可证。第三方测试夹具的来源和许可见 [测试夹具说明](tests/fixtures/README.md) 及 [V2Ray 许可证](tests/fixtures/V2RAY-LICENSE)。
