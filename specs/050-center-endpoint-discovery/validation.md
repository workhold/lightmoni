# SDD 050 验收

验收日期：2026-10-31；分支 `codex/050-center-endpoint-discovery`。提交前已同步 GitHub `origin/main`，基线为 `57e770d2039b03e7f34cc88644f0ebf574ec8a75`。

## 最终行为

- 管理员在既有上报地址页登记完整内网 IP、端口 URL 与公网入口，区分 internal/public；旧记录缺省 public，默认接入引导为公网。管理员修改地址后，客户端周期同步或显式刷新，无需重新部署应用。
- 四种发布 SDK（Go、Node/浏览器、Python、Rust）与 Agent 使用相同发现契约；配置和上报共用选择。Agent 心跳、配置、job/task 轮询、operations 和制品下载统一选路，内网可用时均使用内网。现有 Agent 是 HTTP 轮询，没有另加 WebSocket 协议。
- 内网传输失败或超时影响下次请求；失败写请求不会在同次调用内改投。重试保留原批次 ID、创建时间和正文。新修订重新选择内网；全部已知入口失效时需要修复引导配置。
- 候选身份检查不带凭据，身份不符、跳转不转发凭据；正常校验 TLS。历史中心不支持发现时保留显式地址直报。
- 删除 Agent 公开 SDK OTLP 接收与配置代理、SDK 隐式本机 4318 默认值、页面/脚本/示例的 Agent 接入配置。AI 插桩仅生成中心直连，检测历史 Agent 配置时提示迁移。Agent 自身进程内采集和持久队列保留。
- Nginx 同集群内网反代沿用既有实现，无公网备用后端。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| `npm --prefix runtime test`（串行完整套件） | 649 项：628 通过，21 环境跳过，0 失败 |
| `npm --prefix sdk/typescript test` | 22/22 通过 |
| `cd sdk/go && go test -race ./...` | 通过，含原生中心协议互通 |
| `cd sdk/python && python3 -m unittest discover -s tests` | 33/33 通过 |
| Rust 容器 `cargo test --locked --offline` | 4/4 通过，doc-tests 通过 |
| `node --test web/src/app/sdkExamples.test.mjs` | 4/4 通过 |
| Agent 工具死代码删除后的 Agent/center-endpoints 定向回归 | 13/13 通过 |
| SDK/Runtime/Web 构建，Runtime/Web 类型检查 | 通过；Web 保留已有依赖的模块指令提示 |
| 两个 Python 验收脚本 `py_compile` | 通过 |
| `node web/src/app/verify-reporting-addresses.mjs` | 通过，页面运行错误 0 |
| `git diff --check` | 通过 |

HTTP 验收真实启动监听端口，覆盖内网首选、端口失效、公网恢复、新内网端口、不同中心身份、无凭据探测、重定向、超时/取消和批次重试。中心使用真实 Router/Auth/SQLite，验证 SDK、Agent control/data 凭据边界、匿名豁免规则、修订变更。Agent 旧 SDK 路由返回 404，自身采集、队列及独立生命周期回归通过。

UI 使用当前生产 Web bundle 与隔离的真实设置/Auth/SQLite 服务，ClickHouse 为测试替身；验证地址用途、保存刷新、IP/端口更新、失败保留输入、公网接入引导及普通成员写入 403。中文 1440/390、英文 1440 截图已目视检查；窄屏无横向溢出。结构化结果见 [ui-report.json](evidence/ui-report.json)。本地截图保存在忽略目录 `artifacts/screenshots/specs/050-center-endpoint-discovery/`。

## 架构同步和验收边界

架构影响适用：新增中心入口发现协议、改变 SDK/Agent 控制与数据选路、删除业务 SDK→Agent 路径，收紧 AI 接入生成范围。仓库与 Doca 已在同一 SDD 同步，见 [doca-sync.md](doca-sync.md) 及 [doca-readback.json](doca-readback.json)。

测试使用隔离 HTTP、SQLite 与真实多语言客户端，不等同真实公网/VPC、生产 TLS 证书或大规模网络验收。浏览器使用同一 TypeScript 选择器；未验证跨域/混合内容/私网访问策略下的浏览器网络部署。未部署生产中心、Agent 或发布镜像。旧 SDK→Agent 用户须迁移到中心地址与 SDK Key；升级新 SDK 时必须显式设置中心 endpoint。
