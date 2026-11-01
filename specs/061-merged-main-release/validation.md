# 合入与发行验收

2026-11-01。用户授权合入本账号PR并发布Docker/Git；#37、#39、#40、#41均已合入main，回执见[evidence/merged-prs.json](evidence/merged-prs.json)。#40的原提交通过#41保留的集成合并提交进入main，GitHub已确认其MERGED状态。镜像源码固定为`07bf306873e63a0219ad682c71e40589854afa42`，从git archive导出，未包含工作区发行配置或临时文件。

集成保留Docker即时控制及错误分类、安装事件事务投影、既有证书任务/日志界面、同机回环路由、系统仓库身份与网站鉴权。相关Runtime150项中136通过/14条件跳过，另显式开启真实Docker控制9项全部通过；AI Runtime71项及TypeScript SDK22项通过，runtime/web/AI类型检查及runtime/web构建通过。完整Runtime测试尝试在未修改的macOS卸载脚本测试处长时间无进展后中止，不声称全量通过。见[evidence/integration.json](evidence/integration.json)。安装关键流程及私库三轮浏览器复验通过，隔离Registry/OpenResty真实协议8项通过；前者回执受控，后者使用同一物理宿主的隔离daemon，不代表生产跨机容灾。

双平台本机Docker Desktop构建包含生产网页、双架构Agent和四种SDK，保持npm integrity、Debian签名及固定Node24.15.0校验。各平台15项真实容器检查通过，包含非root、源码标记、隔离ClickHouse/健康、管理员初始化登录、私有镜像/应用商店API、前端特性、证书签发下载、SDK/Agent下载及校验、打包Agent的新能力和AI模块导入。ARM64原生运行、AMD64仿真，共用隔离ARM64 ClickHouse；测试容器/网络/卷和凭据已清理，未更新生产实例。见[arm64](evidence/arm64-smoke.json)、[amd64](evidence/amd64-smoke.json)、[cleanup](evidence/cleanup.json)。

已发布`docker.heyphp.com/lightmoni/lightmoni:20261101-07bf306`与`latest`，两者均为双平台索引`sha256:0900cab572819da309270ec02b49975d710ae9261464140bb29d8d1609f2d768`。独立Docker客户端回读两标签索引并按平台重新拉取；平台manifest/config、rootfs、容器配置、架构与源码标记匹配本地已验收内容。Docker29 containerd可能以外层索引/manifest标识镜像，组合索引会改变ID，未把ID相等误作内容一致的唯一标准。6个历史固定标签摘要保持不变。上传与回读见[registry-summary](evidence/registry-summary.json)、[verified-release](evidence/verified-release.json)、[historical-tags](evidence/historical-tags.json)。凭据只经Docker credential helper在进程内使用，不进入仓库、日志、URL或发布正文。

根Compose与兼容入口的普通/遗留环境4种组合均指向新固定标签，健康依赖及两个数据卷保留。现有中心/Agent/业务容器不自动更新，新能力需要升级Agent；内网私库匿名可读写，仅适用可信网络。配置证据见[compose-checks](evidence/compose-checks.json)。

[GitHub Release 20261101-07bf306](https://github.com/workhold/lightmoni/releases/tag/20261101-07bf306)绑定镜像源码提交。后续配置/证据PR只更新发行默认引用和记录，不改变镜像内应用代码。架构同步不适用于本次打包：未新增控制路径、协议、部署拓扑或凭据边界；原功能SDD中的系统设计/Doca同步及原生图回读证据完整保留。
