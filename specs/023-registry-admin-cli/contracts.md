# SDD 023：契约

```sh
lightmoni-admin init --name admin
lightmoni-admin reset-password --name admin
lightmoni-admin init --name admin --password-stdin
node runtime/dist/server/admin-cli.js reset-password --name admin
```

- `--help`/`-h`：打印用法，不访问数据库，退出 0。
- 仅支持 `init`、`reset-password`；必须显式 `--name`，非空且不含控制字符；拒绝重复/未知/缺值选项。用户名保持精确匹配，不自动改名。
- 默认需要 TTY 隐藏读取并确认密码；`--password-stdin` 接收一行 UTF-8（可有末尾 LF/CRLF），多行、空输入、非法长度拒绝；管道输入有界。密码不放 Compose env、镜像层、参数或日志。
- 成功输出固定成功提示，退出 0；失败输出固定错误提示，退出 1，不回显 SQL/密码/哈希或原始异常。
- 使用 `LIGHTMONI_DATA/lightmoni.db`；`init` 可新建，已有任意用户退出失败；`reset-password` 要求既有库与管理员，不更改 active，不创建用户、不提升 member。
- HTTP 路由、现有存储结构、bcrypt cost=10、密码范围及用户 session 模型兼容。
- 发布仓库 `docker.heyphp.com/lightmoni/lightmoni`；默认标签 `20261026-admin`，同时提供 `latest`。架构 Linux amd64/arm64，OCI revision 对应提交；现有环境可通过 LIGHTMONI_IMAGE 覆盖。
- 根 Compose 包含 `lightmoni` 和 `clickhouse`，默认地址 `http://clickhouse:8123`、账号 `lightmoni`，密码必须由 `LIGHTMONI_CH_PASSWORD` 提供；数据库容器使用同一账号密码环境变量。`CLICKHOUSE_IMAGE` 默认 `clickhouse/clickhouse-server:26.8`，数据库无宿主端口，两个命名卷沿用既有名称。

## 环境配置示例

两份 `.env.example` 使用相同变量与默认值：

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `COMPOSE_PROJECT_NAME` | `lightmoni` | Compose 项目名；既有部署沿用原名以匹配数据卷 |
| `LIGHTMONI_IMAGE` | `docker.heyphp.com/lightmoni/lightmoni:20261026-admin` | 中心镜像 |
| `LIGHTMONI_BIND_ADDRESS` | `0.0.0.0` | 宿主机监听地址，可设为 `127.0.0.1` |
| `LIGHTMONI_PORT` | `8080` | 宿主机端口；容器内部始终使用 8080 |
| `LIGHTMONI_EXTERNAL_URL` | `http://localhost:8080` | 用户访问的完整地址；随实际端口/域名显式修改 |
| `LIGHTMONI_CH_URL` | `http://clickhouse:8123` | 容器网络中的数据库 HTTP 地址 |
| `LIGHTMONI_CH_USER` | `lightmoni` | 中心与 ClickHouse 共用账号 |
| `LIGHTMONI_CH_PASSWORD` | 空，必填 | 中心与 ClickHouse 共用密码 |
| `CLICKHOUSE_IMAGE` | `clickhouse/clickhouse-server:26.8` | 数据库镜像 |

示例不增加运行配置项，不通过 `.env` 设置管理员密码；源码构建源参数仍为可选项。架构同步不适用，理由见 spec。
