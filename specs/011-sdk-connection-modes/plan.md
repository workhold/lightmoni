# Implementation Plan: SDK 连接模式与凭据边界

Branch: 011-sdk-connection-modes  | Date: 2026-10-18  | Status: Connection-mode baseline implemented; verification remains | Spec: [spec.md](spec.md)

## Summary

在六种保留语言的现有 OTLP SDK 上增加统一连接配置解析层已完成基线实现。agent 只发本机 Agent，direct 只发中心，auto 仅在进程启动时探测受控本机地址并在首个业务批次前做一次直连回退。data key 由管理员/Secret Manager 注入；Agent 的 enrollment、control credential 和 data credential 留在 Agent 控制面。自定义 metrics、logs、traces API 复用现有聚合、table、W3C trace 和批次契约，不让连接层改变业务数据语义；跨语言 fixture、真实工具链和泄露审计仍待完成。

Java 与 C# 原生包退出发布矩阵。删除前完成迁移说明、OTLP 兼容测试和中心文档清理；外部 OpenTelemetry exporter 仍可接入中心。

## Technical context

- **保留语言**：Go、TypeScript/JavaScript（Node 与浏览器安全子集）、Python、PHP、Ruby、Rust。
- **传输**：现有 OTLP/HTTP /v1/metrics、/v1/logs、/v1/traces，保留 batch headers、table authorization 和有限重试。
- **凭据**：直连使用 table-scoped data key；Agent 使用自身 control/data credential；SDK 到 Agent 使用 local token；enrollment token 只给安装脚本。
- **配置来源**：显式选项 → *_FILE secret 文件 → 环境变量；冲突拒绝；不会把秘密写日志或磁盘。
- **发现范围**：显式 Agent endpoint 和默认 127.0.0.1:4318；不做端口扫描、mDNS、云元数据或任意远程探测。
- **默认路由**：发行模板必须显式选择 mode；auto 只做启动选择，未知请求结果不跨路径静默重发。
- **浏览器**：不得持有中心长期 data key；只允许同源/受限 relay、短期 token 或明确 Agent 入口。

## Constitution check

- **SDD 先行**：本计划、契约、任务和验证文档先于实现。
- **权限最小化**：控制、数据、local、enrollment 四类凭据不复用；SDK 不调用管理员 API。
- **兼容性**：维持现有 OTLP、table 和批次语义；LIGHTMONI_KEY 只作迁移别名。
- **可解释性**：route、fallback、credential source 只报告类别，不报告秘密。
- **发布范围**：Java/C# 的移除影响原生包和文档，不影响中心接收与历史数据。

## Workstreams

### A. Shared configuration and credential loader

建立跨语言字段表、验证规则、来源优先级和脱敏错误码。每个 SDK 提供语言惯用的 from_env/fromEnv，同时保留显式配置。secret 文件读取限制为常规单值文件并支持容器 Secret；实现不把环境变量重新持久化。

### B. Route selector

为 Agent health probe、direct preflight 和 auto startup selection 建立相同状态机。区分连接未建立、body 未发送、body 已发送、响应未知、鉴权拒绝和永久协议错误；只有前两个安全状态允许 startup fallback。选定 route 后批次 ID 和 payload 不变。

### C. Agent/center transport adapters

复用现有 transport、OTLP 编码、table header、batch ID 和重试。Agent adapter 只附加 local token；direct adapter 只附加 data key。任何请求都不携带 enrollment/control/data credential 的错误字段。

### D. Custom instrumentation parity

为六种语言补齐自定义 metric/log/trace/table API 的连接构造和生命周期示例；检查 attributes、overflow、buffer、flush/shutdown、W3C trace 和 SDK self telemetry 不受 route 改变。不要在业务记录调用同步执行网络探测。

### E. Language and release cleanup

更新 SDK 总览、生成器、examples、CI、发布脚本和容器 smoke test 的语言矩阵；移除 Java、C# 包构建和原生导航，保留 OTLP 迁移说明与中心兼容测试。删除前确认没有中心或 Agent 对 Java/C# 的硬编码路由。

### F. Verification and migration evidence

用隔离的本地 Agent 和中心分别验证三种模式、token scope、route fallback 和批次重复边界；运行六语言 smoke test 和 Go race/TypeScript/Python 单测。记录没有凭据泄露、未知响应不改投、Java/C# 退出发布矩阵以及历史数据可查询的证据。

## Rollout and compatibility

1. 先发布共享契约和六语言配置解析，旧 endpoint/key 显式构造保持兼容。
2. 增加 mode=agent/direct/auto 和 stats 诊断；auto 默认只在新配置显式启用。
3. Agent enrollment/control/data credential 完成后，切换 Agent adapter 到节点 data credential；旧 config.key 只留迁移路径。
4. 更新文档与生成器，标记 Java/C# 进入迁移窗口；一次发布后停止新包，下一次清理源码和 CI。
5. 迁移窗口结束后删除 Java/C# 原生包，保留明确的标准 OTLP 文档和中心接收回归。

## Risks and mitigations

| 风险 | 缓解 |
| --- | --- |
| auto 在 Agent 已持久化但响应丢失时重复直连 | 只在首个 body 前回退；未知结果设置 route_uncertain，不静默改投 |
| 环境变量泄露到进程/诊断 | 推荐 *_FILE/Secret Manager；统一脱敏和 source-only stats |
| 旧 LIGHTMONI_KEY 被误作控制凭据 | 明确只映射 data key；Agent 控制路径迁移另由 010 规格完成 |
| Java/C# 删除影响存量使用方 | 先提供标准 OTLP 迁移说明和中心兼容测试，再删原生包 |
| 浏览器 bundle 暴露 data key | 浏览器禁止长期中心 key；relay/短期 token/同源 Agent 限制 |

## Remaining out of scope / follow-up

Agent enrollment API、节点控制/数据凭据签发、远程执行、自动升级、任意远程发现以及 Java/C# 的替代原生 SDK 仍不属于本 SDK 规格；enrollment/control/data credential 由 010 规格负责。当前 SDK 基线实现不改变这些控制面边界。
