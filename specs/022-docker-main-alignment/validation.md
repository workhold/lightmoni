# SDD 022：验收记录

2026-10-25，在 Linux arm64 Docker Desktop 中完成；应用源码基线为 main `2a35bf025a821c683bd1854c9a89555913ca4243`。运行时、SDK 与网页源码相对 main 没有修改。

## 配置与构建

- 根 Compose 和随附 ClickHouse 的 Compose 均能解析，后者继承五个构建参数；未指定可选项时仍使用官方源与 `unknown` revision。
- 缺少数据库 URL 或密码会拒绝配置，随附 ClickHouse 没有宿主端口。
- npm 源、Node 归档源与 Debian 两个源可以独立覆盖。四组 Debian/security 覆盖组合通过；六种不合法 Node 镜像 URL 在网络请求前拒绝，错误不回显输入中的凭据。
- 最新 Dockerfile 完整构建成功。Node 原生依赖使用构建镜像自带头文件；Node 双架构归档从可选镜像下载，仍核对官方发行站 SHA256。
- 最终镜像为 `lightmoni:main-2a35bf0-20261025`，OCI revision 与应用 main 基线一致；运行用户为 UID 10001，Node 24.15.0，SSH 工具存在，状态卷可写。

## 独立实例

- 两容器健康，管理员初始化/登录、9 个网页静态资源、目录与只读 SQL 正常。
- 真实日志写入 ClickHouse 后可查询；保存上报地址后重建两个容器，原用户、地址设置与日志均保留。
- 改用根 Compose 连接已运行的 ClickHouse 后再次验证通过；最后镜像也单独重新创建中心并通过读回。
- 四种 SDK 与双架构 Agent 均可通过 HTTP 下载并通过 SHA256；Agent 包含当前执行器；Linux arm64 中实际执行包内 Node 启动器成功。
- 中心、Agent 执行器、SDK 周期模块与 AI worker 的编译文件哈希均与 main 本地构建一致。

## 现有 Docker 更新

- `http://localhost:18380` 已由旧 `record-20261019` 更新为上述 main 镜像，中心与 ClickHouse 健康。
- 实例沿用 `lightmoni-acceptance` 项目、两个原命名卷与加密主密钥。SQLite 中原 1 个用户、5 个大盘和 19 条目录记录保留；原管理员登录、只读查询和新服务部署 API 通过。
- 更新前停止两个容器，分别备份状态卷与整个 ClickHouse 卷；备份和回滚 `.env`/脚本位于本地 git 忽略目录并设为 0600/0700。旧镜像保留，回滚脚本语法检查通过，未执行破坏性回滚演练。
- 当前标准配置为 `deploy/with-clickhouse/compose.yaml` 和受限 `.env`；历史实际使用的临时 JSON 已改为包含标准配置的入口，不再嵌入凭据或旧镜像。
- 数据库密码已轮换，当前与回滚配置同步更新；旧密码被拒绝。管理员应用密码、主密钥与 SDK/Agent 凭据用途不变。
- 更新后重新创建容器再次验证通过；四种 SDK、两个 Agent 下载与主干文件哈希再次核对成功。

机器可读证据：[report.json](../../docs/evidence/docker-main-alignment/report.json)。

## 架构同步与边界

不适用：执行既有中心 + ClickHouse 拓扑，只改变公开构建源、镜像修订号与运维配置使用；没有新增运行组件、接口、存储、凭据用途或工具权限边界。不修改仓库系统设计或 Doca，也不声称执行 Doca 写入。

本次中心镜像只在 Linux arm64 构建/运行；Agent 两种架构均检查归档与 ELF，实际启动只运行 arm64。未执行 Linux 宿主 systemd 安装、真实模型供应商调用或远程主机任务。

## 合入

提交前已重新 fetch main 并确认仍为上述基线；相关配置、构建与运行检查通过。配置修正位于 `codex/docker-main-alignment` 功能分支。

2026-10-26 使用本地已登记的 SSH 密钥，通过 Gitea AGit 提交并取得 [PR #26](https://gitea.heyphp.com/lightmoni/lightmoni/pulls/26)，目标为 `main`；远端 `refs/pull/26/head` 已核对与提交一致。无需网页登录或另行提供 API token，尚未合入主干。
