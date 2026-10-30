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
