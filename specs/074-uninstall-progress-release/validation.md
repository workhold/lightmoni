# 发布验收

日期：2026-11-01。用户授权合入主分支并发布 Docker。

## 源码与镜像

[PR #60](https://github.com/workhold/lightmoni/pull/60) 已合入 GitHub main，固定源码为 `1c82e6b64e8432bd449b957eebf8141aa08e04e6`，见[合并回执](evidence/merged-pr.json)。使用该提交的 git archive 构建，工作区和运行凭据不进入上下文；[构建材料](evidence/build-inputs.json)记录 context SHA256、基础 Node 镜像摘要、工具与验证脚本摘要及各平台构建 digest。

Docker 固定标签 `docker.heyphp.com/lightmoni/lightmoni:20261101-1c82e6b` 和 `latest` 均已回读为 OCI 索引 `sha256:063672bf82dca4834a1f9c4b12feb2964fb57d8393dab11157df313c3079c688`，包含 linux/amd64、linux/arm64。31 个 blob 的本地 SHA256、大小、平台 manifest/config 与实际测试镜像 rootfs/config 均核对，远端 manifest/config/index 回读一致；两个平台独立拉取后内容与实测镜像相同。见[发布摘要](evidence/registry-summary.json)、[独立拉取](evidence/verified-release.json)。固定标签禁止异内容覆盖，latest 写入前检查并发变化；25 个历史固定标签保持原摘要，见[历史标签核对](evidence/historical-tags.json)。

## 验收证据

- 两个平台实际生产容器各 27 项检查通过，使用非 root 中心和真实隔离 ClickHouse；覆盖健康、管理员 CLI/登录、身份、中心 API、31 项应用商店、Logo/YAML、证书材料、四种 SDK 和双架构 Agent 下载及校验、匹配平台 Agent 运行、权限文件和 AI 模块。见[容器验收](evidence/container-smoke.json)。
- 从实际镜像导出网页资源，使用 SDD073 原卸载浏览器验证脚本，仅适配资源路径和依赖导入位置，22 项全部通过，页面错误和意外请求均为零。包含待审批恢复/取消、过期、失败后取消、busy 时真实状态轮询、迟到读取、unknown 核对、主机隔离和中英文固定状态/操作区域。见[镜像内网页回归](evidence/image-uninstall/uninstall-ui-report.json)。原功能 52 项交互检查另见 [SDD073](../073-agent-uninstall-progress/validation.md)。
- 两个平台全部 44 个网页 JS/CSS 资源文件名及内容组合 SHA256 均为 `282d0e7f08aa74cc9c8c6350d27b2e16eae8fb74eeb2da2a62109a818cc26c2e`；两个平台分别通过本次卸载入口、状态提示及固定布局打包核对，因此同一组浏览器验证覆盖两平台相同资源。见[平台资源核对](evidence/feature-smoke.json)。
- 根 Compose 与兼容入口、有/无历史 `LIGHTMONI_IMAGE` 共四种组合均解析为新固定镜像，服务、健康依赖及原命名卷不变。见[Compose 检查](evidence/compose-checks.json)。
- 临时测试容器、卷、网络和 0600 运行凭据文件已清理；此前运行的 15 个容器保持原 ID 和镜像。见[清理记录](evidence/cleanup.json)。原始日志、构建上下文及验证工具在被忽略目录 `.local-dev/image-release-074/`；截图在被忽略目录 `artifacts/screenshots/specs/074-uninstall-progress-release/`。
- [GitHub Release](https://github.com/workhold/lightmoni/releases/tag/20261101-1c82e6b) 指向同一固定源码，已核对 tag commit 和 Latest 发布回执（见 [Release 回执](evidence/github-release.json)）；根 Compose、部署说明和本验收通过 [发布 PR #61](https://github.com/workhold/lightmoni/pull/61) 交付 main，按用户授权合入，最终状态以 GitHub 回执核对。

## 兼容性、架构与生效

本次只修复网页卸载流程可见性与后续操作，无后端端点、状态转移或存储迁移。远端卸载仍需管理员审阅确认，unknown 仍显式只读核对，不自动重放。浏览器回归的 HTTP 全部为隔离 fixture，不能据此宣称用户远端主机卸载成功。

发布没有重建生产中心、操作用户主机、升级既有 Agent 或业务容器。现有部署沿用原 Compose 项目、环境与数据卷获取最新 main，再执行 pull/up 更新中心；此次界面修复无需升级 Agent。此前权限能力若要在既有 Agent 生效，仍按原部署说明单独升级。

架构同步：不适用，仅打包 SDD073 既有界面修复，不改变组件职责、服务端控制路径、协议、存储、凭据边界或部署拓扑。仓库 docs/system-design.md 无受影响章节；[Doca 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 无需变更，回读不适用。
