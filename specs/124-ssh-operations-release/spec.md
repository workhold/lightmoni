# SDD124：SSH 主动运维 Docker 发布

## 目标

从已合入 #167、#168、#170 的 GitHub `main` 构建固定双架构中心镜像，将根 Compose 固定标签更新到该镜像，在现有生产 1Panel 主机的 LightMoni Compose 项目部署并回读健康状态。

## 要求

- 镜像的 OCI revision 必须为构建输入的 `main` 提交；固定标签不能覆盖已有不同内容。
- 镜像包含 linux/amd64 与 linux/arm64；发布前核对远端索引及成品的中心、Agent 下载入口。
- 生产保留原 Compose、环境、主密钥和卷；先取得 SQLite 一致备份并通过 `quick_check`，只重建 `lightmoni` 服务，不重建 ClickHouse 或其他容器。
- 生产部署以固定镜像摘要和健康接口确认；失败时沿原 Compose 回退，不把未确认的步骤记为成功。
- 记录兼容限制：更新中心不会自动更新已安装 Agent；需要 SSH 更新到支持单次入口的发行包。

## 架构影响

不适用。本次只更换已批准实现的中心及发行包镜像和 Compose 标签，未另改组件职责、协议、控制路径、凭据边界、存储或部署拓扑。架构变化与 Doca 回读已随 SDD123 和 PR #170 完成。
