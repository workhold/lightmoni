# SDD 023：设计

1. 抽取现有 users/sessions 建表和密码校验至共享认证账户模块；HTTP 初始化/登录行为不变。运维 CLI 只创建/访问这两张既有表，不初始化主密钥或其他运行模块。
2. CLI 解析严格子命令和选项，先校验操作及输入，再打开同一 SQLite。密码哈希在事务外计算，事务内重查空库/管理员角色，使用绑定 SQL 插入或更新并撤销会话。遵循 busy_timeout，冲突整体回滚。终端通过 raw mode 读取隐藏输入、处理取消和恢复状态；管道读取单行 UTF-8 且限制总字节。

并发验收发现初次打开 SQLite 时 WAL 转换可能先于 busy_timeout 而竞争失败。共享 DB 在 WAL 转换前设置既有 5 秒超时，并在初始化异常时关闭 native handle，避免失败连接持锁；其他 SQL 和存储策略不变。
3. 镜像安装可执行 shell 包装器 `lightmoni-admin`，调用编译后的 CLI；本地 npm 提供同一入口。Compose 保留 build 并增加 missing 拉取策略，默认固定发布标签，启动脚本与文档改为 pull + up --no-build。
4. 在隔离临时数据目录和 Docker 命名卷验收，不改现有部署/账号。构建来源使用已有公开镜像参数，按架构构建并验证后推送，最后建立双架构 manifest 与 latest。
5. 同步仓库/Doca 运维章节，保存回执并回读；记录测试、发布 digest、源码 revision 和限制。功能分支提交 PR，未经授权不合并。

用户追加要求：根 Compose 纳入既有 ClickHouse 服务，中心默认 `LIGHTMONI_CH_URL=http://clickhouse:8123`，两端复用 `LIGHTMONI_CH_USER/PASSWORD`，健康依赖与状态/遥测命名卷和原随附配置保持一致。`deploy/with-clickhouse` 同时继承两个服务，作为已有部署入口兼容；不对宿主机开放 ClickHouse 端口。

环境示例补充：两份 `.env.example` 优先展示部署所需的镜像、监听地址、宿主端口、外部访问地址和数据库账号，源码构建参数放在后面；README 提供变量表及修改为 18080 的示例。通过两份真实示例解析 Compose，核对默认值、端口覆盖、数据库变量一致性和空密码拒绝。此补充为配置说明整理，架构同步不适用，不重建镜像。
