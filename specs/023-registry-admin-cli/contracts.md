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
