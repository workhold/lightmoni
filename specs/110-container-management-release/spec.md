# SDD110：容器管理发行与部署

创建：2026-11-08。状态：双架构镜像已发布、中心部署及完整管理节点Agent升级已验收；交付记录见[PR148](https://github.com/workhold/lightmoni/pull/148)。

用户要求“所有你的提交合并到主分支，发docker，部署”。通过GitHub PR将待合并的安装位置/端口设置PR142与主机容器管理PR147合入main。发行源码固定为合并提交`70a0060fc47581078a3a0a5ac7b921c01d58d0aa`，镜像标签`20261108-container-management-v1`，包含Linux amd64/arm64及匹配源码的Agent发行包。

沿用生产Compose项目、环境、端口、网络、数据卷及密钥；备份和核对后仅更新中心服务。保留既有Agent权限边界，不因发行自动扩权。受管主机需新版Agent及已授权的完整管理能力才能提供容器写操作；检查其实际状态并记录部署范围。

验收要求：双架构镜像revision、非root运行、健康、登录、SDK/Agent下载、编译后的容器任务契约和镜像清理逻辑通过检查；Registry索引/manifest/blob回读一致。生产受保护SQLite快照quick_check通过，升级后中心healthy、公网healthz正常，原挂载、环境、端口、网络、密钥及其他容器不变。

浏览器完整增删改验收仍受SDD109记录的工具权限限制，不把此次合并授权计作T006通过，不在生产删除业务容器或镜像来补测试。

架构同步不适用：本次发行已在SDD109同步的实现，不新增组件、协议、凭据边界、存储或部署拓扑。仓库`docs/system-design.md`的SDD109章节与[Doca系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)同步回读证据见SDD109，seq1765，53个原生图块及节点、连线保留。本次无需改写。
