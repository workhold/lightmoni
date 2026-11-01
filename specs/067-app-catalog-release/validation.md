# 应用商店发布验收

日期：2026-11-01。用户授权所有本次提交经 PR 合入 main、推送 GitHub 和发布 Docker。

## 已发布内容

`docker.heyphp.com/lightmoni/lightmoni:20261101-a1292cf` 与 `latest` 回读相同双平台 OCI 索引 `sha256:bbe6a9aa0757dfe76c47d9dc8f4c8017ccc617ddbda7672fa617f70ce7b67a7c`，支持 linux/amd64、linux/arm64。固定源码 `a1292cf5085d77f8f3eef74d9999c02652764c15`，包含 [PR #53](https://github.com/workhold/lightmoni/pull/53) 全部提交，见 [feature-merge.json](evidence/feature-merge.json)。

从合入主干的 git archive 完整构建生产网页、中心、两架构 Agent 与四种 record SDK。构建源、摘要、镜像材料和验证工具 SHA 见 [build-inputs.json](evidence/build-inputs.json)。

## 验证结果

- 两个平台各 23 项实际隔离生产容器检查通过，连接真实临时 ClickHouse，使用非 root 用户；登录、管理员 CLI、生产网页、证书与密钥、SDK 下载和匹配平台 Agent 命令通过。
- 实际认证 API 返回 31 个唯一应用和六类准确数量，工具只有 DBX；DBX 缺少密码在创建资源前拒绝；生产网页包含响应式分类、安装要求与每容器资源说明。
- 生产镜像内匹配架构 Agent 声明 operations.platform.oneshot.v1；实际导入打包后的模块，验证授权初始化正常退出 0 才完成、未授权和失败退出不能成功。完整检查见 [container-smoke.json](evidence/container-smoke.json)。
- 31 个 OCI blob 的 SHA256、大小及实测 rootfs/config 已核对，远端 manifest/config/index 回读一致；独立 Docker CLI 重新拉取两个平台，内容与实测镜像一致，见 [registry-summary.json](evidence/registry-summary.json)、[verified-release.json](evidence/verified-release.json)。
- 全部 22 个历史固定标签摘要保持，见 [historical-tags.json](evidence/historical-tags.json)。固定标签防止异内容覆盖，latest 发布前核对未发生并发变化。
- 根 Compose 与兼容入口、有/无旧 LIGHTMONI_IMAGE 共四种组合通过，默认镜像固定为本次版本，服务/卷/健康依赖保持，见 [compose-checks.json](evidence/compose-checks.json)。
- 本轮全部运行/停止容器、网络、卷及权限 0600 的临时运行凭据已清理，剩余为零；无关既有服务不变，见 [cleanup.json](evidence/cleanup.json)。

凭据只通过受保护 Docker helper 或临时环境使用，未进入仓库、证据、URL 或日志；原始归档和无凭据构建日志在忽略目录 .local-dev/image-release-067/。

## 架构与兼容

架构同步不适用：本 PR 仅打包已合入 SDD 066 并更新默认镜像和部署文档，不改变职责、路径、协议、存储、凭据或拓扑。架构功能通过同一个 PR #53 同步仓库 docs/system-design.md 第 66 节和 [Doca 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)，保存 seq 911 后目标七块一致、原有 33 个原生图完整保留；见 [SDD 066 回读证据](../066-app-catalog-expansion/evidence/doca-readback.json)。

本次是生产中心镜像验收，不等于全部第三方应用业务运行通过。完整 Harbor、NVIDIA 推理及 Dify/FastGPT 模型/插件仍保留 [SDD 066 已记录限制](../066-app-catalog-expansion/validation.md)。Harbor 仅 amd64 且需要 Engine 26 / Compose 2.26，FastGPT 需已有 S3，依赖初始化的新模板需先升级目标 Agent。

发布镜像不自动重建既有中心或升级 Agent；更新沿用原 Compose 项目、环境和卷执行 pull/up。[GitHub Release 20261101-a1292cf](https://github.com/workhold/lightmoni/releases/tag/20261101-a1292cf) 已发布并指向同一源码，见 [github-release.json](evidence/github-release.json)。默认引用与本证据通过发布 PR 交付 main；实际合入状态以 GitHub 回执核对。
