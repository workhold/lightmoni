# 现状与决策研究

2026-10-31；代码阅读与官方资料研究，不是运行时验收。

## 现状

catalog.ts仅有MySQL/Redis/OpenResty静态版本和安装source。cluster-workloads.ts已有逐集群revision、资源/端口筛选与有状态不自动迁移；平台执行器按镜像引用渲染Compose并up --wait。尚无独立digest锁定、预热、更新检查和机器镜像源配置。

并行SDD058安装进度已在Doca，本方案复用其白名单阶段展示，不复制未合入代码。编号059避开其他工作树057/058。

| 问题 | 选择 | 原因 |
| --- | --- | --- |
| 全节点下载 | 默认运行机+至少1台合格备用，可选全部候选 | 控制磁盘/带宽，只针对已发布服务 |
| 集群互拉 | 先接独立内网OCI缓存，P2P另设计 | Docker本地存储不是通用registry服务 |
| 版本身份 | index/manifest/platform digest固定，tag只作发现 | 避免故障重启时内容漂移 |
| 所有仓库代理 | Hub镜像与其他源显式映射分开 | registry-mirrors不能概括任意私有仓库 |
| 缓存离线恢复 | 固定内容预填充，节点/缓存两端限制回源 | 普通pull-through首次miss或tag检查仍会回源 |
| 自动更新 | 默认检查和提示，限定无状态策略为P2 | 版本号不能证明数据库/数据迁移安全 |
| daemon配置 | CAS、合并、校验、维护、验证和恢复 | 不覆盖无关键，不保存即重启 |

## 官方资料

本项目策略为设计判断，以下为本次检索的技术依据。

- [Docker Hub镜像缓存](https://docs.docker.com/docker-hub/image-library/mirror/)：各daemon取本地缺失内容，缓存减少重复公网流量；Hub mirror适用范围、首次回源/tag检查及私有内容权限分别处理。
- [Docker daemon代理](https://docs.docker.com/engine/daemon/proxy/)：daemon代理与容器环境分离，有独立NO_PROXY和生效验证。
- [Compose pull_policy](https://docs.docker.com/reference/compose-file/services/#pull_policy)：本地缓存策略与latest例外要求谨慎，平台使用固定摘要和显式准备。
- [Docker服务镜像版本](https://docs.docker.com/engine/swarm/services/#specify-the-image-version-the-service-should-use)：tag/digest区别供参考，不引入Swarm，继续Agent/Compose架构。

## 性能边界

冷下载耗时取决于缺失层大小、有效带宽、仓库吞吐、解压与磁盘。内网缓存减少公网依赖，预热移除恢复路径中的传输，两者互补；无实测不声称几秒恢复。镜像齐全不能代替应用启动、健康与数据恢复。
