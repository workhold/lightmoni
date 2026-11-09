# 应用备份与 LightMoni 迁移

当前交付是管理员离线工具 `lightmoni-backup.py`。应用“更多操作 → 备份应用”和“系统设置 → 备份与迁移”提供工具下载、摘要及操作步骤。归档由主机生成，再通过管理员现有文件传输通道下载；浏览器不接收 Docker 权限、云存储密钥或归档中的秘密。不提供后台一键跨主机快照，也不会替用户安装生产备份计划。

## 准备

需要 Python 3.9+、Docker CLI/Compose 和当前 Docker daemon 的明确管理权限。准备一个本机已存在、包含 `/bin/tar` 的可信 helper 镜像；工具解析为精确 image ID，不自动拉取。helper 只挂载本次数据源，不挂载 Docker socket，禁网、只读根文件系统。

下载工具后核对页面 SHA256。归档含运行环境变量、密码，完整部署还含主密钥；输出文件0600、工作目录0700。输出目录必须与全部数据源互不包含。没有 `--execute --confirm-stop` 的 export 只预览，不停机或写文件。

## 应用备份

先在平台停止应用，避免中心自动恢复与快照竞争；备份期间暂停该应用的部署操作。应用 ID 从备份入口复制，同机全部现存实例一起发现。多机器分别导出，每份明确属于本机，不宣称全局原子快照。

```sh
python3 lightmoni-backup.py export --application <应用ID>
python3 lightmoni-backup.py export --application <应用ID> \
  --helper-image <本机可信tar镜像> --execute --confirm-stop \
  --include-images --output /root/backups/application.lmb.tar.gz
python3 lightmoni-backup.py verify /root/backups/application.lmb.tar.gz
```

通过 Docker inspect 校验平台 owner/application 标识，收集全部服务的持久目录与命名卷、去重共享挂载。其他运行容器仍使用某数据源时拒绝。归档包含完整原始容器检查、可恢复的 Compose JSON（也是有效 YAML）、数据源映射、各文件摘要和可选镜像。没有256MiB内存归档限制；文件内容流式写入，保留 uid/gid/mode、相对符号链接和硬链接。

确认后仅停止精确选中容器；拒绝本轮强制杀死而未干净退出的实例。快照前后核对原配置、停机状态及整个窗口的 Docker 启动/销毁事件。部分停机失败或 SIGTERM/SIGHUP 时会核对并恢复原运行容器；原本已停止的不启动，配置被外部修改时要求人工核对。成功的应用备份恢复原运行状态；可用 `--leave-stopped` 明确保持停止。SIGKILL、主机断电或 daemon 不可达无法保证自动恢复，应按原运行清单人工核对。

本轮支持目录型 bind 与命名卷，不保存 tmpfs/容器可写层；拒绝系统路径、特殊文件、逃逸或绝对链接、特权/GPU/宿主命名空间及暂不支持的运行配置。配置/数据/镜像缺失均失败，不发布“完整备份”。源数据包含外部数据库或其他应用依赖时，需另行备份这些系统。

## 恢复

```sh
python3 lightmoni-backup.py verify application.lmb.tar.gz
python3 lightmoni-backup.py restore application.lmb.tar.gz \
  --target-project recovered-app --directory /root/recovered-app \
  --helper-image <本机可信tar镜像> --execute --confirm-empty-targets
```

先验证全部归档字节、路径、链接、平台架构及镜像，再获取 daemon 中项目级排他锁。使用带本次随机标识的新卷，创建后核对标识、无消费者及空内容；不向已有卷解包。每个恢复卷重新归档，逐文件核对内容、属主、权限与链接摘要。失败保留本次卷供检查，不自动删除已有数据。

生成私有 `compose.json` 后保持未启动，工具返回明确启动命令。环境、命令和健康检查中的 `$` 经过 Compose 正确转义；保留已有资源限制、cap_drop、安全选项、停止信号/宽限。源容器原始检查也保留，供审阅。应用恢复为独立项目，不冒充原平台实例或 Agent；需重新审阅接管/登记。未包含镜像的备份要求原精确 image ID 已在目标 daemon 存在，可先按清单中的 RepoDigest 拉取；离线新机应在导出时包含镜像。

## 定期 S3 备份

立即上传已校验归档：

```sh
python3 lightmoni-backup.py upload application.lmb.tar.gz --s3-config /root/s3.json
```

`s3.json` 只写 endpoint、bucket、region、prefix；endpoint使用HTTPS，HTTP只供本机测试。凭据通过受保护运行时环境 `LIGHTMONI_BACKUP_ACCESS_KEY_ID`、`LIGHTMONI_BACKUP_SECRET_ACCESS_KEY`、可选 `LIGHTMONI_BACKUP_SESSION_TOKEN` 提供，不写命令行或配置正文。采用 SigV4、条件PUT拒绝覆盖、完整GET回读大小与SHA256；网络丢失记结果未知，不自动再次写入。当前S3单对象上限5GiB；更大的本地归档需管理员使用已验证的分段上传工具。

定时任务是**本机 root 的持续授权**，独立于平台用户/计划授权。由root把工具放到不可由普通用户修改的固定路径，创建0700归档目录及0600凭据文件；该文件仅允许上述三项 `KEY=VALUE`（值按原样填写，不source、不写额外变量）。脚本、配置、凭据及路径祖先必须root属主、不可组/其他写；root拥有的sticky临时祖先例外。

```sh
python3 /root/lightmoni-backup.py schedule --application <应用ID> \
  --directory /root/lightmoni-backup-schedule \
  --output-directory /root/lightmoni-backups \
  --s3-config /root/s3.json --credentials-file /root/backup-s3.env \
  --helper-image <本机可信tar镜像> --on-calendar daily
```

仅生成service/timer与受保护配置，不安装或启用。管理员审阅停机窗口后，把生成的service/timer复制至 `/etc/systemd/system/`，运行 `systemctl daemon-reload` 和 `systemctl enable --now <生成的timer名称>`。采用主机时区，错过不补跑，文件锁防重叠。Python隔离模式启动，凭据文件只解析白名单，不使用systemd EnvironmentFile，不继承Docker网络/动态加载环境。查看 `systemctl status` / `journalctl -u <生成的service名称>` 的校验结果。停用timer并停止当前任务可撤销本机计划；平台禁用用户不会替代这项本机root操作。

平台原有 operation-schedules 的备份仍使用平台持久授权，本次修复其真实authorizer及不可丢失的计划来源绑定，派发、领取、开始前重新核对启用状态、计划/资源版本和管理员有效性；两种授权不得混称。

S3契约依据：[PutObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html)、[条件写入](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)、[单次上传与完整性](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html)。当前仅实测本机HTTP验签服务，未声称验证真实云供应商。

## LightMoni 整体迁移

标准部署含 `lightmoni` 和 `clickhouse` 两个服务、中心 `/data` 与遥测 `/var/lib/clickhouse`。先暂停生产发布/维护操作，再在原主机运行：

```sh
python3 lightmoni-backup.py export --project <原Compose项目名>
python3 lightmoni-backup.py export --project <原Compose项目名> \
  --helper-image <本机可信tar镜像> --execute --confirm-stop \
  --output /root/backups/lightmoni-migration.lmb.tar.gz
```

按中心→ClickHouse顺序干净停止，导出完整state/master.key/SQLite及遥测卷和精确镜像。成功后旧中心保持停止，防止两套调度器并行；导出失败会尝试恢复原运行状态。外部ClickHouse、非标准服务集合、不同目标架构会明确拒绝。

将归档经管理员安全通道传到新机器，核对源端SHA256，按上述restore恢复为新项目。不要复制旧主机Agent/执行器的安装身份。启动前检查端口、外部地址与域名、内外网路由和存储容量；保持原域名时需在验证后切换DNS，地址变更则按既有设置/Agent维护流程更新。

启动后核对：健康、原管理员登录、SQLite quick_check、主密钥解密原凭据、ClickHouse历史数据、SDK上报和原节点重连；原未完成/unknown任务应保留核对，不能清空后声称迁移成功。保留旧卷和归档。验证失败先停止新中心，再按原项目启动旧中心，避免双中心；工具不自动回滚数据库或覆盖旧卷。
