# 网站访问日志身份

生产 Gitea 恢复部署 9a793410637f94cb67db8f2884874501 于 2026-11-06T21:40:19Z 成功。运行卡片恢复正常，原“资源不足”提示消失，首页和 /api/healthz 均经生产中心正常 DNS/TLS 返回 200。

执行端观测 state=ok，队列 0、中心积压 0；ClickHouse 能读到新 OpenResty 容器日志，但 website_id 为空。核对记录正文只取安全字段，发现 body.website_id=4d108de3c8cc58c2df240a485ac1f082，中心标为 unregistered_website_id。该值是 siteBundle 对真实网站 ID 与分组序号生成的片段摘要。日志采集与传输正常，错误发生在网关日志身份编译阶段。

修正方案在规格/设计/契约/T027 先落盘：新增显式原网站 website_id，目录与证书继续使用片段 id。中心所有权校验保持；旧日志不回写。平台真实 HTTP 多绑定生成、Nginx 渲染、旧载荷兼容、非法 ID 和既有归属回归共 91 项通过、0 跳过；runtime typecheck/build 通过。生产新日志验证结果见下文。

架构影响为受管网关载荷内的网站身份与观测契约纠正，已更新 docs/system-design.md 的受管观测段；按用户要求只维护仓库本地设计，无 Doca 写入。

## 最终发行与线上验收

PR126修复合入后，固定发行[20261107-website-identity-573b644](https://github.com/workhold/lightmoni/releases/tag/20261107-website-identity-573b644)已发布；源码573b644885c0db9846648e51fb0726141040c1e9，OCI index为sha256:f24403c80ba37af7bed013b2b56da63f0cede1fb8ad2e78baefc1b83ccad1e57。双架构每架构50项成品smoke、95项编译后的自动部署/网站回归全部通过；其余174项编译回归173通过、1项原有可选真实Docker证书环境检查跳过。Linux普通身份和实时中心SDK→ClickHouse→认证HTTP新鲜数据检查通过，精确镜像回拉一致。PR127记录固定发行与产物证据。

中心通过既有1Panel于2026-11-07 07:09:34 CST更新就绪，实际镜像index一致且healthy，原lightmoni_lightmoni-state-v2-20261103:/data保持。镜像自身revision为本次源码，容器内platform.js SHA256为e60fe9dc7f9fdfc9fd6d27c1116d4c00ecf9a340d01df291bc147841f2f4f559、cluster-workloads.js为8347ee854e72c43a0d92208d896d9f0bdce4f8aa02e10523c0c05f22da80c0b5，均与验证产物一致。1Panel复制的容器自定义旧revision标签不作为源码证据。

zz-bj-1通过正常升级be85cf8c70108787ec4052714e8a6277更新成功，Agent身份9cad2b3aabbd115280c2f4eba67733fe保持，build=0.1.0-573b644885c0-d8c395f1a253，artifact SHA256=0c043104b2c6960eeec6b0d4754bc11ed52d71984ce0347bd5b9939aeed10e46。执行端仍以UID994/GID991运行，无附加组、NoNewPrivileges=1、五项能力集合为0，原全管理模式保持。

真实HTTPS访问经默认TLS验证；ClickHouse按event_time、域名、website_id、状态和来源聚合，结果如下。第一轮Gitea包含首页和健康检查两条，后两轮各访问一次首页；Registry的401是正常鉴权响应。

| UTC分钟 | 域名 | 真实website_id | HTTP状态 | 来源 | 条数 |
| --- | --- | --- | --- | --- | --- |
| 2026-11-06 23:59 | gitea-test.heyphp.com | d10681c050f98906039de32b8ad89fa8 | 200 | zz-bj-1 | 2 |
| 2026-11-06 23:59 | install-091.heyphp.com | bf0ecca5bb35b49c6ac658437b46e657 | 200 | zz-bj-1 | 1 |
| 2026-11-06 23:59 | registry-demo.heyphp.com | fb2bb27e9a85a7e83cb46412d3eab67a | 401 | zz-bj-1 | 1 |
| 2026-11-07 00:19 | gitea-test.heyphp.com | d10681c050f98906039de32b8ad89fa8 | 200 | zz-bj-1 | 1 |
| 2026-11-07 00:19 | install-091.heyphp.com | bf0ecca5bb35b49c6ac658437b46e657 | 200 | zz-bj-1 | 1 |
| 2026-11-07 00:19 | registry-demo.heyphp.com | fb2bb27e9a85a7e83cb46412d3eab67a | 401 | zz-bj-1 | 1 |
| 2026-11-07 00:26 | gitea-test.heyphp.com | d10681c050f98906039de32b8ad89fa8 | 200 | zz-bj-1 | 1 |
| 2026-11-07 00:26 | install-091.heyphp.com | bf0ecca5bb35b49c6ac658437b46e657 | 200 | zz-bj-1 | 1 |
| 2026-11-07 00:26 | registry-demo.heyphp.com | fb2bb27e9a85a7e83cb46412d3eab67a | 401 | zz-bj-1 | 1 |

以上新记录body.website_id与索引website_id一致，不再标为unregistered_website_id；原错误片段历史保留。[Gitea网站监控页](https://moni.heyphp.com/websites/d10681c050f98906039de32b8ad89fa8/monitoring)显示采集正常、zz-bj-1来源，有真实QPS和请求耗时图，访问表可见07:59:06、08:19:54、08:26:19 CST三轮200请求。截图保存在本地.local-dev/097l-release/gitea-website-monitoring.png。

2026-11-07T00:43:13.283Z最终只读回查：未结束unknown作业0；application_observation最近成功00:42:50.394Z，state=ok、error为空，queue_batches=0、queue_bytes=0；中心待处理观测批次0。Gitea、DBX、Registry、OpenResty实际/期望均running，ABC和SDK探针实际/期望均removed，六实例health_failures均0。机器写操作仅zz-bj-1，vchive未写入。全部验收见live-matrix.md。
