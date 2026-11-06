# 应用绑定恢复固定候选发行

构建来源：main 的 9956d2958a88af291909d15a6e0191f467711bc0（PR114）；包含 PR108 中心配置权威对账、手动成员/解析保留，PR107 状态修正、PR110 完整降权兼容和 PR112 中心内部指标修复。

Docker：docker.heyphp.com/lightmoni/lightmoni:20261106-workload-recovery-9956d29

OCI index：sha256:a934c69acef902779f82d4805521f1e318efbf078fa0faba52022aed4fe3cef1

- AMD64：sha256:df04044c719a462e26e7745f7929c731607068784fcd69986728d318d5800c4e
- ARM64：sha256:10b3eb0da63eaf26976dc8cd0f9c9657577dd7f9d3091212a1997308625d7c8a

两架构各 50 项成品检查通过。各架构编译回归 172 项中 171 通过、1 项既有可选 Docker 证书 QA 跳过；平台/网站 84 项、队列围栏 15 项以及实际 Linux 普通任务降权检查均全部通过。匹配架构下载包包含新的只读应用恢复核验能力，25 个关键成品文件指纹匹配。

均已通过真实 RuntimeMonitor → SDK 内存 exporter → ClickHouse → 已鉴权 HTTP 查询，取得不同时间的新鲜心跳和堆样本。按架构摘要回拉的 RootFS、Config 和完整源码修订与已测镜像相同。合成 Agent/DNS 回执不作为生产恢复或解析验收。

固定候选已发布，stable latest 保持 sha256:1435938eacd969554e581b1cce0b996ff36ac6e1b886c9fc42e5b21e231a5a51。完整 Agent/SDK 包包含于镜像和中心下载服务；GitHub 附件提供校验报告。设计仅维护本地仓库文档。

生产 1Panel 更新、当前 zz-bj-1 Agent 升级、旧应用核验/复验恢复及后续健康仍待实际验收，不提前标记 T020 完成。
