# 发布设计与契约

1. 从合入 main 的固定 SHA 生成 git archive，上下文排除工作区文件和凭据，沿用仓库 Dockerfile 与包锁、Node 摘要。
2. 构建 linux/amd64 与 linux/arm64，在本轮隔离网络/卷运行实际生产中心及 ClickHouse；验证认证、Logo 原子创建/读取/替换/移除、YAML 托管端口模块、Web 资产和 Agent/SDK。不得调用用户远程机器执行应用。
3. 沿用受保护 Docker helper；发布前核对全部 blob、实测 rootfs/config 和历史标签。固定标签拒绝覆盖异内容，latest 先核对未并发改变。发布后独立 CLI 拉取双平台核对；不含凭据的摘要入库。
4. 清理本轮容器、网络、卷和临时凭据。GitHub Release 指向同一源码；四处默认镜像更新及证据通过发布 PR 合入。

数据模型：镜像索引映射两平台 manifest/config/layers，均标记固定源码 revision；仅本地忽略目录保存构建归档。凭据不写入源码、证据、URL、镜像或日志。兼容合同：31 个模板和已有 Agent 协议不变，现有卷和 Compose 项目沿用。
