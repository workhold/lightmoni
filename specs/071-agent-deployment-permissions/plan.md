# 设计与契约

1. root 安装/维护流程执行发行包内固定 `deployment-permissions.mjs prepare`：确保非零 GID 的 Docker 系统组存在，准备 `/var/lib/lightmoni-web`，不修改 socket mode，不将用户加入全局额外组。
2. unit 使用 `SupplementaryGroups=docker`、`AmbientCapabilities=CAP_NET_BIND_SERVICE`、仅该 capability 的 bounding set、既有 `NoNewPrivileges` 和只读系统保护；`ReadWritePaths` 仅增加受管公开目录。启动前执行同一 helper 的 `check`，权限检查失败时服务不进入 ready。
3. helper 的 `check` 在真实服务身份下完成临时文件写入、fsync、原子 rename/readback/删除，私有配置只检查可读不输出内容，低端口绑定后立即释放；Docker CLI/socket 检查只返回固定摘要。检查文件不含秘密。
4. 标准数据目录的公开内容统一使用 `/var/lib/lightmoni-web/<data-dir-hash>`；非标准执行上下文保持原兼容默认或显式 publicDir。Nginx body/proxy/FastCGI/uWSGI/SCGI 临时目录显式指向私有受管目录。
5. 包内携带固定 helper；首装与维护器切换前调用 prepare。旧包没有 helper 则保留原行为，恢复/回退仍使用对应原 unit，不新写全局用户组成员或旧数据快照。
6. 验证分层：隔离安装/维护器事务回归；真实 Linux 普通用户、Docker 组、低端口 capability、只读根及受管可写挂载；真实网站静态/代理/配置重载、TLS轮换、回滚与私钥权限。未实际发布/升级用户机器时必须明确记录。

## 权限边界

本次授权覆盖平台托管 Docker/Compose/OpenResty 与网站/证书受管目录。任意外部 systemd 发布目录、用户指定备份或证书导出路径仍需明确绑定，不能由任意任务参数扩大 `ReadWritePaths` 或改写系统文件。Docker 组意味着受信管理员和受信 Agent 脚本，不能把非 root 账户描述为宿主级隔离沙箱。
