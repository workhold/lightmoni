# Feature Specification: 主机管理与 Agent 引导部署

**Feature Branch**: `feat/managed-machines-agent-bootstrap`
**Status**: Implemented on `feat/managed-machines-agent-bootstrap`; awaiting review

## 背景

LightMoni 当前通过用户在目标主机执行一次性 enrollment 脚本接入 Agent。需要增加受管主机登记与可审阅的引导部署能力，降低首次接入成本，同时保持 SSH 只作为首次接入/应急通道。Agent 激活后，平台应优先通过 Agent 的控制接口管理节点，不能让 AI 长期持有 SSH 密钥或密码。

## 用户故事

### US1 登记受管主机（P1）

管理员可以登记主机名称、地址、端口、登录用户名、连接方式和主机公钥指纹，明确区分平台 `machine_id`、操作系统登录用户名和 LightMoni `agent_id`。成员不能读取凭据秘密。

### US2 管理连接凭据（P1）

管理员可以为每台主机保存 SSH 私钥、一次性密码或手动脚本方式的连接凭据。秘密只在提交时接收，服务端加密保存，接口和页面永远不回显；密码默认短期有效并明确提示“建议只使用一次，不要长期保存”。每台主机凭据独立，可撤销、替换和查看使用时间。

### US3 生成并审阅 Agent 部署计划（P1）

管理员可以为主机选择 Agent 版本、架构和初始任务标签，生成固定步骤的部署计划。AI 助手只能读取主机元数据并生成计划，不能看到秘密、主机输出或直接执行任意 SSH 命令。部署计划必须由管理员在页面明确确认。

### US4 通过受限 SSH 引导部署（P1）

确认后，后端部署 worker 只使用凭据 ID 租约和固定安装模板：校验主机指纹、检查 SSH 可达性、下载并校验固定版本 Agent、通过 stdin 注入一次性 enrollment token、启动独立 Agent 并等待回执。密码凭据不用于自动部署；使用密码的主机应改为一次性手动脚本或先配置 SSH 密钥。

### US5 Agent 接管与救援（P1）

Agent 激活后，主机记录绑定 `agent_id` 并显示已切换 Agent 通道。日常状态、配置、诊断和后续受控操作经 Agent API 完成；SSH 凭据可以撤销。Agent 离线或重新 enrollment 时，管理员可以再次发起受审计的 SSH 救援流程。

## 规则与边界

- 主机地址只接受主机名/IP，不接受 URL、用户信息、命令或控制字符；禁止云元数据地址和不明确的跳转。
- 连接必须 pin 主机公钥；首次指纹和指纹变化都必须管理员明确确认，禁止关闭 host key 校验。
- 模型不接触私钥、密码、主机指纹、完整 SSH 输出或 enrollment token；工具只返回结构化状态和计划。
- 不提供通用 `ssh_exec(command)`。安装步骤由后端固定模板和白名单参数构造，部署 worker 有超时、取消、单机锁、幂等和脱敏审计。
- `control_credential`、`data_credential` 和 SDK `local_token` 不获得远程执行权限；未来 Agent Executor 另行设计，默认关闭。
- 中心无法访问私网主机时，提供手动脚本/SSM/Ansible/Relay 连接方式，不要求用户开放入站 SSH。

## 验收标准

- 主机、凭据和部署历史均按租户/管理员权限隔离，响应不包含秘密或可恢复的密文。
- 密码凭据默认有短 TTL，创建和使用界面展示不长期保存建议；撤销后不能用于部署。
- AI 工具只能列出主机、查看状态、生成部署计划和读取脱敏部署回执；应用必须经过管理员确认。
- 部署模板不把 token 放进 URL、argv、环境变量、模型消息或日志；失败回滚提案状态并保留脱敏错误。
- Agent 激活回执可绑定 `agent_id`，后续页面展示 Agent 通道状态；未激活主机仍可使用手动脚本方案。
