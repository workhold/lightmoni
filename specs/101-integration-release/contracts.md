# 发布契约

- 主仓库与合入：github.com/workhold/lightmoni，origin，目标 main，仅 PR 合入。
- 镜像：docker.heyphp.com/lightmoni/lightmoni；固定标签与 OCI revision 对应已合入 main 的提交；不覆盖历史固定标签。
- 部署：保留 /opt/lightmoni/lightmoni 的现有环境、Compose 项目 lightmoni、状态及遥测卷；不运行 down -v。
- 验证：/healthz、真实管理员浏览器会话、仪表盘与新增界面；宿主能力需 storage.v2 与 registry.v1，旧回执不冒充新版观测。
- 凭据：仅复用运行时登录与受保护配置；不将密码、token、密钥写入源码、证据或输出。
