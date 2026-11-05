# Implementation Plan

保留现有 Node/TypeScript、SQLite、ClickHouse、React 与签名 helper 权限边界、持久队列及未知结果围栏。

## 根因与设计
1. 只读诊断：task_runs 无活动项，单个后台 inspect 排队即阻止 Agent 维护，巡检持续补充。维护规划前持久预约 machine/agent，read-only SSH 检查结束后由既有 awaiting_approval 记录接管预约；准备预约最多120秒，正常完成/失败均按随机token释放。所有 enqueue/claim 通过既有维护守卫检查准备预约。仅未领取、attempts=0、无lease且私有加密载荷证明为 node/workload/gateway.inspect 的受管平台读取可延后（用户主动 inspect 同样只读），原任务保留；helper已经启动、运行中写操作、用户脚本及未核对 unknown 仍阻塞。机器按钮和后端使用同一判定。
2. heartbeat 返回 machine_name，Agent controlOnce 忽略；accept 只补 host.id 和 lightmoni.agent_id。后续批次补经认证中心返回的机器名，缺失时降级 hostname，已入队 payload 和去重身份不改写。
   已接受的批次根据持久 input_hash 回执直接重复确认，不根据当前名称重新生成已冻结的转发字节；否则名称更新会导致合法重试 forward_hash 冲突。内容不同的同ID批次仍拒绝。
3. 受管观测中心绑定归属，但 service 为空时回退 application_id，resource_json 没有机器名。按受信主机/应用关系补名称并实际存储，不从容器标签或 SDK 声明扩展权限。
4. 应用资源不足、卸载和日志缺失在更新中心和 Agent 后分别复现；新发现先追加本设计和任务。

## 验证与发行
维护竞争和身份链路添加必要回归，运行相关 typecheck/build/集成测试。固定 main 构建双架构成品，隔离验收、固定标签发布与摘要回拉、1Panel 更新，线上矩阵逐项核对且仅 zz-bj-1。模拟回执不算线上通过。

架构影响：是，维护控制路径和上报契约变化；实现稳定后更新 docs/system-design.md 第97节与 Doca 原生章节/图，保留既有内容，回读文字、节点和连线，证据入同一 SDD/PR。
