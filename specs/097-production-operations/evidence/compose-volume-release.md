# Compose 命名卷巡检固定发行

源码 main 7061fd183353c0cdf8f267daa1944913d70c993d（PR118），包含 PR108 与本轮 Agent/应用状态恢复修复。

Docker：docker.heyphp.com/lightmoni/lightmoni:20261106-compose-volume-7061fd1。精确 OCI index 和各架构摘要见 compose-volume-registry-report.json；按摘要回拉证明见 compose-volume-pull-verification.json。

AMD64、ARM64 各 50 项成品检查通过。各架构编译回归 173 项中 172 通过、1 项既有可选 Docker 证书 QA 跳过；平台/网站 85 项、队列围栏 15 项及真实 Linux 普通任务降权通过。匹配架构 Agent 包和 25 个关键成品指纹验证完成；真实中心心跳/堆通过 SDK 内部 exporter 写入 ClickHouse 并经正式 HTTP 查到连续新鲜样本。

当前源代码回归 81 项全部通过、零跳过；覆盖普通项目卷、显式 name、external 和错误卷/读写漂移。此次不改变现有存储或控制路径，架构影响不适用；按用户要求不再同步 Doca。stable latest 保留原摘要，生产中心、zz-bj-1 Agent 更新和 DBX 恢复验证继续按实际回执记录。

1Panel 于 2026-11-06 20:36:28 发起、20:38:37 替换启动、20:38:48 就绪成功。zz-bj-1 普通升级 937c6ce0cc7d95a67b49a5fc31bf68a6 成功，同一 Agent 9cad2b3aabbd115280c2f4eba67733fe、目标 AMD64 包 b91d62209d872cd4bc64bbe1dec3973775b03989dfdc88c6c351ee8be4440473。原 DBX 测试应用 cbefd32c2e45e095b797e466f673acd9 于21:00:09启动成功。

13:32:00Z 只读验收：DBX 13:17:31 至13:31:31连续12次 inspect 均 healthy=true、configuration_matches=true，容器均为66d10808b194ad67a0d4e78d756fb0abfb57b022c6b999175d19c742cb330186，无再次 apply。原命名卷与数据路径保持，Registry/OpenResty 同时健康且配置一致。T022 通过；全套应用与 SDK 联测另继续。
