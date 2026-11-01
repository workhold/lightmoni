# 发行验收

2026-11-01（Asia/Shanghai）。用户授权推送 GitHub、经 PR 合入 main 并更新 Docker。

## 源码与镜像

应用管理 PR #49 已通过 GitHub merge 合入，固定源码 `e3a527697c6718ee1e423a6341a48d313d4f193e`。构建上下文为该提交的 git archive，排除工作区、Git 元数据与运行时凭据。后续发布记录/默认引用提交不改变镜像内应用代码。

已发布 `docker.heyphp.com/lightmoni/lightmoni:20261101-e3a5276` 与 `latest`。两个标签回读同一双平台 OCI 索引：`sha256:579c48f5bf9d835ded279e71b938576530861c6cd4f71b708e8df963bf536be9`，支持 linux/amd64 与 linux/arm64。全部31个本地 OCI blob 的 SHA256、已验收镜像的 rootfs/config、远端 blob HEAD 和 manifest/config/index GET 均核对；独立 Docker CLI 重新拉取两个平台，与已验收 rootfs/config/revision 一致。Docker 29 的 image ID 可能标识外层索引或 manifest，未将 ID 相等当作内容匹配的唯一标准。七个历史固定标签摘要保持。

构建材料与脚本校验见 [build-inputs](evidence/build-inputs.json)；上传/远端/重新拉取见 [registry-summary](evidence/registry-summary.json)、[verified-release](evidence/verified-release.json)、[historical-tags](evidence/historical-tags.json)。凭据只通过受保护的 Docker credential helper 在进程中使用。

## 检查

两个平台分别完成17项真实镜像冒烟检查，0失败，见 [amd64](evidence/amd64-smoke.json) 与 [arm64](evidence/arm64-smoke.json)：非root运行、架构/source revision、真实隔离 ClickHouse 与 HTTP 健康、管理员 CLI/登录、身份和设置、生产网页包中的本次管理/商店/端口/窄屏内容、真实安装API拒绝未知端口名、仓库空状态、证书签发和执行步骤、私钥下载匹配及不回显、运维/任务/遥测API、四种SDK HTTP下载和校验、两种Agent归档校验、匹配平台Agent启动与能力、AI模块导入。

amd64使用本机Docker仿真，arm64为原生；独立ClickHouse为arm64。未将此验收说成两台物理主机、真实业务应用端口重新部署或生产升级。PR #49 的40项定向测试、安装与仓库各三轮浏览器结果保留于SDD 062，本次未重复运行或声明全量测试通过。

根Compose及兼容目录×有/无旧LIGHTMONI_IMAGE共四种组合通过，固定镜像引用、服务、卷和健康依赖保持，见 [compose-checks](evidence/compose-checks.json)。diff检查通过。

测试容器、网络、卷和权限0600的临时环境凭据已清理；未改动既有共享服务，见 [cleanup](evidence/cleanup.json)。本地归档和无凭据日志保留于忽略目录 `.local-dev/image-release-063/`，不推入Git。

## 发布与架构

[GitHub Release 20261101-e3a5276](https://github.com/workhold/lightmoni/releases/tag/20261101-e3a5276)绑定相同镜像源码。默认Compose、部署文档和证据由本次发行PR交付。已有部署仍需在原项目/环境/卷下执行pull和up，镜像发布不表示线上容器已经重建。

架构同步不适用：本次仅打包已合入实现和更新默认镜像，不新增组件职责、数据/控制路径、存储、协议、凭据边界或部署拓扑。原功能 `docs/system-design.md` 第62节、[Doca系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)及SDD 062原生图/正文回读证据保留，不重复改写。
