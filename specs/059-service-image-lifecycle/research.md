# 现状与决策研究

2026-10-31；代码阅读与官方资料研究，不是运行时验收。

## 现状

catalog.ts仅有MySQL/Redis/OpenResty静态版本和安装source。cluster-workloads.ts已有逐集群revision、资源/端口筛选与有状态不自动迁移；平台执行器按镜像引用渲染Compose并up --wait。尚无独立digest锁定、预热、更新检查和机器镜像源配置。

并行SDD058安装进度已在Doca，本方案复用其白名单阶段展示，不复制未合入代码。编号059避开其他工作树057/058。

| 问题 | 选择 | 原因 |
| --- | --- | --- |
| 全节点下载 | 默认运行机+至少1台合格备用，可选全部候选 | 控制磁盘/带宽，只针对已发布服务 |
| 集群镜像准备 | 默认Agent从已有镜像源预热到候选本机，无新增仓库；已有共享OCI缓存可选，P2P另设计 | 每集群新增仓库带来存储/认证/可用性运维负担，基础恢复不应依赖它 |
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

## 2026-10-31 轻量默认修订

用户指出每集群增加仓库过重。修订为不自动部署、不要求配置仓库；发布时Agent经已有源准备运行机和备用机。代价是准备阶段仍可能重复消耗外网带宽，且未预热接管机可能需要冷拉；用户可扩大到全部合格候选，或在已有基础设施时接入共享内网仓库。多个集群可复用同一可达端点，权限仍隔离。优先交付无需新服务的基础路径，可选缓存不阻塞商店/自定义版本升级。

## 2026-11-01 仓库应用与1Panel鉴权对齐

用户将仓库作为按需安装应用纳入设计，允许内网免登录及公网网站鉴权。默认不开启的轻量基础仍保留；多集群独立存储选择唯一push origin，其他集群通过明确读取映射/缓存/复制分发。此为项目设计，不代表Distribution提供自动跨集群复制。

- [1Panel官方网站配置](https://docs.fit2cloud.com/1panel/user_manual/websites/website-config-basic/)：密码访问支持全局或按路径配置。LightMoni对齐此范围，账号组、版本发布及Registry兼容为本项目扩展，不宣称1Panel具备这些相同契约。
- [NGINX Basic Auth](https://nginx.org/en/docs/http/ngx_http_auth_basic_module.html)：支持server/location、realm、用户文件及off覆盖；IP和密码组合由satisfy控制，哈希支持依赖crypt实现，需实际OpenResty能力验证。
- [Distribution nginx代理认证](https://distribution.github.io/distribution/recipes/nginx/)：提供TLS入口、pull/push账号组和/v2/上传代理参考，也说明免认证后端可能成为旁路。选取协议行为，不照搬旧TLS参数或命令行密码示例。
- [Distribution pull-through](https://distribution.github.io/distribution/recipes/mirror/)：缓存单上游、首次miss/tag检查可能回源，Docker Hub mirror与通用源映射有边界；私有上游凭据可能扩大缓存可读内容，访问范围须另行约束。
- [Distribution官方实现app.go](https://github.com/distribution/distribution/blob/main/registry/handlers/app.go)：proxy配置进入缓存模式，源码明确该模式不支持blob上传；因此本设计把可push私库和cache放在独立服务/端口/目录，不当同进程可切换双用库。

代码现状：nginx.ts已规范化IP allow/deny、location和响应缓存，但无结构化auth；自定义片段拒绝auth_basic_user_file，不应通过放开任意文件路径实现鉴权。renderLocations当前有CORS OPTIONS提前return及return action，后续必须重排或拒绝受保护组合，不能只追加两条auth指令就声称无旁路。
