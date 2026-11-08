# SDD108：主机容器与文件管理发行

创建：2026-11-08。状态：镜像发行与生产部署已验收；交付记录通过[PR146](https://github.com/workhold/lightmoni/pull/146)合入。

用户授权将PR145合并到main、发布Docker并部署。发行代码来源固定为合并提交b9ca3b30200a527758f9c4b7e0e0fff5c8159505，镜像固定标签为20261108-host-files-v1，发布Linux amd64/arm64。只更新现有中心服务，沿用当前Compose项目、环境、端口、网络和持久卷；Agent及ClickHouse版本保持原样。

验收：两架构镜像的源码revision、运行账户、健康、登录、下载及主机文件管理资源/路由可核对；Registry索引、平台manifest和blob摘要回读一致；线上完成受保护备份、SQLite quick_check后更新中心，确认容器healthy与公网healthz、原/data挂载一致，真实管理员页面可打开全部容器和文件管理入口。线上验证仅作只读浏览，不修改业务文件。

架构同步：不适用。SDD107的新增管理员HTTP→SSH/SFTP通路与审计表已在PR145同步仓库/Doca并回读；本轮仅将该实现发布到既有拓扑，不新增权限、凭据、协议、存储路径或Agent能力。
