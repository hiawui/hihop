# 实现与兼容说明

本文描述当前代码的兼容边界、运行机制和管理 API。启动、日常操作与验证命令见 [README](../README.md)，测试数据来源见 [夹具说明](../tests/fixtures/README.md)。

## 支持范围

| 层          | 支持                                                                                                | 不支持                                                       |
| ----------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 入站        | SOCKS5，无认证或用户名/密码认证，IPv4 / IPv6 / 域名 CONNECT                                         | SOCKS4、HTTP 代理、BIND、UDP ASSOCIATE                       |
| Shadowsocks | AEAD TCP：`aes-128-gcm`、`aes-256-gcm`、`chacha20-ietf-poly1305`                                    | SS2022、旧流加密、插件、UDP                                  |
| VMess       | `alterId=0` AEAD、`alterId=1–64` legacy；`auto` / `aes-128-gcm`；TCP / TLS / WS / WSS               | 跳过证书验证、其他数据 cipher、gRPC、H2、mKCP、动态端口、Mux |
| 节点选择    | 每配置手动指定出口或自动探测选择节点                                                                | 用户分流规则、Clash 策略组                                   |
| DNS         | hosts、A / AAAA、CNAME、NXDOMAIN、TTL 缓存、UDP / TCP / DoT、上游引导解析、精确域名和 `+.` 后缀策略 | DoH、DoQ、fake-ip、对外 DNS listener、隐式公共 DNS 回退      |

运行时由 Node.js 和项目依赖组成，不调用外部代理内核。Go 向量生成器和 Docker 参考服务端仅用于测试。旧规则模块保留用于兼容测试；实际配置只向传输引擎提供一个 `MATCH` 出口，不提供规则管理 API。GeoIP 数据库读取与依赖已移除；旧配置中的 GEOIP 字段仅用于迁移时识别并丢弃，运行时拒绝此类规则。

## Clash 导入

导入入口直接在后端解析、校验并保存，无预览或二次应用步骤。每次文件或 URL 导入都新增并激活独立配置；名称可重复，ID 唯一。节点凭据仅由后端保存，API 返回脱敏结果。

### 字段兼容矩阵

| 字段                                                                                         | 行为                                                                                                               |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `proxies`                                                                                    | 严格校验 SS / VMess；导入时为节点分配随机 ID。                                                                     |
| `hosts`                                                                                      | 域名到 IPv4 / IPv6 的映射，实际用于内部解析。                                                                      |
| `dns`                                                                                        | 支持 `enable`、`use-hosts`、`default-nameserver`、`nameserver`、`proxy-server-nameserver` 和 `nameserver-policy`。 |
| `port`、`mixed-port`、`socks-port`、`redir-port`、`tproxy-port`、`allow-lan`、`bind-address` | 忽略并提示；监听地址与端口由 HiHop 全局设置控制。                                                                  |
| `authentication`、`log-level`                                                                | 忽略并提示；认证和日志由 HiHop 全局设置控制。                                                                      |
| `mode`、`rules`、`proxy-groups`、`rule-providers`                                            | 忽略并提示；不校验规则语义或组成员，不下载规则提供者。                                                             |
| `external-controller`、`unified-delay`                                                       | 忽略并提示，不启用对应行为。                                                                                       |
| 节点 `udp`                                                                                   | 保留声明并提示当前只有 TCP 入口。                                                                                  |
| VMess `ws-opts`                                                                              | 支持 `path` 与 `headers.Host`；其他项报错。                                                                        |
| VMess `skip-cert-verify`                                                                     | 仅允许 `false` 或缺省；`true` 报错。                                                                               |
| 其他字段                                                                                     | 报错，包括未支持的 `dns.listen` 等行为字段。                                                                       |

域名按大小写和末尾点规范化，限制标签长度、字符和空标签；接受 `fc-.cdn.bcebos.com` 这类标签首尾带连字符的名称。节点名称必须唯一，不能使用 `DIRECT` 或 `REJECT`。

### YAML 与下载边界

YAML 接受单文档 UTF-8 / BOM、中文、注释及行内映射；拒绝重复 key、自定义 tag 和 alias，带 alias 的文件需先展开。结构深度最多 32，遍历节点最多 200,000；源文件最大 2 MiB，代理节点最多 2,000。错误包含字段路径及可取得的行号，不返回敏感原文。

URL 下载直连宿主网络，限 15 秒、最多 3 次重定向；仅允许 HTTP(S) 公网地址，校验全部 DNS 结果并固定连接 IP，保留 Host / SNI。每次重定向重新校验，HTTPS 不允许降级；压缩前后分别限 2 MiB。HTTP 错误、截断、解压失败或取消均不提交配置。

## 配置和运行状态

### 存储模型

持久化模型在 [src/config/model.ts](../src/config/model.ts)，磁盘格式为 `schemaVersion=3`：

| 范围     | 字段与含义                                                                        |
| -------- | --------------------------------------------------------------------------------- |
| 全局     | `revision`、`socks`、`logLevel`、`activeProfileId`、`profiles`。                  |
| 每份配置 | `id`、`name`、`nodes`、`selection`、`dns`、`hosts`，URL 配置另含 `subscription`。 |
| 节点选择 | `mode` 为 `manual` 或 `auto`；`target` 为节点、直连或拒绝。                       |
| 订阅     | `url`、`intervalHours`、`lastUpdatedAt`。                                         |

最多保存 100 份配置。新配置默认自动模式，无节点时直连；删除选中节点后使用剩余首个节点，无节点时直连，自动模式在节点变动后重测。删除当前配置时切换到剩余首份；删除最后一份时创建空白默认配置，全局设置保留。

旧版 `schemaVersion=1/2` 自动迁移，保留节点、DNS、hosts 和末尾出口，丢弃分流规则；下次保存写入新版格式。内部运行时 `Config` 仍使用版本 1 模型和单条 `MATCH`，与磁盘设置格式不同。

配置写入串行执行并检查全局 `revision`，成功提交后递增。文件保存使用同目录随机临时文件、`fsync` 和 `rename`；目录权限 `0700`，新文件 `0600`。重启以已提交文件为准，忽略临时文件；直接启动应用保持代理停止，本机后台脚本在管理服务就绪后通过 API 开启代理。节点凭据和订阅地址在本机明文保存。

### 应用与连接生命周期

状态为 `stopped`、`starting`、`running`、`applying`、`stopping`、`error`。`running` 表示 SOCKS5 listener 可接入，不保证节点或目标可达。端口占用时报错，不自动更换端口。

每个连接从 TCP 接入时起固定节点、路由、DNS / hosts 和认证快照，整个握手与转发沿用该快照。

| 操作                                         | 运行行为与失败处理                                                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 节点、配置或当前配置内容切换，监听与认证未变 | 先校验并编译，再原子保存，最后发布新 Router；新连接使用新配置，已有连接继续使用旧快照。保存期间仍接入旧出口，保存失败保留原状态。 |
| 修改监听地址、端口或认证                     | 关闭旧接入和连接，绑定候选监听，保存后开放接入；绑定或保存失败尝试恢复旧监听，恢复失败进入 `error`。                              |
| 仅修改周期或非当前配置                       | 原子保存，不重启监听或中断当前连接。                                                                                              |
| 显式停止                                     | 取消测速，关闭所有快照的连接，等待 close 回调及解析器清理；不自动重启。                                                           |

旧快照在最后一个连接关闭后释放解析器；无连接时立即释放。所有快照共享连接限制和状态计数。正常退出清理定时器、下载、DNS、拨号和监听，退出期限为 5 秒。

代理出站在底层连接建立、请求头写入后回复 SOCKS 成功，后续认证或网络失败关闭连接；DIRECT 等待目标 TCP 建立。单次连接失败不会尝试其他出口或回退直连。

### URL 配置更新

URL 配置默认每 4 小时更新，可为每份配置设置 0.25–8760 小时周期。应用启动时及每分钟检查到期任务，所有 URL 配置均参与；后台逐份处理，同一配置的刷新共享任务。

更新沿用导入的下载和校验边界，在写入队列中合并最新设置。成功后替换节点、DNS 和 hosts，保留配置名称、ID、周期和选择方式；按节点名称及类型复用节点 ID，尽量保留手动出口。当前自动配置重新测速，非当前配置在激活时测速。

失败不提交内容，记录脱敏错误并按周期重试。尝试时间与错误只保存在内存，重启从上次成功时间恢复调度。编辑 URL 时重置成功时间、取消旧下载，保存动作本身不访问新地址，新内容在下次调度或立即更新时获取。早期未保存地址的配置需重新导入才能启用更新。

回写前检查配置是否存在、源地址和取消信号，避免旧任务覆盖新地址；清理时检查任务身份。删除配置会取消其下载和测速，晚到结果无法恢复已删除数据。文件和空白配置不自动更新。

## 本机后台启动脚本

[scripts/hihop.mjs](../scripts/hihop.mjs) 提供 `start`、`stop`、`restart`、`status`，通过 `mise run install:launcher` 安装到 `~/.local/bin/hihop`。命令包装固定的 Node 可执行文件和仓库路径，从任意工作目录调用均可。

后台命令使用 `~/.hihop/` 保存配置和 token，`logs/` 保存 stdout / stderr，`run/` 保存 PID、随机实例标记、端口和控制锁；`HIHOP_HOME` 可覆盖根目录。安装会从原数据目录复制配置和 token，保留源文件且不覆盖已存在的目标文件。直接运行服务端仍遵循 `HIHOP_DATA_DIR` / `./data` 规则。

启动采用 detached 子进程及独立日志文件。服务端在完成监听和退出处理注册后，通过 IPC 向父命令报告就绪；只有收到当前子进程的就绪通知后，脚本才调用带 token 的 `/api/service/start`，避免管理端口占用时误操作其他服务。代理启动失败会清理本次创建的进程及运行记录；已运行实例的失败请求保留原进程。

启停命令使用控制锁防止并发，遗留锁按所属进程存活情况清理。停止前核对 PID 对应的 Node 路径、服务端路径和随机实例标记，避免 PID 复用导致误杀；优先 SIGTERM，等待最多 8 秒后仍未退出才使用 SIGKILL。`status` 同时查询实际代理状态；未运行时退出码为 1。

日志文件权限为 `0600`，每次启动时达到 10 MiB 则轮换，保留一份 `.1` 备份；运行期间不自动轮换。启动脚本不配置开机自启，也不修改系统代理设置。

## 节点探测

实现位于 [src/proxy/probe.ts](../src/proxy/probe.ts) 和 [src/config/manager.ts](../src/config/manager.ts)。经每个节点请求 `https://www.gstatic.com/generate_204`，验证证书，接受 HTTP 200 / 204。延迟包含 DNS、传输、代理握手、TLS 与响应首行。

| 参数       | 行为                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| 并发       | 最多 16 个 worker。                                                                                   |
| 单节点超时 | `PROBE_TIMEOUT_MS=4000`，与失败样本计分共用常量。                                                     |
| 每轮期限   | 全量测量最多 12 秒，未完成节点记为超时。                                                              |
| 手动模式   | 执行 1 轮，只记录延迟，不更换出口。                                                                   |
| 自动模式   | 连续执行 5 轮，最多约 60 秒；失败样本代入 4,000 ms，排序后去掉两端值，以剩余 3 次未取整均值选择节点。 |
| 全部失败   | 仍以 4,000 ms 均值参与选择；选中不代表可用。任务本身异常时保留原出口。                                |

切换配置先提交已保存出口，再在写入队列外探测；启用自动模式和手动点击「测速」同样启动后台任务。自动模式下导入、启动代理和修改节点会探测，相关请求可能等待测量完成；URL 导入还需下载，因此管理请求超时设为 90 秒。

管理应用每分钟检查当前自动配置，距离上次探测开始满一小时后重测；任务不重入，成功和失败尝试均重新计时。调度不依赖浏览器，也不以 SOCKS5 是否运行作为条件。周期状态和延迟仅保存在内存；应用重启后若未触发即时测速，首次定时探测在一小时后执行。

结果回写前检查任务身份、当前配置 ID 和节点 / DNS / hosts / 选择指纹。切换配置、手动选择、内容变更、停止或删除使旧任务失效。自动出口提交会同步任务指纹，避免将自身更新判为取消。

API 在 `selection` 中返回 `latencies`、`probing`、`probeError`、`probeVersion`、`probeCompletedVersion`。自动结果包含原始顺序的 `samples`（失败为 `null`）和 `sampleTimeoutMs`；前端按返回值说明计分。完成版本仅在任务结束时推进，取消不推进，页面据此去重完成提示，全失败节点仍计入失败数量。

页面在请求发出时禁用测速按钮，出口提交完成后恢复。轮询只替换节点列表，保留其他表单及弹窗草稿。延迟绿色为 ≤200 ms，橙色为 >200 且 ≤500 ms，红色为 >500 ms 或不可用，未测速显示中性破折号。

## DNS 解析

实现位于 [src/dns/resolver.ts](../src/dns/resolver.ts)。hosts 由 `useHosts` 控制，并优先于系统或自定义 DNS。关闭 `dns.enable` 时使用宿主解析器；开启时只访问指定上游，不隐式回退系统或公共 DNS。

| Clash 字段                | 内部字段                 | 用途                                                                                 |
| ------------------------- | ------------------------ | ------------------------------------------------------------------------------------ |
| `default-nameserver`      | `bootstrap`              | 解析 DNS 上游自身域名，端点必须使用 IP。                                             |
| `nameserver`              | `nameservers`            | 普通域名默认上游。                                                                   |
| `nameserver-policy`       | `policy`                 | 精确域名优先，其次最长 `+.` 后缀；后缀也匹配域名本身。                               |
| `proxy-server-nameserver` | `proxyServerNameservers` | 只解析代理节点服务器域名，供连接和测速使用；空列表沿用普通策略。旧数据缺省为空列表。 |

导入端点支持裸 IP（UDP/53）、`tcp://`（默认 53）和 `tls://`（默认 853）；TCP / TLS 可使用域名和自定义端口。每类上游列表最多 16 个。

自定义解析按 A、AAAA 顺序查询，从有效响应选择首个地址；系统解析同样优先 IPv4。单次解析限 10 秒，DNS 错误终止当前请求。CNAME 检测循环，追踪深度最多 8；缓存最多 2,048 项，TTL 上限一小时，零 TTL 不缓存，NXDOMAIN 负缓存 30 秒。每个解析器最多同时交换 64 个请求，超出后排队并支持等待取消。

配置更新为新连接创建新解析器；旧连接使用原解析器及缓存，直至对应快照释放。代理目标域名可留给远端解析，节点服务器域名则通过本机解析器得到拨号地址。

## 管理 API

路由与请求体以 [src/api/app.ts](../src/api/app.ts) 为准。Web 始终只绑定 `127.0.0.1`；API 使用 `Authorization: Bearer <token>`，校验 Host / Origin，不开放跨域。页面和静态资源无需 token。非回环 SOCKS5 监听必须启用用户名/密码认证。

除立即刷新和服务启停外，下面的写接口均需携带当前 `revision`。冲突返回 409；字段或语法错误返回 400，大小超限返回 413，并发超限返回 429，其他失败返回脱敏业务错误码和消息。

| 方法与路径                                          | 请求体 / 用途                                                                       |
| --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /api/config`                                   | 当前脱敏配置、选择状态、配置列表、`revision` 和 `editRevision`。                    |
| `GET /api/status`                                   | 实际状态、当前配置 ID、监听、连接数、错误与探测版本。                               |
| `POST /api/imports/file`                            | `{revision, content, name?}`，`content` 为 YAML 文本，直接新增并激活。              |
| `POST /api/imports/url`                             | `{revision, url, name?, intervalHours?}`，下载、导入并保存订阅；默认 4 小时。       |
| `GET /api/profiles`                                 | 当前配置 ID、列表、节点数量、订阅状态和全局版本。                                   |
| `POST /api/profiles`                                | `{revision, name}`，创建空白配置并切换。                                            |
| `POST /api/profiles/:id/activate`                   | `{revision}`，激活已有配置。                                                        |
| `PATCH /api/profiles/:id/subscription`              | `{revision, url?, intervalHours?}`，至少提交 URL 或周期之一。                       |
| `DELETE /api/profiles/:id`                          | `{revision}`，删除配置并按需切换或创建空白默认配置。                                |
| `POST /api/profiles/:id/refresh`                    | 立即更新指定 URL 配置，合并最新版本，无需 revision。                                |
| `GET /api/nodes`                                    | 当前配置的脱敏节点与版本。                                                          |
| `POST /api/nodes`                                   | `{revision, node}`，新增节点，由后端分配 ID。                                       |
| `PATCH /api/nodes/:id`                              | `{revision, node}`，编辑节点，不可修改 ID；未提交凭据时保留原值。                   |
| `DELETE /api/nodes/:id`                             | `{revision}`，删除节点。                                                            |
| `PUT /api/selection`                                | `{revision, selection:{mode,target}}`，保存选择；自动模式在后台测速。               |
| `POST /api/probes`                                  | `{revision}`，启动后台测速并立即返回探测状态。                                      |
| `GET /api/dns`                                      | 当前 DNS、hosts 和版本。                                                            |
| `PUT /api/dns`                                      | `{revision, dns, hosts}`，整体更新当前配置的 DNS 和 hosts。                         |
| `GET /api/settings`                                 | 全局监听、脱敏认证、日志和版本。                                                    |
| `PATCH /api/settings`                               | `{revision, socks?, logLevel?}`；认证密码留空表示保留，`socks.auth=null` 关闭认证。 |
| `POST /api/service/start`、`POST /api/service/stop` | 幂等启停，无需 revision。                                                           |

`target` 为 `{kind:'node',id}`、`{kind:'direct'}` 或 `{kind:'reject'}`。配置响应不包含 `rules`、节点密码或 UUID；凭据使用 `hasPassword` / `hasUuid` 标记，VMess 另返回有效 cipher 和认证类型。

`editRevision` 在真实配置提交时推进，后台仅更新出口时保持不变。前端仅在可编辑内容及自动模式均未改变时，对后台出口变化造成的冲突重试一次；其他冲突需载入最新配置。订阅 URL 会返回给已授权管理员，日志和错误不包含下载 URL 查询凭据。

## 协议细节与资源限制

SS 遵循 AEAD TCP 线格式，使用 EVP_BytesToKey(MD5)、HKDF-SHA1、独立认证的长度块和载荷块，以及 little-endian nonce。

VMess `auto` 固定使用 AES-128-GCM，数据加密与 AEAD / legacy 认证独立。UUID、alter ID 派生、KDF、认证 ID、头部、响应及 nonce 参考 V2Fly v4.31.3，固定 commit `6f2907e3758e177ceb42aac94e6127571ded3999`。非零 alterId 选择第一个合法 alter ID，独立互通实际覆盖 `alterId=1`。选项为 S=1；长度掩码、全局 padding、长度认证实验及复用关闭，请求头随机 padding 长度为 0。

TLS 验证信任链和 servername；TLS SNI 与 WS Host 分别处理。WS 保留 path 和查询串，拒绝升级重定向及文本消息，消息边界不作为 VMess 帧边界。SS / VMess 解码流使用字节模式，以支持在其上建立 TLS。

VMess 客户端发送结束帧后保持传输可读；响应接受认证结束帧或完整帧边界的传输 EOF，半帧 EOF 报错。WS 不具备 TCP 半关闭能力。固定 V2Ray 参考端不会向最终目标传播 FIN，因此需要目标先收到 EOF 才响应的业务不在已验证范围内。

| 资源             | 限制                                                    |
| ---------------- | ------------------------------------------------------- |
| SOCKS5 并发连接  | 所有配置快照合计 512。                                  |
| 管理请求         | 同时最多 32 个。                                        |
| 手动导入         | 同时最多 1 个；后台订阅更新串行，同配置刷新去重。       |
| 网络超时         | 拨号 / 升级 10 秒，握手读取 15 秒，流空闲 120 秒。      |
| 字节缓冲         | ByteReader 最多 2 MiB。                                 |
| 帧大小           | SS 载荷最多 16,383 字节，VMess 密文帧最多 16,384 字节。 |
| VMess 计数器     | 每方向在 65,536 帧前终止，防止 nonce 复用。             |
| SS salt 重放缓存 | 10 分钟 / 10,000 项；满时拒绝新会话，不淘汰仍有效记录。 |

## 验证范围与来源

测试按用途分层，运行命令见 [README](../README.md#开发与验证)。这里记录覆盖范围，不把历史测试数量当作当前验证结果。

| 测试位置                                                                      | 覆盖内容                                                                                                                         |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [tests/unit](../tests/unit/)                                                  | 导入与规则忽略、多配置与迁移、脱敏与版本、订阅调度和取消、测速计分及过期结果隔离、DNS、下载边界、传输、SOCKS5 和 Web DOM。       |
| [tests/unit/smooth-switch.test.ts](../tests/unit/smooth-switch.test.ts)       | 真实 SOCKS5 / SS 连接验证新旧出口隔离、握手快照、保存期间接入、保存失败与旧 Router 清理。                                        |
| [tests/vectors](../tests/vectors/)                                            | 标准加密向量及跨语言生成的 VMess AEAD / legacy 固定向量。                                                                        |
| [tests/integration/protocols.test.ts](../tests/integration/protocols.test.ts) | 固定 V2Ray 4.31.3 服务端，SS 三种算法及 VMess AEAD / legacy × TCP / TLS / WS / WSS，共 11 种组合，含客户端结束写入后的延迟响应。 |
| [tests/unit/launcher.test.ts](../tests/unit/launcher.test.ts)                 | 后台命令安装、配置复制与权限、脱离终端、幂等启动、重启、日志轮换、PID / 锁隔离、端口冲突和启动失败清理。                         |
| [scripts/linux-check.sh](../scripts/linux-check.sh)                           | 一次性 Linux amd64 容器中安装固定工具链、安装依赖并执行 check。                                                                  |

基础测试使用受控时间、结果及本机服务，不修改实际用户配置，不访问公网节点。Web DOM 测试运行生产前端代码，覆盖导入、编辑、删除、地址恢复、测速轮询和草稿保留；它不能代替浏览器视觉检查。基础测试通过也不能替代独立 Docker 互通或长期资源压力验证。

协议依据为 SOCKS5 [RFC 1928](https://www.rfc-editor.org/rfc/rfc1928) / [RFC 1929](https://www.rfc-editor.org/rfc/rfc1929)、[Shadowsocks AEAD TCP 规范](https://shadowsocks.org/doc/aead.html)和上述固定 [V2Fly 源码](https://github.com/v2fly/v2ray-core/tree/6f2907e3758e177ceb42aac94e6127571ded3999/proxy/vmess)。参考许可证、公开测试证书及 VMess 向量生成命令统一保存在[测试夹具说明](../tests/fixtures/README.md)。
