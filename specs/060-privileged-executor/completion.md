# SDD060：#64 完成收口与旧通道删除

2026-11-01，按用户“继续开发完成，旧的东西找出来，不需要兼容太多”的要求执行。基线为已同步 main fd3685e 的实施分支。此文件先确定本轮契约，再实施；不修改普通 SDK 直报模式，不自动部署到用户机器。

## 完成目标

本 PR 完成普通 Agent 与 root 执行器的基础产品闭环：明确身份、独立签名任务、一次性人类审批、最小容器能力、完整可审阅生命周期以及中心强制关闭旧特权通道。网站/证书/备份/完整 Compose 的新受管 profile、持续定时 root 授权属于独立业务功能；不能为保留旧功能把旧 control 通道继续当作 root 执行入口，也不能将这些后续业务功能混称为本 PR 已实现。

## 旧通道处理

- 普通 agent_jobs 仅允许固定只读能力和动作配对，enqueue/claim/租约接口与私有载荷统一执行中心校验，不能信任客户端自报 capability。
- 旧写任务未领取则取消；曾领取或执行则 unknown，保留原审计和互斥，禁止自动转成 root 或重放。历史数据是证据，不是兼容执行分支。
- 普通 control 的 operations 私有正文与 release artifact 下载入口删除或明确返回已移除，不解密或发送秘密。写入调用者在创建任务前给出明确的 executor/profile 未就绪错误，不能保存永远无法领取的任务。
- Docker 补装仅安装 Engine/Compose 依赖并验证 root 观察；删除给普通 Agent 写 Docker 附加组 drop-in、重启 Agent、引导加入 Docker 组的代码与文案。Docker 观测/控制与主机能力区分，普通 Agent 不接触原始 daemon。
- UI 对未迁移旧动作显示准确阻塞原因，使用统一执行器计划/结果入口；不保留两个执行按钮或声称旧动作已自动迁移。

## 本平台旧权限残留

已批准的普通Agent安装/升级/回退在变更前检查固定unit drop-in，仅允许root拥有、非symlink、不可被普通用户写且内容逐字节等于本平台旧20-lightmoni-docker.conf的Docker附加组授权。停服后复验并精确删除、持久化父目录；不备份或随程序回退恢复权限。未知drop-in、外部组/ACL不修改，明确拒绝并保留现场。维护步骤与回执记录清理结果。所有待启动或恢复的普通Agent主unit必须整份匹配固定SHA白名单，并在任何root权限准备器执行前验证；高权限旧previous-service仅作证据，不作为可回退目标（probe.previous=null）。升级/安装失败不得恢复旧unit：保留已验证普通unit、安全停服/disable、保留锁与现场，报告rollback_failed/unknown；不改旧fingerprint或伪称完整回退。不通过保留旧授权换兼容。

## 最小容器界面

主机界面提供最小结构化容器计划与记录，复用既有privileged-execution API，不保留旧docker-jobs按钮。只允许list/pull/create/start/stop/restart/remove；固定单台主机、资源ID/revision、镜像digest和架构（仅pull/create）及超时/输出上限。审阅完整精确payload与身份/策略代次，稳定request_id单次批准；结果与取消/人工核对遵循统一执行器记录，敏感输出主动读取。该表单不接收Compose、任意command、挂载或业务部署参数，不把它包装成完整业务容器部署。

## 唯一执行器维护接口

保留现有 executor-maintenance plan/apply/history/reconcile，action 扩为 upgrade、rollback、repair、uninstall，不新增另一套维护 API。审批冻结主机、凭据、executor ID/安装代次、源/目标程序摘要、state_schema、策略代次；apply 复验人类管理员会话、绑定、有效凭据、主机任务互斥与稳定 request_id。

升级目标来自同一 AgentReleaseCatalog 的不可变发行，state_schema 必须精确相等（首版为1）。回退只选择本机可信 retained previous 元数据中精确程序指纹，重新审批。拒绝无 manifest 的 legacy 目录、模糊版本推断、自动兼容旧 schema。程序/launcher/unit 与 previous 元数据原子持久切换；绝不回退 config 私钥、加密密钥、journal、防重、grants、资源清单、最高策略代次及 fence。

root 监督器固定目录和身份，不从普通 Agent 可写路径加载代码。先持生命周期锁、验证固定服务，停止后取得 writer 锁并读取 clean status，再切换程序；启动前释放 writer 锁。root阶段记录含activation_id：首次安装生成UUID并逐阶段保留，维护启动前固定为本次operation_id。worker启动时只读一次root阶段记录并校验完整身份/发行，随后独立签名心跳必填此activation_id；中心要求durable started receipt与精确程序/代次及本次operation相同activation的签名心跳共同成立。仅时间新鲜或同版本旧进程心跳不能证明修复后重连。失败或确认丢失保持 unknown，不自动回切、重复安装或重放原操作；原计划的 reconcile 只读核对现场，不消除真实 unknown 任务。

repair 仅修复可证明的本平台中断安装：完整相同身份、完整有效 journal、无未决副作用且中心绑定仍有效。它可修程序/固定 unit/启动阶段，不重新 enrollment、不重建或删除 journal。安装先持久记录本次阶段，修复按精确记录识别残留。身份未完成注册、config/journal缺失损坏或现场不可证明时明确拒绝并保留证据，不能猜测缺席后重装。

## 验收

中心必须证明普通 control 自报高权限不能领取/读取/报告写任务；旧排队与在途任务不得自动重放。Docker 安装脚本不得写普通 Agent 权限或重启它。生命周期覆盖成功、目标/凭据/角色变化、两进程争锁、失败中断、unknown只读恢复、保留journal水位与回退摘要约束；浏览器审阅内容与实际 action 一致。记录实际运行范围，仓库系统设计与 Doca 同步并回读。


显式reconcile的中断收口：若stop失败且源程序/身份/原activation仍精确匹配、服务仍active、完整journal clean，可仅把本次维护记失败释放维护lane，保留root阶段证据以新审阅repair。若root已持久记录本次operation的ready/目标/activation且独立签名心跳精确相同，即使最后started回执落盘中断，也可在显式只读核对中记录该证据并确认成功；不伪造或改写远端started回执、不由自动GET推定、不清执行unknown。其余缺证明场景保留unknown。
