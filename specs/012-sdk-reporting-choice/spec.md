# Feature Specification: SDK 双路径上报与节点助手独立运行

**Date**: 2026-10-19
**Branch**: `feat/sdk-reporting-modes`
**Status**: Implemented; native-source regression checks recorded in [validation.md](validation.md), Go/Rust release remains deferred

## 用户需求

保留两种由用户明确选择的业务遥测路径：`SDK → LightMoni 平台`（direct）与 `SDK → LightMoni Agent → 平台`（agent）。安装节点助手不是 SDK 直连的前置条件；节点助手采集主机、目录日志、拨测和后续提供诊断工具的职责，与业务 SDK 的路由独立。

本次落实两种路径的接入体验、配置隔离与验证，不新增节点模型调用、远程脚本或 AI 工具。既有 `auto` 保持兼容，不作为本轮页面推荐路径，也不扩大自动回退行为。沿用 010 的节点凭据和 011 的 SDK 连接协议。

## 使用场景与验收

### US1 不安装 Agent，SDK 直接上报（P1）

- 接入页默认展示“直连平台”，配置平台基础地址与 table-scoped data key 后即可接入。
- 初始化、发送业务数据、获取 SDK 规则均不访问 Agent；无效的未选 Agent 地址、local token 或 local token 文件不阻止 direct 使用。
- 未获得平台成功确认的批次仅按原路重试，不自动发送到 Agent。

### US2 明确选择经 Agent 上报（P1）

- 页面保留“通过 LightMoni Agent”，配置可达的 Agent 基础地址；启用本地鉴权时注入 local token。
- 业务 SDK 不需要平台地址、data key、enrollment token、control credential 或 Agent data credential。
- 同机无鉴权 Agent 支持 localhost、IPv4 loopback 与 IPv6 loopback 地址；判断使用解析后的主机名，不把相似的远程域名误判为本机。
- 未选中心的 secret 文件或 data key 冲突不影响 agent 初始化；Agent 不可达/拒绝时明确失败，不自动改投平台。
- Agent 入队后返回的成功代表本地接收，不等同于平台已经入库；持久队列有容量与重放期限。

### US3 用户切换模式、语言或地址（P1）

- 模式切换保留两条路径各自输入的地址；更换语言不改变所选路径。
- 当前发布的 TypeScript/JavaScript、Python、Ruby 三种 SDK 的环境示例明确写出 `LIGHTMONI_MODE`，仅注入所选路径的凭据。
- Go 与 Rust 源码保留作后续支持，暂不进入本次发布包，接入页只展示后续支持状态；PHP SDK 从发布范围移除。
- 可直接执行的环境示例清理另一模式及当前模式遗留的 secret-file/legacy 别名配置，避免复制切换后出现来源冲突；不写出真实秘密。
- direct 不以运行形态限制使用；普通服务器、容器和 Serverless 均可直连。容器的 localhost 提示也适用于 Agent 地址。

## 功能要求

- **FR-001** 两种显式模式均为完整接入方式，默认 SDK 构造行为保持 direct，接入页与之统一。
- **FR-002** 显式 direct 只解析 data key 来源，显式 agent 只解析 local token 来源；所选凭据的冲突检查、文件校验和权限范围保持有效。
- **FR-003** 模式选择不修改 Counter/Gauge/Histogram、日志、Span/Trace、table、批次 ID、有限缓冲、重试和 shutdown 语义。
- **FR-004** 既有 auto 与旧 endpoint/key 构造 API 保持兼容；不将网络错误解释为切换模式的授权。
- **FR-005** 页面准确展示两条链路、所需凭据、缓冲差异和节点独立职责；不宣称中转已经合批、压缩、免配置或保证零丢失。
- **FR-006** 当前发布的每种 SDK 保留 direct/agent 环境构造与示例；不得恢复 Java/C# 或 PHP 原生包，Go/Rust 只能作为后续支持记录。
- **FR-007** 新增隔离配置与网络收据测试，证明请求实际到达所选接收端，使用相应凭据，并且失败不访问另一端。
- **FR-008** Python SDK 必须读取通过连接关闭界定长度的 HTTP 响应：接收端在成功响应中设置 `Connection: close` 且没有 `Content-Length` 时，仍按响应体确认批次；请求超时与响应大小限制继续有效。
- **FR-009** 带 Content-Length 或分块编码的响应必须完整读取后才可确认批次或更新规则；提前 EOF 视为传输失败，保留原批次及已生效规则。

## 非目标

- 不移除或重新设计 auto；不强制迁移已有部署。
- 不给 SDK 添加磁盘队列；不改变 Agent 的持久队列及凭据签发协议。
- 不新增 Agent 模型能力、工具调度、远程执行或自动修复。

## 完成标准

先提交本规格、设计、契约和任务，再实施。两条显式路径的 UI/示例与运行时测试通过，验证记录明确各语言实际工具链与未执行范围；最终通过功能分支 PR 交付，不自动合并。
