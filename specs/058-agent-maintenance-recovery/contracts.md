# 契约

- POST /api/v1/machines/:id/uninstallations/plan：管理员，check_id、可选 credential_id、mode（standard 默认或 recovery）、reason（recovery 必填，限制长度）、purge（默认 false）。拒绝未知字段。计划持久 mode/reason/purge、observation 和 credential_revocation_scope；具体证据字段以有界只读解析器类型为准。固定移除路径不接受用户输入。
- apply：confirm:true；仍绑定原计划、当前有效凭据与 SSH 指纹，复验快照并在锁内执行；数据策略和模式不能在 apply 修改。
- reconcile：可选 credential_id；只读，unknown 才可调用。明确选择时不得静默换用另一凭据。记录目标必须属于当前主机。
- receipt：保留 remote_removed、credentials_revoked、revoked_credentials；增加 mode、purge、data_removed/data_retained 与精确撤销范围。没有可撤销的本主机身份时 credentials_revoked 为 false，不能冒称已撤销外部平台凭据。
- capabilities：recovery_uninstall_agent 独立可用性，仍要求 direct SSH、可复用有效凭据、没有冲突生命周期或任务；不要求关联 Agent。手动脚本下载不要求存在主机绑定，但必须管理员登录。
- GET /api/v1/agent-maintenance/uninstaller：返回 {filename:"lightmoni-agent-uninstall.sh",sha256,script}；缺固定发行脚本返回 404，不使用任意文件路径，不包含凭据、不缓存秘密。脚本脱机运行不调用平台。
- 手动脚本：sh lightmoni-agent-uninstall.sh [--purge]；新安装亦可 sudo sh /usr/local/sbin/lightmoni-agent-uninstall [--purge]。root/Linux systemd；默认保留 /etc/lightmoni-agent 与 /var/lib/lightmoni-agent，--purge 显式清除；卸载本地保存的脚本也只移除其自身固定路径。拒绝非受管 unit、未完成任务、生命周期锁、危险路径/符号链接。无 --force 杀业务任务选项。

任务屏障覆盖 task-run 提交/claim、调度、auto retry，并不终止已有任务或阻止遥测。持久审批/执行/unknown 均为屏障，取消或已确定结束后解除。

旧 awaiting_approval 无观察快照时拒绝执行，可取消重计划；旧 unknown 保留原 standard/保留数据只读核对契约，要求固定原目标、同一有效身份、完整移除与持久目录保留，并在回执标明 legacy 证据，不伪造审批摘要。精确凭据归属规则仍适用。新发行升级/主动回退同步离线卸载器，失败恢复旧内容与权限；旧目标包缺脚本则保留现有并记录 uninstaller_updated:false。
