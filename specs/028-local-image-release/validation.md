# 验收记录（2026-10-28）

## 最终结果

固定源码 `ec3088093498d8f052323ff395ada52607473d0a` 已在本电脑的专属 Colima VM 完整构建为 Linux amd64/arm64 镜像。每个平台各通过 10 项真实容器检查，随后从本电脑发布至 `docker.heyphp.com/lightmoni/lightmoni`。

`20261027-ec30880` 与 `latest` 均为双平台索引 `sha256:4c6fc6e044de40da75a37f8f03e12c076cc90060e9b4f7125f734c682de1b4fb`。固定标签沿用任务开始时命名，实际完成日期为 2026-10-28。旧 `20261027-operations` 索引 `sha256:0c314e78da2243d9e2aba641d9bab460f3dd24a78a0c4dcf2abbc389c5defeff` 保留未变。

## 验收对应

| 规格验收项 | 结果与证据 |
| --- | --- |
| 本机干净源码完整构建、revision 和架构一致 | `git archive` 固定 main 提交；原有 Dockerfile 完整构建；[构建输入](../../docs/evidence/local-image-release-ec30880/build-inputs.json)记录官方基础镜像摘要、网络镜像参数和工具版本 |
| 双平台隔离容器验收 | [amd64](../../docs/evidence/local-image-release-ec30880/amd64-container-report.json)、[arm64](../../docs/evidence/local-image-release-ec30880/arm64-container-report.json)各 10 项通过，包括同平台真实 ClickHouse、登录、权限、导航资产、Agent 入口与四 SDK 下载许可 |
| 验收后发布及独立回读 | [本地内容导出](../../docs/evidence/local-image-release-ec30880/local-oci-export-report.json)及[完整 blob 校验](../../docs/evidence/local-image-release-ec30880/local-oci-export-verification.json)绑定已验收 manifest/config；[注册表报告](../../docs/evidence/local-image-release-ec30880/registry-report.json)完整 GET 索引、manifest、config 和每个镜像层，SHA256/长度均通过 |
| 凭据不进入构建/仓库/报告 | 初次 buildx 上传返回 413，未写标签，隔离授权文件已清理；最终使用 512 KiB OCI PATCH 分块，密码通过不回显终端输入并仅存在进程内存，不创建 Docker auth config；[发布结果](../../docs/evidence/local-image-release-ec30880/release-attempt.json)记录无 auth config |
| 清理及部署默认标签 | 两份容器报告的专属测试资源清理均无错误；[清理报告](../../docs/evidence/local-image-release-ec30880/cleanup-report.json)确认无测试网络/临时授权且本地 VM 已停止。Compose YAML 可解析，根目录和兼容入口的两个 `.env.example` 与文档均指向新固定标签；`git diff --check` 通过 |

原始 Docker/buildx 上传因仓库代理大请求限制失败，最终采用完整本地 OCI 导出的分块上传，不重建镜像、不修改仓库代理。发布工具保留固定标签保护和 `latest` 并发变更检查；注册表无原子 CAS，不能保证检查与写入之间没有竞争。临时工具的正反离线检查与摘要见[自检](../../docs/evidence/local-image-release-ec30880/publisher-selfchecks.json)和[文件 SHA](../../docs/evidence/local-image-release-ec30880/tool-checksums.json)。

## 适用边界

- 两个平台均在本机 ARM Linux VM；amd64 中心、ClickHouse 和 Agent 入口通过 daemon 仿真执行，并非 amd64 原生 runner。未独立确认具体仿真实现。
- 使用全新隔离卷，不代表存量生产数据升级或灾备已验证。网页验证基于真实 HTTP 返回的生产 JS，不代表交互式浏览器验收。
- Agent 包校验及目标架构 `version` 执行不代表 Agent daemon 或批准任务已运行；未实操 Nginx/Compose/公网 ACME/真实 S3，未发送模型生成请求。
- 独立全层 OCI GET 不等于执行 Docker pull 或重新运行远端拉取的镜像。本次未修改线上容器、远端主机或已安装 Agent。
- 本次只更新打包发布与默认标签，架构同步不适用；不重复改写仓库系统设计或 Doca。

完整说明见[发布记录](../../docs/evidence/local-image-release-ec30880/README.md)。

## 2026-10-30 Compose 直接指定已发布镜像

根 Compose 直接固定 `docker.heyphp.com/lightmoni/lightmoni:20261030-ddd7426`，兼容入口继承它；两个环境示例不再提供 `LIGHTMONI_IMAGE`。旧 `.env` 或 shell 中残留该变量时也不能覆盖仓库选择的镜像。数据库密码、监听、项目名等仍沿用已有 `.env`。

### 验证

- 使用 Docker Compose 实际解析，共 12 项通过：根目录/兼容入口各覆盖镜像变量缺省、旧 `.env` 值、旧 shell 值、显式回滚覆盖、数据库密码仍必填，另检查两个环境示例均未声明镜像变量。
- 根/兼容入口的每种正常解析与修改前配置完整对比，除 `services.lightmoni.image` 外完全一致；包括数据库环境、端口、挂载、卷、项目名、健康依赖与构建参数。
- 显式回滚覆盖文件能选择旧固定镜像，其他配置与仓库新配置完全一致。部署说明已给出覆盖方式。
- 通过 Docker 客户端回读注册表，新固定标签的索引为 `sha256:5cc3dbe52b86feb5412509c2e744a10097db0b2e80e9191c626d95207fea2ef4`，含 Linux amd64/arm64，与前轮已发布且两平台实际拉取核验的镜像一致。
- `git diff --check` 通过。本次只有 Compose、环境示例、文档和 SDD 变化，未重复运行无关业务测试或重建镜像，也未重启本地或远端实例。

解析与远端回读证据：[20261030-compose-image.json](evidence/20261030-compose-image.json)。前轮镜像两平台各 8 组容器检查及 Docker 实际拉取对照结果：[20261030-release-verification.json](evidence/20261030-release-verification.json)；使用隔离 ARM64 ClickHouse，amd64 中心/Agent 在本机 Docker 仿真运行，不将其称为原生 amd64 或生产升级验收。

### 架构与交付

架构同步不适用：仅变更镜像选择配置与部署说明，组件、拓扑、存储、协议、数据/控制路径、凭据和 AI/工具边界均不变，不为此改写仓库系统设计或 Doca。本轮用户明确要求改完后交付 GitHub 主分支，已授权通过功能分支 PR 合入 main。

交付入口：[GitHub PR #26](https://github.com/workhold/lightmoni/pull/26)，目标 `main`；合入状态以 GitHub PR 记录为准。

## 2026-10-31 集中凭据与主机地址版本

本次发布固定源码为已合入 PR #25 的 main `e3d11928ed85a30d76af15e12552e01fe0712627`，通过 `git archive` 导出干净构建上下文。完整构建中心、AI runtime、网页、双架构 Agent 和四 SDK，未使用远端主机或 GitHub Actions 构建。

### 构建与容器验收

- [构建输入](evidence/20261031-e3d1192/build-inputs.json)记录本机专属 Colima VM、基础镜像摘要及网络镜像参数。使用现有 Dockerfile 参数切换下载镜像，保持 npm integrity、官方 Node archive SHA256 与 apt 签名校验。
- [amd64 容器报告](evidence/20261031-e3d1192/amd64-container-report.json)和 [arm64 容器报告](evidence/20261031-e3d1192/arm64-container-report.json)各 8 组通过，包括真实 ClickHouse 26.8、中心健康、管理员初始化/登录/权限、任务与运维接口、中央凭据 API/默认主机绑定/撤销失效、主机网络字段只读、生产网页资源以及 AI 模块导入。
- 两份 Agent 包均核对 SHA256、ELF 架构及 10 个编译模块与平台构建输出一致；每个平台实际运行对应 Agent 的 `version` 和纯函数网络 fixture，覆盖私网、ULA 和 CGNAT 地址。四 SDK 的校验和与 Apache 许可完整。
- [本地镜像身份](evidence/20261031-e3d1192/local-image-identities.json)绑定验收镜像的 manifest/config 与 rootfs；[工具摘要](evidence/20261031-e3d1192/tool-checksums.json)记录临时构建、验收和发布脚本。
- 首轮 amd64 凭据时长检查误将两次采样时间要求为精确相等，调整为只容许一秒内插入耗时且不放宽 6 小时上限，随后完整重跑 8 组通过；生产代码未改动。

### 注册表与 Compose

固定标签为 `docker.heyphp.com/lightmoni/lightmoni:20261031-e3d1192`，同时更新 `latest`。两个标签已写入并回读一致，索引为 `sha256:85cdbacc6bf4e97b6947b694f88224e86624a367db8342ca1f294042b2e824ae`。[注册表报告](evidence/20261031-e3d1192/registry-report.json)独立 GET 索引、两平台 manifest/config 和全部 29 个唯一镜像层，SHA256、长度、架构与源码 revision 均通过，并与本地已验收镜像身份一致。旧固定标签 `20261030-ddd7426` 保留为 `sha256:5cc3dbe52b86feb5412509c2e744a10097db0b2e80e9191c626d95207fea2ef4`。

[本地完整 OCI 校验](evidence/20261031-e3d1192/local-oci-export-verification.json)在写入注册表标签前验证全部 31 个 layer/config blob，共 602,575,546 字节；上传采用本机 512 KiB PATCH 分块。[发布结果](evidence/20261031-e3d1192/release-attempt.json)状态为 `verified`，固定标签和 `latest` 均完成；密码通过无回显输入仅保留于发布进程内存，未使用 Docker auth config。注册表没有原子标签 CAS，发布工具在提升 `latest` 前核对其未被其他发布修改，仍无法消除核对与写入之间的并发窗口。

[Compose 验证](evidence/20261031-e3d1192/compose-verification.json)使用实际 Docker Compose 5.1.4 解析根目录和兼容入口，除中心镜像字段外与发布前配置完全一致；遗留 `LIGHTMONI_IMAGE` 不覆盖新固定版本，数据库环境、持久卷与可信代理透传保持。解析没有启动平台实例。部署说明同步给出 1Panel 改标签、拉取并重新创建容器，以及通过已有凭据登记主机、SSH 安装检查和审阅后部署 Agent 的流程。

[清理报告](evidence/20261031-e3d1192/cleanup-report.json)记录两轮验收各移除 2 个容器、2 个卷和 1 个网络且无错误；专用 `lightmoni-release` VM 已停止，全局默认 Docker context 保持 `default`，未执行全局 prune。`git diff --check` 与证据 JSON 解析/凭据模式检查通过。

### 验证范围与架构判断

- 两平台在本机 ARM Linux VM；amd64 经已注册仿真执行，不属于原生 amd64 runner。
- 使用全新隔离卷，未验证存量生产数据升级；网页检查为真实 HTTP 生产资源，不属于交互式浏览器验收。
- 未执行 SSH、Agent daemon、安装器、批准任务或用户脚本，也未操作线上平台及 vchive。Agent 包校验和网络 fixture 不代表实际主机安装已经成功。
- 未请求模型生成，未执行真实 Nginx/公网 ACME/云/DNS/S3 操作。独立完整镜像层 GET 不等于 Docker pull 或执行从远端重新拉取的镜像。
- 架构同步不适用：本轮仅打包发布已合入能力、更新 Compose 镜像指针及发布证据，组件职责、拓扑、协议、存储、数据/控制路径、凭据和 AI/工具边界未改变，不重复改写仓库系统设计或 Doca。
