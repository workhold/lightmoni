# 发行与部署设计

通过GitHub PR合入，固定merge commit，使用git archive生成干净构建上下文。分别构建并测试amd64/arm64生产镜像，沿用现有经验证的Dockerfile与发行检查；将已测试OCI原始blob发布到docker.heyphp.com/lightmoni/lightmoni，固定标签不覆盖不同内容，latest保持原值。Docker凭据只由系统凭据助手运行时提供。

通过现有已登录1Panel会话管理部署。先读取当前中心镜像、revision、/data挂载、Compose路径和状态，再备份SQLite、配置、环境与主密钥到主机受保护目录（0700/0600），回读SQLite quick_check。更新镜像引用并仅重建中心服务；健康不通过则恢复原镜像引用与同一数据卷，不删除卷。完整配置、环境及备份不进入仓库。

验证线上容器版本/healthy、公网healthz、挂载一致，使用独立浏览器页只读查看机器容器与文件目录。将发行摘要、备份结果、部署回执与只读UI证据存入本SDD，再通过功能分支PR保存Compose固定标签和验收记录。
