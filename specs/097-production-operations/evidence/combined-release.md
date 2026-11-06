固定main构建：fb68857ad50bf2015bbb02ce732853d546feee33。

- PR108：两种模式均按中心配置强制对账；手动原机修复并保留成员/解析，托管按最低可用预算补齐副本。
- PR107/110：独立Agent状态修正、旧libcap-ng完整降权兼容；zz-bj-1已成功修正卡住状态并重新接入。
- PR112：恢复中心显式内存exporter的系统指标交付；默认HTTP匿名门禁和权限不变。

Docker：docker.heyphp.com/lightmoni/lightmoni:20261106-reconcile-fb68857
OCI index：sha256:c0d50a28aab62c88ae9d7d1a048d8dc579817b016701e5725467ae7e7b8dcb76

AMD64/ARM64各50项成品检查通过，按架构摘要回拉的RootFS/Config与已测镜像一致。各架构编译回归：170项中169通过、1项既有可选Docker证书QA跳过；平台/网站77项、队列15项及实际Linux降权1项全部通过。两架构均通过真实RuntimeMonitor→SDK内存exporter→ClickHouse→HTTP查询，查到连续新鲜heartbeat/heap样本；合成DNS/Agent回执不视为生产通过。

固定候选发行，stable latest保持原摘要。完整同架构Agent/SDK下载包包含于镜像和中心下载服务；附件提供小型构建与验收报告。生产中心及zz-bj-1联测继续记录SDD097/098，设计仅维护仓库本地文档。

1Panel于2026-11-06 09:06:16发起固定候选更新，09:08:15替换启动，09:08:26就绪成功；实际回读固定tag、fb68857完整修订、index c0d50a28aab62c88ae9d7d1a048d8dc579817b016701e5725467ae7e7b8dcb76、healthy及原卷lightmoni_lightmoni-state-v2-20261103:/data均一致。生产新鲜中心指标和应用/Agent联测仍继续，不提前标记完成。

生产01:16:12Z只读查询：中心heartbeat和heap各12个120秒内样本，最新01:16:05Z；zz-bj-1 Agent heartbeat 4样本，最新01:15:51Z、可读名称zz-bj-1。堆内存max174864003 bytes，服务lightmoni-center。固定发行已包含PR108，生产DNS/应用联测仍继续。
