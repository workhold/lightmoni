# Tasks: SDK 连接模式与凭据边界

**Input**: [spec.md](spec.md), [plan.md](plan.md), [contracts.md](contracts.md)
**Status**: Connection-mode baseline implemented; cross-language and release verification remain。

## Phase 1: SDD foundation

- [x] T001 冻结 agent/direct/auto、凭据分类、环境变量、发现边界和 auto 回退规则。
- [x] T002 冻结本次 TypeScript/JavaScript、Python、Ruby 发布矩阵；Java/C#/PHP 下线，Go/Rust 仅保留源码、后续验收。
- [x] T003 冻结自定义 metrics/logs/traces/table/W3C trace 的跨语言最低语义和批次不确定边界。
- [x] T004 由维护者审阅与 010 Agent enrollment/control/data credential 契约的交叉引用并记录决策。

## Phase 2: Shared contract and test fixtures

- [ ] T005 为当前发布的三种语言定义共享配置 fixture：三种 mode、endpoint、table、secret source、local token、超时和冲突来源。
- [ ] T006 定义统一错误码和脱敏 stats fixture：credential_source_conflict、auto_route_unavailable、route_uncertain、agent_auth_failed、direct_auth_failed。
- [ ] T007 增加 secret 文件测试：常规文件、0600 警告、CRLF、空值、过长值、目录/FIFO/不可读文件和冲突来源。
- [ ] T008 增加路由故障注入 fixture：连接拒绝、超时、TLS 错误、401/403、协议错误、body 已发送后丢响应。

## Phase 3: SDK configuration and transport

- [x] T009 [P] [Go，后续支持，未纳本次发布验收] 历史基线实现 Config/ NewFromEnv、来源优先级、Agent adapter、direct adapter 和 auto 启动选择；保留旧显式 endpoint/key。
- [x] T010 [P] [TypeScript] 实现 Node createLightMoniFromEnv、浏览器安全子集和 route stats；禁止 bundle 长期中心 key。
- [x] T011 [P] [Python] 实现 Client.from_env、secret file loader、三种 mode 和 route diagnostics，复用既有 remote config 生命周期。
- [x] T012 [历史 PHP 实现] 原连接模式基线曾完成；PHP SDK 已决定下线，不再作为当前交付能力。
- [x] T013 [P] [Ruby] 实现 LightMoni.from_env、Fiber 作用域兼容和三种 mode。
- [x] T014 [P] [Rust，后续支持，未纳本次发布验收] 历史基线实现 Client::from_env、Config 校验、异步/阻塞发送边界和三种 mode。
- [ ] T015 统一当前发布的三种 SDK 的 route 选择、批次 ID、重试、未知响应和 route_uncertain 语义；禁止已发送 body 的静默跨路径回退。

## Phase 4: Custom instrumentation parity

- [ ] T016 [P] 为 TypeScript、Python、Ruby 增加自定义 Counter/Gauge/Histogram、结构化日志、Span/Trace、W3C header 和 table scope 示例。
- [ ] T017 [P] 验证属性类型/大小/基数、overflow、invalid、有限缓冲、flush/shutdown 和自监控统计在三种 route 下相同。
- [ ] T018 以同一 OTLP fixture 对比 Agent 与 direct 的 payload、table、resource、trace/span 和 batch headers。
- [ ] T019 验证 SDK 业务记录路径不触网；auto 探测只在初始化/显式 route refresh 边界发生。

## Phase 5: Java/C# removal and migration

- [x] T020 更新 sdk 总览、生成器、示例、文档、CI、release manifest 和容器 smoke test，历史阶段仅移除 Java/C#；本次发布范围以 T029–T031 为准。
- [x] T021 为 Java/Kotlin 和 C#/.NET 保留标准 OpenTelemetry OTLP 迁移边界、table header/data key 配置和中心兼容入口说明。
- [x] T022 停止发布 Java/C# 新包，删除原生包构建和导航；确认中心/Agent 不存在语言硬编码。
- [x] T023 检查仓库与发布产物中不再包含 Java/C# 的“原生支持”承诺；删除操作不影响历史数据、中心接收或外部 OTLP exporter。

## Phase 6: Verification and rollout

- [ ] T024 运行当前三语言 direct 集成测试：合法 table、越权 table、401/403、429/5xx、断网和 key rotation。
- [ ] T025 运行当前三语言 agent 集成测试：local token、Agent durable ACK、断网补传、Agent 控制/数据凭据不泄露给 SDK。
- [ ] T026 运行 auto 测试：Agent 成功、未监听回退、探测鉴权错误不回退、body 已发送丢响应不回退、缺 direct 凭据失败。
- [ ] T027 做凭据泄露审计：argv、环境诊断、日志、trace attributes、URL、异常、批次 payload、容器层和浏览器 bundle。
- [x] T028 更新 specs/011-sdk-connection-modes/validation.md，记录命令、fixture、结果、已知限制和 Java/C# 迁移证据。

## Dependencies

T001–T008 必须先于实现；T009–T014 可按语言并行，但 T015 的共享错误/route 语义先冻结。T016–T019 依赖每种 SDK 的配置构造完成。T020–T023 与 transport 实现并行，但发布清单必须在 T028 前更新。T024–T027 通过后才能把规格标为 implemented。

## 本次发布范围调整（2026-10-19）

- [x] T029 下线 PHP SDK 源码、示例、发布包与接入页安装引导；保留历史测试证据。
- [x] T030 Go/Rust 保留源码并标注后续支持，从发布包和接入页安装选项移除，不纳本次发布验收。
- [x] T031 当前发布矩阵统一为 TypeScript/JavaScript、Python、Ruby，验证三语言发布产物和安装入口一致。
- [ ] T032 [后续] 补齐 Go/Rust 原生工具链、三种模式与故障矩阵验收后，再单独决定是否恢复发布。
