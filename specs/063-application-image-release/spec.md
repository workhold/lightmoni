# 应用管理版本合入与镜像发布

2026-11-01（Asia/Shanghai），用户授权：全部推送 GitHub、合并主分支、更新 Docker。本次包含应用管理 PR #49 及必要的镜像引用/发布证据 PR，所有 main 写入通过 GitHub PR。

从已合入 main 的固定源码 e3a527697c6718ee1e423a6341a48d313d4f193e 完整构建 linux/amd64 与 linux/arm64，发布既有 docker.heyphp.com/lightmoni/lightmoni 的 20261101-e3a5276 与 latest；创建绑定同一源码的 GitHub Release，更新 Compose 和部署文档默认引用。旧固定标签保持，镜像包含网页、中心、Agent 与 SDK。保留既有 npm/Node/apt 完整性检查和非 root 运行。

验收：两个平台真实中心容器连接隔离 ClickHouse，登录、应用/仓库 API、网页及下载核对通过；远端索引/平台摘要、实际拉取内容和源码标签匹配；检查两种 Compose 入口与旧环境兼容。发布测试资源和临时凭据清理，本地 main 与远端同步。不将镜像推送当作既有线上容器已经重建。

架构同步：本次仅打包发布已合入实现、更新默认镜像及记录，不新增控制路径、协议、存储、凭据边界或部署拓扑，仓库/Doca 新增架构同步不适用。原功能 SDD 062 的第62节与 Doca 回读证据沿用。
