# 本机双架构镜像发布（2026-10-28）

已发布到 `docker.heyphp.com/lightmoni/lightmoni`：固定标签 `20261027-ec30880` 与 `latest` 回读为同一索引 `sha256:4c6fc6e044de40da75a37f8f03e12c076cc90060e9b4f7125f734c682de1b4fb`，支持 Linux amd64/arm64。固定标签沿用本次任务开始时的命名，实际完成日期为 2026-10-28。

## 源码与本机构建

源码固定为已合入 [PR #8](https://github.com/workhold/lightmoni/pull/8) 的 `ec3088093498d8f052323ff395ada52607473d0a`。从 `git archive` 干净快照使用现有 `deploy/server/Dockerfile` 完整构建中心、网页、Mastra、双架构 Agent 和 TypeScript/Go/Python/Rust SDK。包含五类双语折叠导航、SDK 的 Apache-2.0 许可及 main 已有运维能力；不包含本 PR 的发布文档和默认标签更新。

构建与容器验收全部在本电脑的专属 Colima Linux VM 内完成，未使用远程主机或 GitHub Actions。VM 为 ARM 架构，6 CPU、8 GiB 内存；BuildKit 内存上限 6 GiB、最大并行 2。arm64 容器使用本机 VM 的原生架构，amd64 中心、ClickHouse 与 Agent 入口均通过本地 daemon 仿真执行，未独立确认仿真实现，不将其称为 amd64 原生 runner。

Docker Hub 连接不稳定时使用按摘要固定的 Node/ClickHouse 镜像副本，并核对官方 Docker Hub 的索引与平台摘要。Debian 镜像地址使用现有构建参数且保留 apt 签名验证；amd64 使用现有 NPM 镜像参数且保留 lockfile integrity 校验，arm64 使用默认 npm 地址。Agent 内嵌 Node 仍从 `nodejs.org` 下载并校验官方 SHASUMS。详见 [build-inputs.json](build-inputs.json) 和 [base-images.json](base-images.json)。

## 验收和发布

每个平台各通过 10 项真实容器检查：非 root 用户与 revision、同平台真实 ClickHouse 26.8、中心健康和空状态、stdin 初始化管理员与登录/session、运维页面/API 权限、中心与 AI read/draft 工具导入、双 Agent 包 SHA/ELF/模块、目标平台 Agent `version` 入口，以及四种 SDK 的 HTTP 下载、摘要、Apache 许可和 Go GitHub module。生产网页 JS 同时验证五类双语导航和折叠标记；这不替代交互式浏览器验收。

| 平台 | 实际验收的镜像 manifest | 绑定的 config |
| --- | --- | --- |
| linux/amd64（仿真） | `sha256:51dd3d6ad8bef3050f631aaaf464fa481d705c6951d1dc90de79344a8afa15e0` | `sha256:58bf9858980e894d0555aaf579f313a169b05115f6f7eb8530b77e1aa35b7b9b` |
| linux/arm64 | `sha256:f96efe5f6756e195bae7c1d4d62d7668c33af4f6529e7188d0a5878d8cca028b` | `sha256:9c407b5e2c17a7eed858925cbfff957977907fe73ce5317887749ae73447821b` |

Docker 29 的本地 image ID 为 manifest 摘要；发布前分别绑定 manifest、config 和 rootfs diff_ids，避免将其误当作传统 config ID。发布直接使用上述已验收的原始 manifest 和完整本地 OCI 层，不重新构建或复用旧发布产物。每个中心镜像都包含两种 Agent 架构；只实际运行对应平台的 Agent 入口，另一架构做静态检查。各中心单独生成归档，跨中心的同架构归档 SHA 可以不同，以对应中心的下载清单为准。

首次 buildx 上传被仓库反向代理以 HTTP 413 拒绝，尚未写入平台 manifest 或标签，临时授权配置已删除。最终改为每块 512 KiB、最多 4 个独立连接的 OCI PATCH 上传；在读取密码前完整校验 31 个本地 blob 共 583,625,672 字节。鉴权仅保留于进程内存，不写 Docker auth 配置。全部 blob 完成后才按摘要写入两个原始平台 manifest，再发布固定标签与 `latest`。独立只读客户端完整 GET 索引、manifest、config 与所有层，逐一校验 SHA256 和长度，并确认旧固定标签未变。注册表不提供原子标签 CAS，仅在发布前立即检查 `latest` 是否并发变化。

## 证据

| 文件 | 内容 |
| --- | --- |
| [container-report.json](container-report.json) | 双平台检查汇总、执行方式与限制 |
| [amd64-container-report.json](amd64-container-report.json)、[arm64-container-report.json](arm64-container-report.json) | 各 10 项容器检查、导航、Agent/SDK 下载与清理记录 |
| [build-inputs.json](build-inputs.json)、[base-images.json](base-images.json) | 干净源码、构建参数、基础镜像、工具和资源限制 |
| [local-oci-export-report.json](local-oci-export-report.json)、[local-oci-export-verification.json](local-oci-export-verification.json) | 完整本地内容导出、每个 blob 的 SHA/大小和已验收镜像绑定 |
| [registry-report.json](registry-report.json)、[release-attempt.json](release-attempt.json) | 最终双标签、双平台、所有层独立 GET 校验、旧固定标签保护与发布结果 |
| [publisher-selfchecks.json](publisher-selfchecks.json)、[tool-checksums.json](tool-checksums.json) | 临时验收/发布工具的离线自检与文件 SHA256 |
| [cleanup-report.json](cleanup-report.json) | 专属测试资源、临时授权与本地 VM 清理范围 |

首次 ARM 验收的临时 internal bridge 无法映射宿主机端口，修正验收环境为专属普通 bridge 并仅绑定 host loopback 后，ARM 与 AMD 全部检查通过。该测试网络允许外连；验收未配置模型供应商，未发送模型请求。

## 边界、升级与回退

本次使用新建空数据卷，未验收生产存量数据升级或灾备；未启动 Agent daemon、批准运维任务或执行真实 Nginx/Compose/公网 ACME/S3 操作。完整 OCI GET 证明远端内容的完整性，不等于执行 `docker pull` 或再次运行远端拉取的容器。既有功能的领域验收及限制仍见 [SDD 026](../../../specs/026-operations-platform/validation.md)。

本次没有更新线上容器、远端 Agent 或生产数据。已有 1Panel/Compose 若固定 `20261027-operations`，需改为 `20261027-ec30880` 后重新拉取并重建容器；仅拉取镜像不会切换运行中的平台。沿用原项目名、数据卷与主密钥，升级前备份。旧固定标签 `20261027-operations` 仍为 `sha256:0c314e78da2243d9e2aba641d9bab460f3dd24a78a0c4dcf2abbc389c5defeff`，`latest` 已改指向本次新版本。中心镜像升级不会自动升级已安装的 Agent，详见[部署说明](../../../deploy/server/README.md)。

只处理本次专属测试容器、卷、网络和临时授权，停止专属本地 VM；保留本机镜像与 BuildKit 缓存便于重试，不做全局 prune，不修改其他项目、全局 Docker context 或 host SSH config。

## 架构影响

不适用。本次仅重建、发布已合入实现并更新镜像默认标签和验收记录，不改变组件、数据或控制路径、协议、凭据边界、存储或部署拓扑，无需重新改写仓库系统设计与 Doca。SDD 见 [028 本机镜像发布](../../../specs/028-local-image-release/spec.md)。
