# 发布设计

先合入 #33，再在 #34 合并最新 main 并解决 OperationsPage 冲突：同时保留焦点回读、证书申请中快速轮询与签发日志跳转。根类型、57 项相关领域测试以及证书/网站浏览器检查通过后合入 #34。

固定最终主干源码 SHA，以 git archive 导出构建上下文；使用既有 Dockerfile、本机 Docker Desktop 与前次已验收发布工具，完整构建两个平台，保留 npm integrity、Node SHA256 与 Debian 签名验证。验收使用独立 ClickHouse、容器、网络和卷；既有实例不自动升级。

通过 Docker credential helper 在进程内认证，以既有 OCI 分块上传发布固定标签；核对 latest 未并发变化后更新。独立客户端回读双标签、平台 manifest/config/层摘要及长度，按平台重新拉取并比较验收镜像。镜像源码先于最终发布配置提交，后者仅维护版本和证据。

更新 Compose、README、部署说明和文本证据，经 `codex/055-main-image-release` PR 合入；GitHub release 标签绑定构建源码提交，最后本地 main 快进同步。
