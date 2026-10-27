# SDD 024：安装契约

- CLI 参数、发行版本、包名、路径及 HTTP API 均保持现状。
- `/opt/lightmoni-agent`、`releases` 及 `<release>` 的安装 runtime：目录 0755；普通非可执行文件 0644；已有执行位的文件 0755。文件继续由安装 root 持有，非 root 服务只读。
- `/etc/lightmoni-agent`、`/var/lib/lightmoni-agent` 与配置/identity 权限不放宽，凭据不进入 runtime。
- `systemctl restart` 非零直接失败；成功后观察最多10次，每次间隔1秒，需要连续两次 active。超时原样回滚；不声明中心 readiness。
- 失败输出含固定阶段码与固定属性名；不自动输出原始日志或供应商/中心错误。`systemctl show` 失败不能掩盖主错误或阻止恢复。
- first-install 失败后新 unit/launcher/current 移除，旧安装失败后原启用/运行状态恢复。enrollment 已激活后的服务器凭据状态不在文件回滚保证内，重新安装需平台新建 token。
