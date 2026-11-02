# SDD083：统一 Agent 契约

## 运行身份

同一发行只启动 `lightmoni-agent.service`。`runtime_mode` 为 `root` 或 `user`，`permission_generation` 为正安全整数。首装默认 root，可取消；更新不能改变模式。平台记录期望值，心跳报告实际 mode、generation、UID/GID、boot_id 与发行摘要；root 为 0:0，user 的 UID/GID 均须为正安全整数，不能以缺失或字符串值证明身份。

root 模式内嵌已有签名执行模块，内部身份只用于批准任务，不构成第二台节点或第二个常驻服务。普通脚本固定使用 lightmoni-agent 账户、清空附加组、清空 capabilities 并启用 NoNewPrivileges。root 脚本与受管运维动作继续经过精确计划、批准、签名、start permit、短租约、journal 与审计。

## 权限切换 API

基路径为 `/api/v1/machines/:id/agent-runtime`。管理入口要求有效的人工管理员会话；外部 AI/MCP 不能自行批准权限切换。

| 方法与相对路径 | 契约 |
| --- | --- |
| GET 空路径 | 当前期望/实际身份、在线状态及维护记录 |
| POST `/plans` | 输入 runtime_mode、可选 credential_id；SSH 预检并冻结目标、凭据修订、Agent、原 boot、源目标模式、代次与发行 SHA |
| GET `/plans`、`/plans/:planId` | 读取冻结记录，不重新派发 |
| POST `/plans/:planId/apply` | confirm=true、expected_revision、UUID request_id；同请求回读原记录，不重复执行 |
| POST `/plans/:planId/cancel` | confirm=true；仅取消未执行计划 |
| POST `/plans/:planId/reconcile` | 可选新有效 credential_id；只读原回执和现场，不重放 apply |

计划有效期五分钟。凭据或 SSH 目标改变、源模式/代次/内部签名身份改变、过期、未决任务、终端、其他维护或未排空遥测队列都阻止切换。失联保留 unknown 和主机维护门禁。

## 本地维护与回执

固定 `runtime-mode.mjs` 从受保护 stdin 接收有限字段，无调用者指定脚本或路径。持生命周期锁后二次核验现场；停服务后再次核验执行状态。旧可写缓存移入 root 自有维护目录，只重建验证后的稳定身份；不递归更改业务数据。配置目录 root 模式0700、user模式0750，配置文件分别0600/0640。

成功回执单次原子写入，包含 schema、operation_id、agent_id、runtime_mode、permission_generation、status、restored、error、uid、gid、boot_id、artifact_sha256。中心只持久化固定字段，拒绝额外秘密或任意错误文本；成功必须同时匹配该回执和同 boot 的新鲜目标心跳，root 另须内部签名身份在线。旧 boot 或短暂目标心跳不能单独完成切换。

失败恢复须有 failed/restored 回执、新 SSH probe boot 和同 boot/UID/GID/权限代次/发行摘要的心跳共同证明。结果不可证保留 unknown，不自动重放或恢复 root 授权。成功提交后的诊断清理失败不回滚已确认状态。

## 统一维护与历史边界

更新器保留 mode/generation 和内部身份，root 更新及程序回退重新激活目标程序；仅一套入口。旧普通服务模板在预检拒绝升级及回退，要求受管卸载重装。已有 root 的安装脚本只能重装相同制品，换制品必须使用正式升级协议。

卸载停止唯一服务并复核普通/受管未决结果，再移除程序及签名材料；业务容器、卷、网站和审计保留。中心确认移除后撤销关联身份。root 首装失败的恢复按 deployment、enrollment、Agent 及签发来源审计精确撤权，缺少绑定即拒绝；不能影响其他安装。
