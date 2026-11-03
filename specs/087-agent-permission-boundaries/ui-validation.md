# SDD087 UI 文案与回归证据

## 用户可见的身份语义

| 场景 | UI 应表达的身份与行为 |
| --- | --- |
| 登记及生命周期 SSH | 首次登记默认 root，用户可改为其他账号；新增账户提示推荐 root。SSH 登录账号只用于经审阅的安装、升级、回退、卸载和管理模式变更；需要 root 或免交互 sudo。它不是 Agent 或任务进程身份。 |
| 常驻 Agent | 两种管理模式下都以 `lightmoni-agent` 非 root 身份运行。UI 显示其真实 UID/GID 和有效心跳。 |
| 完整管理 | 额外安装同一发行中的 `lightmoni-agent-helper.service` root 管理组件。与 Agent 共用升级、卸载及维护流程；启用模式本身不代表批准任何任务能力。 |
| 仅监控 | 不安装 root 管理组件，不开放自定义脚本领取或容器管理。 |
| 普通脚本 | 仅在完整管理模式中由 root 管理组件启动，脚本进程固定降权到 `lightmoni-task`。任务中心说明目标、代码、发起人、UID/GID、状态和结果进入执行记录；派发仍需审阅和确认。 |
| 高权限脚本 | 使用独立提权计划；展示实际系统账号及 UID/GID、完整代码、解释器、目标主机和约束。用户逐计划审阅、单次批准并留审计。普通任务不会自动获得该权限。 |

检查主机详情、首装及批量首装、Agent 权限模式、主机执行权限、任务中心、提权任务和受管容器 UI 后，以上语义一致。中英文 UI 均使用“root management component / root 管理组件”表达 root 常驻维护组件，不再把它说成一个不同的 Agent 账户或仅凭“root 模式”暗示网络 Agent 以 UID 0 运行。

## 验证

- `node web/src/app/verify-host-execution-ui.mjs` — **26/26**。覆盖登记默认 root/可修改与英文推荐提示、单机/批量安装默认完整管理与仅监控、手动账号选择、回执不匹配、未知结果不重放、权限模式切换及核对、精确能力审批、身份/代次异常门禁和中英文深色主题。所有 API 由浏览器 fixture 拦截；不发起 SSH 或生产写入。
- `LIGHTMONI_QA_OUTPUT=specs/087-agent-permission-boundaries/evidence/ui node web/src/app/verify-host-registration-onboarding.mjs` — **3/3**。登记与凭据重试、英文窄屏、已有 deploy 默认账户保留；root 仅为首次登记默认值。
- `node web/src/app/verify-task-center.mjs` — **17/17**。任务编辑、执行资格、审阅派发、发起人与真实非 root 执行身份、终态核对、默认任务、AI 提案和窄屏英文布局。
- `npm --prefix web run typecheck` — 通过。
- `npm --prefix runtime run typecheck` — 通过。
- `node --import tsx --test --test-concurrency=1 test/agent-uninstall-script.test.ts test/machine-agent-lifecycle.test.ts`（工作目录 `runtime/`）— **49/49**。包括 full-management SSH 审阅卸载同时移除 Agent、root 管理组件和专用任务账号，并保留配置及已接收队列。
- `node --import tsx --test --test-concurrency=1 test/machine-agent-runtime.test.ts` — **58/58**。覆盖非 root SSH + 免交互 sudo 安装模式变更、完整管理/仅监控切换、helper 首次签名心跳、运行身份账本列绑定和权限代次核验。
- `node --import tsx --test --test-concurrency=1 test/task-center.test.ts` — **12/12**。覆盖有界脚本派发、helper 签名领取、租约结果、自动/人工重试、同主机未核对结果阻塞和恢复。
- `node --import tsx --test --test-concurrency=1 test/install-release.test.ts` — **31/31**。覆盖完整管理/仅监控安装、Agent/helper 一起发布、helper 首装登记、回滚和模式要求。
- `npm --prefix runtime run typecheck`、`npm --prefix web run typecheck` — 通过。
- `git diff --check` — 通过。

权限切换的审阅摘要保持不可变；首次登记的 helper ID、安装代次和策略代次另存于运行计划列，并与签名心跳比较。同一主机的 `unknown` 脚本记录未核对时，中心拒绝后续派发，helper 不领取同机其他脚本；显式重试或人工核对后解除阻塞。

## 截图与 SDD049 证据归属

- Agent 权限模式的中文审阅截图：[runtime-mode-zh.png](evidence/ui/runtime-mode-zh.png)；英文深色截图：[runtime-mode-en-dark.png](evidence/ui/runtime-mode-en-dark.png)。
- 任务中心中文截图：[task-center-zh-1440.png](evidence/ui/task-center-zh-1440.png)；英文窄屏截图：[task-center-en-390.png](evidence/ui/task-center-en-390.png)。
- 浏览器回归机器可读结果：[host-ui-results.json](evidence/ui/host-ui-results.json)、[task-center-results.json](evidence/ui/task-center-results.json)。
- SDD049 仍拥有其任务中心回归原始报告与截图，保存在 [`specs/049-platform-default-tasks/evidence/`](../049-platform-default-tasks/evidence/)；SDD087 的副本只为本设计记录提供可读证据，不移动或覆盖 SDD049 文件。

这些浏览器截图/fixture 不能证明真实目标主机上的 SSH、安装、systemd 服务或 root 管理组件已经运行；实机验收仍需独立记录。
