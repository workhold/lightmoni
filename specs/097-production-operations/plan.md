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

架构影响：是，维护控制路径和上报契约变化；实现稳定后更新 docs/system-design.md 第97节，设计与验证证据入同一 SDD/PR。用户于 2026-11-06 取消在线设计同步要求，后续只维护仓库设计；已有在线记录保留作历史证据。

## 管理员状态修正（用户补充）

新增独立恢复计划及审计表。恢复入口只要求已有 SSH 权限，不复用未结束任务/维护的前置禁用判断。只读核验固定 Agent 路径、两种服务、helper、操作锁和独立执行/升级工作单元；仅远端完整移除且保留身份与中心绑定一致时生成五分钟审阅计划。计划记录目标、凭据版本、远端摘要、受影响任务/维护及内部身份清单，并以现有维护守卫暂停该主机的新派发。执行前重新核验现场及中心快照，任一变化拒绝；取消或过期自动释放预约。

单个 SQLite 事务内取消未领取工作，已领取/未知工作保留为 unknown 并登记管理员核对，结束旧维护预约、撤销同机旧身份的 Agent 与 helper 凭据并写入生命周期退役。原状态保存在独立审计快照；共享作业栅栏只认可同机同身份、同任务且已成功提交的恢复证据。旧审批和迟到回执不能恢复权限或覆盖核对结论。该流程仅修正中心状态，不删除任何远端文件或业务数据；保留 Agent 状态的后续清理继续走已审阅 SSH 恢复卸载。覆盖权限、目标/凭据/任务竞争、活动进程拒绝、过期、重复执行、事务回滚和其他主机隔离。

## 线上新增发现（配套成品构建期间）

执行节点内置大盘仍明确以 agent_id 作为曲线图例、日志列；SDK 内置大盘也拼接完整 instance_id，通用主机模板使用 host_id。中心从 heartbeat 投影的内部运行指标/日志没有 host.name，因此仅补普通 Agent 上报不足以修复这些页面。中心内部投影应从当前可信主机绑定补名称，内置查询和新建模板优先使用可读名称；对已有系统大盘仅替换仍与旧内置配方完全一致的查询，保留用户改过的 SQL、布局、设置和版本历史，并使更新幂等。

另在线日志看到 zz-bj-1 的 center discovery/control 反复 no verified center endpoint is reachable 和上报积压。先在配套升级后检查实际端点、身份、HTTP/TLS和网络错误，再判断是配置、网络还是重试逻辑；未取得证据前不放宽证书校验、不绕过中心身份核验。

旧安装预检：zz-bj-1 实测仍为 root 常驻、无统一 helper 的历史安装，unit SHA 为19f0b122…，不是当前统一生命周期。补固定旧版识别和明确拒绝指引；对无法验证的安装返回固定错误码，不用通用SSH失败掩盖实际原因，也不绕过新安装边界。

端点恢复：单一公网入口发送失败会被冷却30秒；发现阶段即使已重新验证同中心身份和认证清单，旧冷却仍能把刚验证成功的入口排除。共享SDK/Agent选择器应只在完整有效认证清单成功后解除该source冷却；传输正文仍按原持久批次重试，不在选择器内部重放POST。鉴权失败、身份不符、清单无效和TLS失败均不能解除冷却或放宽信任。

## CentOS 旧能力库兼容

只读实测旧 `setpriv ... --*-caps=-all` 返回 127（libcap-ng is too old for all caps）；使用内核 cap_last_cap=40 展开 -cap_0 至 -cap_40 后，UID/GID=994/991、附加组空、NoNewPrivs=1、CapInh/Prm/Eff/Bnd/Amb 全零。共享 ordinaryTaskCommand 从 /proc/sys/kernel/cap_last_cap 读取严格的 0..63 整数，为 bounding/inheritable/ambient 使用同一完整编号集；核验探针和每次实际任务共用，不持久缓存。原有实际身份核验仍强制五集合全零，错误时不执行脚本；新增固定诊断码，不透出原始 SSH 输出。

此处改动执行参数与故障诊断，权限边界不变；本地 docs/system-design.md 第 97 节同步。依据 util-linux 2.32.1 的 setpriv do_caps 实现（https://github.com/util-linux/util-linux/blob/v2.32.1/sys-utils/setpriv.c），数字语法为 cap_N；是否完整清除仍由实际 /proc 观测确认。

## 内部遥测导出

TypeScript SDK 的队列门禁仅对默认 HTTPExporter 的系统表缺少 options.key 时抑制发送；显式 custom exporter 由调用方承担交付，允许既有中心 Ingest.internal 内存回调收到 lightmoni 指标/日志。collectSelf 的无 Key 抑制保持，普通 HTTP 和中心接收鉴权不变。补 SDK 自定义系统批次交付/匿名 HTTP 抑制/禁用/重试字节冻结，以及 RuntimeMonitor 实际产生 heartbeat、堆、请求计数、直方图和日志的集成。固定镜像验收必须查询到新鲜中心 heartbeat 和堆数据，不能只验证 SQL 语法。
