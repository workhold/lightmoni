# Logo 与 YAML 版本发布验收

日期：2026-11-01。用户已授权全部本次提交经 PR 合入 main、推送 GitHub 并发布 Docker。

## 发布内容

`docker.heyphp.com/lightmoni/lightmoni:20261101-46a4ac1` 与 `latest` 回读相同 OCI 索引 `sha256:7006119fd48e287f6834c921eeef44a87edc47667180cb315f238e42aec9fbc0`，支持 linux/amd64、linux/arm64。固定源码 `46a4ac11c50de7fc48790744a462c871d8172df5`，包括功能 [PR #56](https://github.com/workhold/lightmoni/pull/56) 全部提交，见 [feature-merge.json](evidence/feature-merge.json)。从合入 main 的 git archive 构建生产网页、中心、双架构 Agent 和四种 SDK，构建输入、上下文摘要、工具 SHA 与镜像材料见 [build-inputs.json](evidence/build-inputs.json)。

## 验证

- 两平台各 26 项实际生产容器检查通过，连接真实临时 ClickHouse，以非 root 运行；管理员 CLI、登录、31 项目录、网页、证书/密钥、Agent/SDK 下载与摘要、平台命令和 AI 模块均通过。
- 真实认证 HTTP/SQLite 原子创建 Logo 和托管 YAML；PNG MIME、安全头、私有缓存、认证和 ETag 通过；修改 YAML 接受既有环境占位、宿主端口仍由托管控制；Logo 替换、移除和版本冲突不改变配置修订。空集群与禁用应用仅用于本地验收，不派发远程 Agent 任务。
- 生产打包单容器 YAML 模块验证手动宿主映射生效、托管归零、保持类型/挂载且不保存原始 YAML；网页资产包含高级编辑、上传/默认 Logo、本地品牌图与许可入口。详见 [container-smoke.json](evidence/container-smoke.json)。更完整的四组浏览器与源码验收见 [SDD 068](../068-application-logos/validation.md)。
- 31 个 OCI blob 的 SHA256、大小与实测 rootfs/config 已核对；远端 manifest/config/index 回读一致。独立 Docker CLI 重新拉取两个平台后内容与实测一致，见 [registry-summary.json](evidence/registry-summary.json) 与 [verified-release.json](evidence/verified-release.json)。
- 23 个历史固定标签摘要全部保持；新固定标签拒绝异内容覆盖，latest 发布前核对未并发变化，见 [historical-tags.json](evidence/historical-tags.json)。
- 根 Compose/兼容入口、有/无旧 LIGHTMONI_IMAGE 四种组合通过，默认镜像固定为本版本，健康依赖及卷保持，见 [compose-checks.json](evidence/compose-checks.json)。
- 本轮运行/停止容器、网络、卷和临时权限 0600 的运行凭据均清理，无关既有服务保持，见 [cleanup.json](evidence/cleanup.json)。原始归档及构建日志在忽略目录 .local-dev/image-release-069/，凭据未进入源码、证据、URL 或日志。

## 架构与兼容

本发布 PR 架构同步不适用：仅打包 SDD 068 并更新默认镜像，不新增职责、路径、存储、协议或拓扑。功能架构在同一 PR #56 更新 docs/system-design.md 第 68 节与 [Doca 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)，seq 912 回读 7 个新增段落一致、原有 33 个原生图节点/边/属性保持，见 [068 回读证据](../068-application-logos/evidence/doca-readback.json)。

本次验证生产中心，不等于所有第三方应用业务运行已验收；复杂模板前提沿用 [SDD 066 限制](../066-app-catalog-expansion/validation.md)。保存后显示规范化 YAML，原注释和排版不持久化。镜像发布不会自动重建已有中心、升级 Agent 或业务容器；沿用原 Compose 项目、环境及卷执行 pull/up。本功能不新增 Agent 能力。

[GitHub Release 20261101-46a4ac1](https://github.com/workhold/lightmoni/releases/tag/20261101-46a4ac1) 已发布并指向同一固定源码，见 [github-release.json](evidence/github-release.json)。默认引用和证据通过本发布 PR 交付 main，按用户既有授权合入，实际状态由 GitHub 回执核对。
