# 设计

- 复用 agent_jobs 的不可变动作/目标和领域 observer，持久标记 execution_principal。生产中心启用强制主体边界，所有非普通只读作业标记独立执行器；普通 claim/payload/artifact/event/result 均拒绝对应作业。旧未领取写任务取消，已领取/unknown 保留核对。
- 为独立签名协议新增严格 managed payload，只允许现有固定运维/制品/systemd 动作；禁止任意 shell 转发。中心在领取/开始前重验原批准人、领域配置版本、image source policy、机器/实例绑定，冻结完整 payload 哈希和 capability；保留原作业 ID。
- root runner 在现有 journal/签名/短期许可/租约中调用共享适配器；使用 root 私有目录，执行前核对 daemon/根目录，绝不加载普通 Agent 可写代码。制品通过独立签名分块接口读取并复核大小/摘要，普通 bearer 不可读取。
- 结构化事件和最终执行回执回流 AgentJob 原事务，保留原领域健康/身份核验和错误分级；unknown 持久栅栏，取消和超时同步领域视图。
- 新增运维能力及迁移/升级状态 UI。生命周期核对 root 身份、journal 和发行摘要，升级/回退保留身份与策略，失败恢复旧代码；撤权单向生效。
- 验证所有既有适配器接缝与真实 Docker/网站/systemd 链路；重复运行有针对性的安全和功能回归，最后完整回归及双平台生产容器验收。发行 SDD079 在最终源码固定后重建。

## 旧数据接管

普通 Agent 可写状态不得自动成为 root 意图。固定 root CLI 提供离线迁移审阅：停掉旧 Agent、旧网站网关和使用旧目录的容器后，通过 nofollow 描述符复制到 root 私有审阅快照，保留文件摘要、数据 UID/GID 和目录结构；拒绝符号/硬链接、设备、未停止写入者与未决锁。管理员须审阅快照内的 Compose/Nginx/状态配置并用精确计划摘要批准，才发布到新的业务目录。此授权独立于普通凭据和在线作业，无自动应用。原目录不删除，失败不覆盖已有新业务状态。绝对内部路径只在控制文本中重写，数据字节不改；目标已非空则拒绝。未接管的旧业务会明确阻断新写操作，避免挂载空目录。

## 应用观测迁移

Docker 采集与日志游标转移到独立执行器的 root 私有队列，复用现有 ApplicationObserver 解析、断点和去重。仅签名的 observations targets/batches 接口读取中心绑定目标、提交受限 OTLP；当前策略、批准人、执行器代次及领域归属再次核验。中心先加密持久化 outbox 后应答，在事务之外以稳定批次/事件 ID 写 ClickHouse；普通 Agent 无须获得 Docker socket 或 root 数据凭据。队列分别限制 32 MiB，撤权不采集也不发送，不能无限堆积。生命周期停止保留游标，程序切换不恢复已撤销策略。
