# 机器地址与本机镜像版本发布

用户持续授权全部推送 GitHub、经 PR 合入 main 并更新 Docker。SDD 064 已通过 PR #51 合入，固定源码 eb62ca6c1945a78726402d0949c1e258ce9f0638。发布 docker.heyphp.com/lightmoni/lightmoni:20261101-eb62ca6 与 latest，支持 linux/amd64、linux/arm64；每个平台完整包含网页、Agent和SDK，并真实启动验收。

发布前后核对摘要、平台、source revision、远端回读与重新拉取；保留历史固定标签。默认 Compose、部署文档与证据通过功能 PR 合入。既有生产中心或 Agent 不因镜像发布自动更新。

架构同步不适用：仅打包已合入的 SDD 064 实现与更新默认引用，不增加组件、数据/控制路径、协议、存储或凭据边界。沿用 docs/system-design.md 第64节及同一功能 PR 的 Doca 回读证据。
