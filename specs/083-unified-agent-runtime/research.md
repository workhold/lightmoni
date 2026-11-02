# SDD083：外部设计参考与决策

本节记录 2026-11-02 核对的官方语义，只借鉴运行账户、权限与状态边界，不复制外部实现。系统最终契约见 spec.md、plan.md 和 docs/system-design.md 第83章。

## 1. Salt minion：单一程序配置运行账户

官方资料：[minion 的 user 配置](https://docs.saltproject.io/en/latest/ref/configuration/minion.html#user)。`user` 默认 root，表示 Salt minion 进程的运行账户；`sudo_user` 是独立配置，不能把进程运行账户与每次命令的执行身份混为一谈。资料还明确 root 切换 non-root 时必须处理缓存，并调整 PKI 目录的所有权。

采用单一 Agent 配置运行账户、统一程序生命周期的模型。账户切换作为维护计划单独批准，校验状态与真实权限；既有缓存不能直接由低信任账户交给 root 使用。不采用脚本自动 sudo，也不认为改一个配置字段即可从普通进程获得 root。

## 2. systemd：User/Group 是实际系统身份

官方资料：[systemd.exec 的 User/Group](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#User=)。系统服务缺省以 root 运行，显式 User/Group 决定真实 UNIX 账户；附加组来自 NSS 账户数据库，单靠 unit 中的空附加组声明不能代替真实账户组核验。

采用一个 lightmoni-agent.service 的两套固定模板，写明 root 或 lightmoni-agent，启动和心跳核验 UID/EUID/GID。程序、unit 和敏感配置由 root 拥有，未知 drop-in 或可写发行拒绝维护。普通脚本再独立核验执行账户，清空附加组，不继承 root Agent 的权限。

## 3. NoNewPrivileges：限制 exec 增权，不等同业务授权

官方资料：[systemd.exec 的 NoNewPrivileges](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#NoNewPrivileges=)。它阻止进程经 execve、setuid/setgid 或文件 capabilities 获得新权限，但不能阻止已具有权限的进程经 systemd-run 等 IPC 服务请求操作。

普通任务启用 NoNewPrivileges 作为进程边界的一部分；root 模式仍需要中心批准、签名目标、单步在线许可、短租约、资源归属和审计。不能用 NoNewPrivileges 替代 root 作业批准，不能声称任意 root 脚本在沙箱内。

## 4. 本项目方案比较

| 方案 | 取舍 |
| --- | --- |
| 普通 Agent 加独立 root 常驻服务 | 可分离进程，但两套安装、发行、维护和状态给用户造成重复概念；本次取消该部署拓扑 |
| 整个 Agent 统一无条件 root，所有脚本继承 root | 安装表面简单，但普通任务会隐式增权，不采用 |
| 单一 Agent + root/user 账户模式 + 内部签名执行模块 | 采用。复用已审计执行能力和领域适配器，一套安装与维护；普通任务固定普通账户，root 作业仍按精确计划批准 |

首次安装默认 root，用户可取消；计划明确列出 root 模式启用的容器管理、root 脚本和受管主机运维三类能力。启用能力不批准任何具体作业。账户切换保留主机、Agent ID 和业务数据，要求空队列与无未决执行，原账户遥测/配置缓存移入 root 维护备份，新账户重新取配置。升级保留模式，卸载同时清理内部签名状态并在远端确认后撤销授权，不重建第二套常驻服务。

## 5. 验证证据的含义

官方语义用于设计依据，不能替代 Linux/systemd 实测。隔离 Web fixture 只证明表单、冻结计划、角色与恢复交互；真实身份、降权、维护锁、单服务升级/卸载和 Docker 作业需由本 SDD 的运行时与 Linux 验证分别记录。线上发布和用户主机升级另行记录，不将本地检查当作线上已完成。
