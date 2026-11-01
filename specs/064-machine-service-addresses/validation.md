# 验收记录

2026-11-01。仓库部署、集群与兼容旧运维路径统一读取机器管理的服务地址，SSH 域名和平台观测来源不再作为服务 IP。已发现的容器桥不用于跨机器服务通信。系统仓库按普通应用填写机器、端口、资源与缓存开关，不再填写内网 IP 或网络确认项。

运行时与网页类型检查通过；8 个定向测试文件共 85 项通过、0 失败，见 [定向回归](evidence/targeted-tests.json)。覆盖主机身份变更与地址更新、旧集群地址副本忽略、现代/旧服务发现、指定绑定 IP 与同机网关、跨机 loopback 隔离、IPv6、网站/DNS、缓存能力及策略重新校验。未运行全量测试。

真实本机 ARM64 Docker 验证见 [本机复用](evidence/docker-local.json)：已存在引用零远程请求、零下载，固定 image ID 且 pull_policy=never；另一个仓库名称的相同内容只读取两个 manifest，共 3635 字节，无 blob 下载和重复导入。两者均以 --pull=never、--network none 真实启动成功。缓存 miss、回源及校验失败由 HTTP/导入定向测试覆盖，未宣称完成生产跨地域或多物理主机验收。Docker 与 Registry 不共用持久目录。

浏览器连续三轮均通过，见 [界面报告](evidence/ui/report.json)。覆盖无 IP/网络确认字段、三个宿主到容器端口、重复端口拒绝与保留输入、刷新回显、真实版本冲突重试、缓存双入口、已有网站鉴权、200% 缩放、减弱动效和窄屏操作，以及只有公网网卡的机器仍可安装为本机范围。每轮页面错误为零。隔离 QA API 只验证表单和中心任务；未将排队状态当成真实安装成功。

视觉沿用现有应用管理方向。移除重复取址、网络确认与错误提示，保留机器、端口、资源、缓存和实际范围。主 Agent 已查看实际桌面和 390px 窄屏截图，未见重叠或裁切；本次局部表单修改未独立视觉评分。原页面入口、按钮按下、弹窗过渡及减弱动效沿用，截图/视频位于忽略目录 artifacts/screenshots/specs/064-machine-service-addresses/evidence/ui/，三轮对应 installation、public-machine-install、mobile-actions、zoom-200 等文件。

架构影响适用：机器地址唯一来源、缓存按消费机器投影、Agent 本机镜像优先。仓库 [系统设计第64节](../../docs/system-design.md) 与 [Doca设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 已保存并完整分页回读，见 [回读证据](evidence/doca-readback.json)。原有 679 个块及 33 张原生图的全部属性、节点、连线和顺序完全一致，追加 7 块后为 686 块。

兼容边界：有主机管理身份的机器不再采用 cluster.nodes 或旧 node_pool/gateway_group 中重复的服务地址；无网卡快照的历史数字 IP 与未纳管旧 Agent 保持兼容。具体 IP 绑定仍以实际部署为准，地址更新后需重新部署仓库才生效。中心升级不会自动升级既有 Agent；本地镜像优化需要新版 Agent。只有公网网卡时不产生匿名公网 HTTP 仓库，跨机继续使用原镜像源。此次验收未改动生产容器或业务卷。
