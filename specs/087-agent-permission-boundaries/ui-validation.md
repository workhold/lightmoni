# SDD087 UI 文案与回归证据

## 当前账号语义

| 场景 | 用户看到的行为 |
| --- | --- |
| 登记与维护 SSH | 首次默认并推荐 root；可用合格 sudo 账号。只用于固定安装、升级、回退、模式切换和卸载，不成为 Agent 运行身份。 |
| 常驻 Agent 与普通脚本 | 共用 `lightmoni-agent` 非 root 账号；脚本作为受信任代码，可访问该账号可读凭据与可写状态。 |
| 完整管理 | 同包同版本 root 管理组件处理签名任务；普通脚本降权到 Agent 账号，高权限任务按具体计划审批并审计。 |
| 仅监控 | 无 root helper、不领取用户脚本，保留采集、心跳及控制配置。 |
| 生命周期结果未知 | 显示原记录与只读核对，不跨账号重放安装或改写已批准身份。 |

## 点击流程

部署对话框使用“检查账号 → 确认安装 → 查看进度”的主路径。失败原因置顶，身份说明和 SSH 检查明细折叠。无凭据也可进入部署设置，再配置账号；权限不足时直接提供“添加 SSH 账号 / 管理账号与凭据 / 重新检查”。

添加账号后自动展开凭据表单。返回时保留版本、主机标签、管理模式；新凭据必须重新检查、生成新计划并由用户确认，不自动执行。检查、升级/回退、卸载及逐主机批量流程复用账号管理入口。

## 本轮验证

- `node web/src/app/verify-host-execution-ui.mjs`：**26/26**，覆盖单机/批量模式、手动账号、角色边界、精确审批、unknown核对、身份/代次异常、中英文深色主题和每台主机进度。
- `node web/src/app/verify-task-center.mjs`：**17/17**，覆盖上传/编辑脚本、参数、计划、执行资格、用户审阅、同账号真实身份、结果/重试/unknown及390px英文布局。
- `node web/src/app/verify-installation-account-recovery.mjs`：**3组通过**，中文权限不足后添加账号/输入凭据/检查/回到原安装设置；英文390px缺凭据进入配置并返回，无横向溢出。
- `node web/src/app/verify-connection-credentials.mjs`：**7组通过**，集中凭据元数据、明确账号绑定、自动/手动安装、默认账号、局部解绑和失效默认不回退root。
- 全项目 typecheck、生产 build 与 `git diff --check` 通过。

机器可读报告：[主机权限](evidence/single-account-ui/host-ui-report.json)、[任务中心](evidence/single-account-ui/task-center-report.json)、[账号修复](evidence/single-account-ui/recovery-ui-report.json)、[连接凭据](evidence/single-account-ui/connection-ui-report.json)。

截图：[中文安装账号修复](evidence/single-account-ui/account-recovery-zh-1440.png)、[英文窄屏](evidence/single-account-ui/account-recovery-en-390.png)、[中文任务中心](evidence/single-account-ui/task-center-zh-1440.png)、[英文任务中心](evidence/single-account-ui/task-center-en-390.png)。

上述浏览器验证使用本地构建与受控 API fixture；没有发起 SSH、生产写入或真实 Agent 安装。Linux/systemd 服务、sudo 权限和进程身份仍需实机验收。SDD049 原始证据保持不变，本轮产物复制到 SDD087 独立目录。
