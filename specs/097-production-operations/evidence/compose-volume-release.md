# Compose 命名卷巡检固定发行

源码 main 7061fd183353c0cdf8f267daa1944913d70c993d（PR118），包含 PR108 与本轮 Agent/应用状态恢复修复。

Docker：docker.heyphp.com/lightmoni/lightmoni:20261106-compose-volume-7061fd1。精确 OCI index 和各架构摘要见 compose-volume-registry-report.json；按摘要回拉证明见 compose-volume-pull-verification.json。

AMD64、ARM64 各 50 项成品检查通过。各架构编译回归 173 项中 172 通过、1 项既有可选 Docker 证书 QA 跳过；平台/网站 85 项、队列围栏 15 项及真实 Linux 普通任务降权通过。匹配架构 Agent 包和 25 个关键成品指纹验证完成；真实中心心跳/堆通过 SDK 内部 exporter 写入 ClickHouse 并经正式 HTTP 查到连续新鲜样本。

当前源代码回归 81 项全部通过、零跳过；覆盖普通项目卷、显式 name、external 和错误卷/读写漂移。此次不改变现有存储或控制路径，架构影响不适用；按用户要求不再同步 Doca。stable latest 保留原摘要，生产中心、zz-bj-1 Agent 更新和 DBX 恢复验证继续按实际回执记录。
