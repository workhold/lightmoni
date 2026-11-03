# SDD087 验收状态

日期：2026-11-03。当前记录取代此前独立 `lightmoni-task` 账号方案与未通过的旧 fixture 验收状态。

## 最终设计

- 只新增一个无登录普通系统账号 `lightmoni-agent`，承担常驻采集、心跳、平台通信与普通脚本。脚本与 daemon 共用 UID，可读取该账号可读凭据并修改可写状态；只用于受信任运维代码，不宣称同 UID 隔离或脚本沙箱。
- 已登记 SSH 账号只用于固定安装、升级、回退、模式切换、卸载与恢复。登记推荐 root，也支持实际检查通过的免交互系统管理 sudo 账号；当前要求 `sudo -n /bin/sh`。只读自动选择可尝试其他已登记账号，实际派发后不跨账号重放。
- 常驻 Agent 始终非 root、无通用 sudo、Docker socket 或 capabilities。完整管理模式安装同包同版本 root helper；仅监控不安装 helper、不领取普通自定义脚本。
- 普通脚本经签名 helper 通道领取，启动前固定为 Agent 的非零 UID/GID，清空附加组和 capabilities、启用 NoNewPrivileges。root 私钥、策略与恢复账本保持私有；高权限作业仍绑定内容、目标、实际身份与期限并单独批准、审计。
- Agent/helper 统一安装、升级、回退、模式切换、卸载与离线卸载。删除未发布 task 账号的创建、恢复、标记和清理契约，无旧身份兼容层。卸载保留系统账号及业务数据。
- 安装账号不合格时返回结构化原因，保留安装设置，提供添加账号、配置凭据、重新检查与审阅新计划的闭环。新增平台账户记录不会创建主机系统账户，也不自动安装；远端结果未知只读核对。

## 本轮验证

基线 `origin/main=b44ee39`；提交前已重新 fetch，落后主干 0。机器可读结果见 [single-account-validation.json](evidence/single-account-validation.json)。

| 检查 | 结果 |
| --- | --- |
| `npm --prefix runtime test` | 1321 项：1288 通过、0 失败、33 跳过 |
| `npm --prefix ai-runtime test` | 71/71 通过 |
| `npm --prefix sdk/typescript test` | 22/22 通过 |
| `npm run typecheck` | Runtime、AI runtime、Web 全部通过 |
| `npm run build` | SDK、Runtime、AI runtime、Web 生产构建通过 |
| 主机执行权限 UI | 26/26 通过 |
| 任务中心 UI | 17/17 通过 |
| 安装账号修复 UI | 3 组通过，无页面异常或意外请求 |
| 多账号与集中凭据 UI | 7 组通过，无页面异常或意外请求 |
| `git diff --check` | 通过 |

完整 runtime 覆盖安装、升级、回退、模式切换、卸载、恢复、签名脚本、调度、AI/MCP 入口、普通/提权任务授权及审计。曾失败的升级/恢复 fixture 已补齐严格模式观测，MCP/调度 fixture 使用真实签名 helper 契约的测试适配器；未通过放宽生产解析、权限或签名门禁掩盖失败。安装发行测试 31/31，完整主机管理测试 73/73 包含手动过期/撤销/一次性凭据、无效检查结果和混合候选的新增诊断验证。

33 项跳过包括需 Linux/root/systemd、真实 Docker、ClickHouse 或显式配置的外部环境，以及缺少指定 Go baseline 工具链的检查；逐项名称见机器可读报告。本机 macOS，Docker daemon 未运行，不能把其余通过项当作真实 Linux 生命周期验收。

UI 点击流程、截图和范围见 [ui-validation.md](ui-validation.md)。每台主机沿用独立进度及持久记录；账号补录后不会自动派发，不会修改已审阅计划身份或在 unknown 时重装。

## Doca 同步与回读

[LightMoni 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 已通过已登录 Doca 原生编辑界面保存，重新加载后回读正文、账号职责表和原生图。

- 仓库 `docs/system-design.md` 第87章及第22、27、71、84章等相关说明与在线设计对齐。第87.4新增安装账号修复与点击流程；第87.5记录无旧身份兼容边界。
- 权限架构图：8节点、9连线；普通脚本为 `lightmoni-agent 同UID`，root helper→普通脚本为启动前降权。
- 任务时序图：5参与者、9消息及5条生命线；核对 helper→中心领取、helper→普通脚本、普通脚本→helper→中心回执方向。
- 任务总览图：13节点、13连线；内置采集仍由普通 Agent 处理，有限脚本经签名 helper 启动，普通脚本与 Agent 共用账号。
- 保留原生图块、无关章节、SDD089、NAT规则和健康目标描述。在线交付状态已更新为当前回归结果，明确待合入、实机与镜像未完成。

回读：[single-account-doca-readback.json](evidence/single-account-doca-readback.json)。截图：[章节](evidence/single-account-doca-overview.jpg)、[权限架构](evidence/single-account-doca-architecture.jpg)、[任务时序](evidence/single-account-doca-sequence.jpg)、[任务总览](evidence/single-account-doca-task-flow.jpg)。旧 `doca-sync-readback.json` 与 `latest-main-integration.json` 保留为前一版历史证据，不作为本轮结果。

## 交付与边界

- 功能分支：`feat/087-agent-permission-boundaries`；GitHub [PR #83](https://github.com/workhold/lightmoni/pull/83)，保留 Draft 等待真实 Linux/systemd 验收，未合并。
- 本轮未对 vchive 或生产主机执行 SSH、安装、服务修改或模式切换，未构建/发布镜像。真实主机端到端验收仍待执行。
- 旧 root 常驻安装须先使用原版本受管流程卸载后重装，新卸载器不接管旧运行态。
- 不包含平台主机 RBAC、任意业务账户执行或不可信脚本沙箱；Docker daemon 身份绑定仍需独立确认。
