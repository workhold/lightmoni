# SDD 087 验收状态

日期：2026-11-03

## 最终设计

- 登记 SSH 用户只负责远程生命周期维护：安装、升级、回退、模式切换和卸载。平台使用 root SSH 登录，或使用免交互系统管理 sudo 的普通 SSH 用户；有限 systemctl 权限不足以执行固定维护流程。批准后的维护请求绑定主机、账号、凭据修订、发行摘要和目标模式；远端结果不确定时只核对，不跨账号重放。
- 首次登记默认 root，新增账户提示推荐 root；可改用合格的 sudo 账号。已有账号与服务器 SSH 策略不变，实际权限仍由预检确认。内部两个无登录系统账号由安装程序管理，不要求用户填写密码或私钥。
- `lightmoni-agent.service` 始终由 `lightmoni-agent` 非 root 账号运行，负责遥测、心跳及控制面通信。平台不把 SSH 登录用户作为常驻 Agent 身份，也不因工作失败自动让 Agent 进程以 root 重试。
- 首装默认“完整管理”模式，随同一发行安装可选 root 管理组件；“仅监控”只安装非 root Agent，不领自定义脚本，也不提供管理型写操作。完整模式仍不是用户脚本的无限 sudo 通道。
- 普通脚本从任务中心进入 root 管理组件，由它启动固定脚本流程并切换到独立、无登录 shell 的 `lightmoni-task` UID/GID；清空附加组和 Linux capabilities，设置 NoNewPrivileges 和执行限制。高权限作业继续按具体计划、内容、目标审批并审计，不通过普通任务账号自动提权。
- Agent/helper 共用版本、安装、升级、回退、卸载及离线卸载脚本。模式切换保留人工审阅的计划摘要；运行期 helper 身份单独落账并通过签名心跳核验。旧独立 executor 安装入口已删除，不能与新生命周期混用。
- 同机脚本出现未核对的 `unknown` 结果时，停止该主机后续脚本派发和领取；管理员记录核对理由或用户明确重试后解除阻塞。SDK 仍独立上报。

## 本地验收

- 主机权限 UI：26/26；登记默认 root、允许 sudo 账号、中英文、深色、批量安装、模式变更和结果未知流程见 [ui-validation.md](ui-validation.md)。登记重试与英文窄屏另 3/3 通过，已有 deploy 默认账户保留。
- 任务中心 UI：17/17；见 [ui-validation.md](ui-validation.md)。本轮重新执行通过。
- Agent uninstall 与主机生命周期：49/49；另一次正常离线/完整模式卸载回归 2/2，平台卸载及凭据撤销路径 1/1。
- Agent 模式生命周期：58/58。
- 任务中心运行状态：12/12。
- Agent 安装与发行切换：31/31。
- Runtime/Web 类型检查、统一安装协议/运行测试、`git diff --check` 通过。
- `npm run build` — TypeScript SDK、Runtime、AI runtime 和 Web 生产构建通过。
- Agent release content filter：1/1。
- Release builder 更新了 package source/hash 排除集合，避免把已删除的旧独立生命周期模块重新装进制品。
- 已同步主干 `5747738`（PR #79、#80）；保留新合入的 systemd 发行版号识别和已预留绑定地址健康检查，并解决系统设计文档冲突。
- 同步主干后的 `npm run typecheck`、`npm run build` 再次通过。身份、发行内容、预留端口健康检查、平台集群与受管脚本回归共 56 项：55 通过、1 跳过（Linux root 脚本身份测试，本机 macOS 不具备运行条件）。
- SSH 安装账户自动/手动选择定向回归 3/3 通过。
- 重新生产构建后的登记回归 3/3 通过，证据见 `evidence/ui/registration-ui-report.json`。Linux 脚本身份 smoke 的生成代码修正转义，并用普通 `/proc/self/status` 文本 fixture 验证空/多附加组解析 2/2；该 fixture 只验证解析，不代表真实 Linux 身份测试已运行。

## 未完成与边界

- Doca 在线设计同步与回读：尚未完成。本轮网页已可访问，尝试更新总览后编辑器崩溃，无法确认完整章节、原生图和保存回读；当前进程未注入 MCP token。用户已明确安排“后续更新doca”，本次依该安排延期，保留待同步记录，不声称双端同步成功。
- GitHub PR：准备创建 Draft，明确 Doca 与 Linux 实机验收待办；不应视为已合并或已发布。
- 未对真实 vchive 或生产主机执行 SSH、服务修改、模式切换或安装写操作。仓库/fixture/本地构建证据不能代替 Linux 实机验收。
- 不包含平台级主机 RBAC；按现有范围由管理员管理全部登记主机。
