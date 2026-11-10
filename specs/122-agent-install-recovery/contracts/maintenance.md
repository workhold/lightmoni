# Maintenance Contract

## Footprint

`/etc/systemd/system/lightmoni-agent.service.d` 与 `/etc/systemd/system/lightmoni-agent-helper.service.d` 的存在或链接均表示已有安装；预检与两层 fresh 保护一致。

## Explicit removal

两个目录只在已有确认的卸载/恢复流程清理。父路径、目录和所有子项必须 root 所有且 group/other 不可写；目录内只接受普通文件，包含隐藏文件。拒绝链接、嵌套目录、特殊文件，超过 128 项或单文件超过 64 KiB 时拒绝。程序摘要包含目录和文件证据，确认后变化拒绝；停止服务后重检安全，再清理固定目录。不能波及其他服务目录。成功后服务不存在、覆盖目录消失；已有数据保留策略不变。

## Diagnostics and recovery

既有 SSH 固定诊断允许 agent_service_override_not_allowed，附中文恢复指引，不暴露原始输出。非零派发仍为 unknown。

POST reconcile/resolve 出错或返回不匹配记录时，页面读取同一 machine/deployment 的既有 GET。仅在当前请求代次、原记录引用和主机仍匹配时更新。读回成功解除刷新门槛并保留错误提示；失败/不匹配继续锁定。禁止自动重新派发或自动人工结束。
