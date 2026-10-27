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
