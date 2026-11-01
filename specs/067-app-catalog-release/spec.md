# 应用商店扩展版本发布

用户授权本次全部提交经 PR 合入 main、推送 GitHub 并发布 Docker。SDD 066 已通过 PR #53 合入，固定源码 a1292cf5085d77f8f3eef74d9999c02652764c15。发布 docker.heyphp.com/lightmoni/lightmoni:20261101-a1292cf 与 latest，支持 linux/amd64、linux/arm64，内置生产网页、双架构 Agent 和四种 record SDK。

验收生产镜像 31 个应用与六类、工具仅 DBX、参数验证、内置 Agent 初始化能力；核对平台、源码 revision、OCI 摘要、远端回读、独立拉取及历史标签不变。默认 Compose 和部署文档更新后经功能 PR 合入。镜像发布不自动重建用户已有中心容器或升级 Agent。

架构同步不适用：只打包已合入 SDD 066 并更新默认版本引用，不改变组件职责、控制路径、存储、协议、凭据或部署拓扑。沿用 docs/system-design.md 第 66 节与同一功能 PR 的 Doca seq 911 回读、33 个原生图保留证据。
