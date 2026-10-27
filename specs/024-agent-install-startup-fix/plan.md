# SDD 024：实施设计

1. 在当前脚本的 runtime 复制后显式设置 `u=rwX,go=rX`，使目录可遍历、代码可读、原可执行文件可执行，group/other 不可写；显式创建/修正 `/opt/lightmoni-agent` 和 `releases` 为 0755，避免已有 root-only 父目录阻断访问。不修改 `/etc/lightmoni-agent` 与 `/var/lib/lightmoni-agent` 的 0700/0600 权限。
2. 用固定阶段标识区分 systemd reload/enable/restart/startup-check。启动观察函数最多 10 次（1 秒间隔），连续两次 active 才通过，失败仍进入原事务回滚。轮询不发网络请求。
3. finish 在回滚前采集仅固定 systemd 字段，诊断失败不更改原退出状态或回滚逻辑；给出本机 journalctl 命令，不自动读取日志。
4. 扩展真实 `/bin/sh` 安装器 fixture，构造 nested runtime JS 与可执行文件；模拟服务用户按权限读取最终安装路径，在旧实现上复现失败，在新实现上通过。覆盖延迟启动、短暂 active、持续 inactive、restart 失败、show 失败以及既有升级回滚。
5. 运行定向测试、shell 语法与类型检查，再运行 runtime 回归。更新部署说明与验收证据，通过独立 PR 交付，不合并或发布到用户服务。
