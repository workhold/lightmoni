# 设计

新增共享blockingAgentJobSQL谓词。正常活动作业继续阻塞；仅当agent_jobs为privileged_executor/unknown，并存在同ID、同Agent、task_run_id同ID、operations.managed.v1/unknown且resolved_at/by/reason完整的privileged_jobs记录时豁免该历史作业。无特权表时保守沿用未结束状态判断。别名仅允许内部标识符。

执行器领取/计划和主机安装、卸载、更新、运行模式、Docker维护、身份替换与实例恢复复用同一谓词；执行器自身对privileged queued作业的排队规则保持原样。回归覆盖真实签名作业租约丢失→人工核对→新作业领取，及错误绑定/缺失审计/普通未知等拒绝场景。

同一PR记录仓库章节、Doca目标与最新seq回读，完成后构建双架构固定镜像，经PR合入、发布并保护性升级中心。线上不修改作业数据库状态，回读既有核对及新检查，恢复受管DNS并核验可信HTTPS。
