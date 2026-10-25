# Docker main 对齐验收

2026-10-25，main 应用基线 `2a35bf0`，Docker 原生 Linux arm64。

完整镜像构建、两种 Compose、管理员/网页/只读查询、真实日志写入与容器重建后的持久化通过；四种 SDK 与双架构 Agent 的 HTTP 下载及 SHA256 通过。当前 `18380` 实例已升级到 `lightmoni:main-2a35bf0-20261025`，保留用户、大盘、目录、命名卷与主密钥，改由仓库标准 Compose 管理。数据库凭据已轮换，旧值被拒绝。

机器可读结果见 [report.json](report.json)，规格与边界见 [SDD 022 验收](../../../specs/022-docker-main-alignment/validation.md)。备份和真实配置留在本地受限的 git 忽略目录；本目录不包含凭据、运行时环境或原始数据库。

架构同步不适用：仅修正构建与既有部署的运维使用，中心 + ClickHouse 拓扑和运行边界不变。中心 amd64 镜像、宿主 systemd 安装及真实模型调用不属于本次验证范围。
