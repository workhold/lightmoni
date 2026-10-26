# SDD 023：镜像发布与管理员运维命令

## 目标

将包含本次管理员命令的中心镜像发布至 `docker.heyphp.com/lightmoni/lightmoni`，提供固定标签与 `latest`。根据用户追加要求，根 Compose 默认同时启动中心与 ClickHouse，容器地址和共享数据库账号通过环境变量接入；旧随附目录继承根配置。提供无默认密码的管理员初始化及密码恢复脚本。

## 行为与验收

- 镜像包含现有网页、SDK、双架构 Agent 与 `lightmoni-admin` 命令；发布 Linux amd64/arm64 中心镜像，并分别执行启动/账户检查。
- 默认 Compose 使用注册表固定版本；源码构建保留为显式 `--build` 选项；卷名、端口、ClickHouse 连接和非 root 用户兼容。
- 根目录与兼容部署目录均提供可复制的 `.env.example`，集中说明镜像、项目名、宿主监听地址/端口、外部访问地址和 ClickHouse 账号；明确宿主端口与容器固定 8080 的区别，以及修改端口后同步访问地址的要求。
- `init --name <name>` 仅在 users 为空时创建启用管理员；已有用户时拒绝，不覆盖或提权现有成员。
- `reset-password --name <name>` 仅重置已有管理员，保留角色、启用状态、ID、其他用户和其他数据，并在同一事务撤销该用户所有 session。
- 密码通过无回显终端双次输入，自动化支持 `--password-stdin`；至少 8 个 Unicode 字符、最多 72 UTF-8 字节；不接受明文密码参数，不输出密码/哈希。失败退出非零。
- 使用与中心一致的 `LIGHTMONI_DATA`（默认 `.lightmoni`，容器 `/data/state`）、SQLite WAL、权限和 bcrypt；不依赖 ClickHouse或启动 HTTP/AI worker。重置不存在的数据目录时拒绝并不创建空库。

## 架构影响

适用：新增受本机/容器执行权限保护的运维入口，直接写入既有 SQLite 身份及 session 表；不新增 HTTP 后门。同步 `docs/system-design.md` §20.1/20.4 与 Doca 系统设计基线，并记录最新版本回读及既有图块保留核对。发布地址调整沿用现有中心 + ClickHouse 拓扑。

环境示例补充的架构同步不适用：只整理现有变量及默认值说明，不改变运行环境变量契约、监听映射、组件、存储、凭据用途或部署拓扑。
