# 契约

| 场景 | 登录账号 | 实际系统身份 |
| --- | --- | --- |
| 安装/升级/回退/卸载/模式切换 | root 或免交互系统管理 sudo | 固定维护程序 UID0 |
| 常驻 Agent（两种模式） | 不使用 SSH | lightmoni-agent |
| 普通脚本（完整模式） | 不使用 SSH | lightmoni-agent，清空附加组/caps，NoNewPrivs |
| 已审批高权作业 | 不使用 SSH | 签名 helper 按现有计划执行 root |
| 监控模式 | 不使用 SSH | 无 helper、无任意脚本领取 |

运行配置保留 `runtime_mode=root|user` 作为 helper 启用策略，前端称完整管理/仅监控。Agent runtime observation 的 UID/GID 始终大于零；helper 的 UID0 与签名执行身份按独立状态确认。原 root 常驻 unit 不能被当作本契约下的有效安装。维护器不得将模式切换等价为给网络 Agent 改成 UID0。

helper 仅加载固定 root 私有快照；不以 root 运行 Agent 用户可写配置或插件。完整模式普通任务循环使用 root 私有凭据快照与独立恢复目录，并在启动脚本前降权到 lightmoni-agent。普通脚本与 daemon 同 UID，允许访问该账号可读的 Agent 凭据与可写状态；清空环境不构成同 UID 文件隔离。root helper 的签名私钥和授权账本不向普通账号开放。两类任务记录沿用 TaskRun/privileged audit，不新增绕过审批的通道。

签名心跳、任务身份快照、安装/升级/切换健康核对统一报告 `ordinary_task_identity.account=lightmoni-agent`，绑定非零 UID/GID 与 `permission_generation`。新发行不创建或维护第二个普通 task 账号，不接受旧 task 身份作为当前执行身份。

安装账号选择结果须保留候选尝试和审计。失败诊断只含账号标识、原因与下一步，不含密码、私钥或命令输出中的秘密。凭据修复后必须重新检查并建立新的审阅计划；原计划账号、目标和凭据 revision 仍不可改写。

`installation-preflight` 无可用候选时返回 HTTP 409、`code=installation_account_required` 和 `installation_recovery`；实际 SSH 检查失败保留 HTTP 200 的原检查结果、`installation_selection.attempts` 和修复建议。`installation_recovery` 含 `machine_id`、`selection_id`、`reason` 与 `next_step`：

- `reason`：`no_credentials`、`credentials_expired`、`credentials_revoked`、`credentials_unavailable`、`insufficient_privilege`、`connection_failed`、`host_prerequisites` 或 `check_failed`。
- `next_step`：`add_account`、`update_credentials`、`check_connection` 或 `fix_host`。

手动模式仅处理指定账号，过期/撤销/一次性凭据也返回结构化修复并写失败选择审计；不静默换账号。无效检查或权限未知不得误报缺sudo；混合候选保留已确认的权限不足证据。界面允许缺凭据主机进入安装配置，再补录账号；保存后必须重新检查、审阅和确认。已派发或unknown只读核对，不跨账号重放。

模式切换计划的 `revision` 固定为人工审阅时的规范化计划摘要。`user → root` 获批派发时，中心会在同一事务中签发 helper ID、安装代次和策略代次，存入计划记录的专用身份列，而不改写已审阅的 `plan_json` 或 `revision`。后续校验须将这些身份列与中心签发记录、新鲜 helper 心跳及当前授权逐项绑定。

## 安装事务收尾补充（2026-11-04）

SSH 诊断通道断开不改变安装事务的成功/失败语义。收尾必须完成既有回滚检查并返回原失败码；仅实际回滚失败保留生命周期锁与备份。中心的 `unknown`、只读核对、明确人工结束与恢复卸载契约不变，不能因输出丢失重放实际安装。
