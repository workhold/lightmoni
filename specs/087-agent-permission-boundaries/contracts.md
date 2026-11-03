# 契约

| 场景 | 登录账号 | 实际系统身份 |
| --- | --- | --- |
| 安装/升级/回退/卸载/模式切换 | root 或免交互系统管理 sudo | 固定维护程序 UID0 |
| 常驻 Agent（两种模式） | 不使用 SSH | lightmoni-agent |
| 普通脚本（完整模式） | 不使用 SSH | lightmoni-task，清空附加组/caps，NoNewPrivs |
| 已审批高权作业 | 不使用 SSH | 签名 helper 按现有计划执行 root |
| 监控模式 | 不使用 SSH | 无 helper、无任意脚本领取 |

运行配置保留 `runtime_mode=root|user` 作为 helper 启用策略，前端称完整管理/仅监控。Agent runtime observation 的 UID/GID 始终大于零；helper 的 UID0 与签名执行身份按独立状态确认。原 root 常驻 unit 不能被当作本契约下的有效安装。维护器不得将模式切换等价为给网络 Agent 改成 UID0。

helper 仅加载固定 root 私有快照；不运行 Agent 用户可写配置或插件。完整模式普通任务循环使用 root 私有凭据快照与独立恢复目录，并在启动脚本前降权到 lightmoni-task。两类任务记录沿用 TaskRun/privileged audit，不新增绕过审批的通道。

模式切换计划的 `revision` 固定为人工审阅时的规范化计划摘要。`user → root` 获批派发时，中心会在同一事务中签发 helper ID、安装代次和策略代次，存入计划记录的专用身份列，而不改写已审阅的 `plan_json` 或 `revision`。后续校验须将这些身份列与中心签发记录、新鲜 helper 心跳及当前授权逐项绑定。
