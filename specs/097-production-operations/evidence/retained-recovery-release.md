# 保留已移除应用目录的固定候选

源码 main：b930c4407523470168eddff6af1e52f4ccbf0f08（PR116），包含 PR108 中心权威对账与手动成员/解析保留、PR107/110 Agent 状态修正与降权兼容、PR112 内部指标及 PR114 应用绑定恢复。

Docker：docker.heyphp.com/lightmoni/lightmoni:20261106-retained-recovery-b930c44

OCI index：sha256:754cc742bb9d4fdeba4c5f21a0b0a16c2fc3dddb4b12d7d3020bf5ca9d7ae7ee

两架构各 50 项成品检查通过；各架构编译回归 172 项中 171 通过、1 项既有可选 Docker 证书 QA 跳过；平台/网站 85 项、队列围栏 15 项及真实 Linux 普通任务完整降权全部通过。按摘要回拉的 RootFS/Config 与已测成品完全一致；同架构 Agent 下载包和 25 个关键成品指纹完成验证。真实 RuntimeMonitor 经内存 exporter、ClickHouse、已鉴权 HTTP 查到新鲜中心心跳/堆样本。

本次仅补中心恢复决策与界面，当前生产 Agent 9956d29 已具有相同的只读核验能力。发布保留 stable latest 原摘要；完整 Agent/SDK 随镜像和中心下载服务提供。生产恢复及业务健康仍以新计划和实际回执验收，不将夹具当作线上通过。设计按用户要求仅维护本地仓库。

1Panel 实际于 2026-11-06 19:02:38 发起、19:04:48 启动替换、19:05:10 就绪成功。新界面实际计划 0e241a8184641ecfede9c3623d66e92f 核验通过：Registry、OpenResty、SDD091 快速安装各一个原容器及原挂载，DBX/Gitea 无容器的已移除记录保留原目录并退役。完成全部影响审阅、主机名确认后已提交第二次只读复验；最终回执与后续业务健康继续核对。
