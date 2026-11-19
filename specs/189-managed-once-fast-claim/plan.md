# SDD 189 设计

`PrivilegedExecutorRunner.once()` 用于中心通过 SSH 启动的指定作业。把入口前的 `observeOnce()` 改为 `heartbeat()`，保留执行器身份、发行、能力和策略校验，再处理本地 journal、租约与精确作业领取。`runManagedHelper()` 原有的 `observeOnce()` 循环继续负责 Docker 指标与日志采集。

这样任务领取不再等待应用观测队列的拉取、冲刷、Docker 扫描和日志读取。执行协议、权限边界、状态机与存储格式保持不变；发生控制链路故障时仍以原租约规则报告未知结果。

架构影响：受管 helper 与 SSH 单次进程的观测职责和控制路径发生变化，更新 `docs/system-design.md` 第 123.3 节。

发布计划：按仓库统一版本脚本升至 0.1.8，PR 合入 `main` 后构建固定标签的中心镜像与内置双架构 Agent 包，执行隔离健康检查并回读镜像 revision 和 digest；随后按 `deploy/server/README.md` 更新中心，再从主机管理升级 `zz-bj-1` Agent。核对新 Agent build ID、四个应用的周期性状态和私有仓库镜像清单；历史未知结果只按原人工核对流程处理。
