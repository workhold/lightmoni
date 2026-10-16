# Agent 接入与断网恢复

平台接入：在“数据接入 → Agent 接入”选择分组、从内网/公网地址列表选择上报入口并填写 Key，复制完整安装命令。命令已携带下载鉴权和上报 Key，无需再次手工粘贴。分组任务在“Agent”页以机器指标、拨测任务、目录日志、上报配置四个 Tab 编辑，同组统一下发，无需编辑 JSON。

开发运行也可以让 CLI 自动保存连接配置（仅连接信息保存在本机）：

```sh
read -r AGENT_REPORT_KEY
printf '%s' "$AGENT_REPORT_KEY" | go run ./cmd/lightmoni-agent configure --config ./agent-config.json --endpoint http://127.0.0.1:8080 --group-id default --key-stdin --require-data-dir ./agent-data
unset AGENT_REPORT_KEY
go run ./cmd/lightmoni-agent check --config ./agent-config.json
go run ./cmd/lightmoni-agent run --config ./agent-config.json
```

同机两个业务分别使用 `service=order-api` 和 `service=worker`，`table=business`、`endpoint=http://127.0.0.1:4318`。业务 SDK 不配置主服务 Key；Agent 使用一个上报 Key 上报两份数据。Key 不属于 service，主服务记录实际认证的 Key 来源。更换配置中的上报 Key 后重启 Agent，已有持久批次 ID 和内容保持不变。

`go run ./cmd/lightmoni-agent status --config ./agent-config.json` 显示积压、receipt、quarantine 和 collector 状态。业务 SDK 到 Agent 的成功确认表示 SQLite `synchronous=FULL` 提交完成；主服务确认后 Agent 回收 spool，receipt 保留至少配置的保证窗口。业务 SDK 尚未得到 Agent ACK 的内存数据可能随业务进程崩溃丢失。

可停止主服务，发送日志与多维计数，然后重启 Agent 和主服务，确认补传保留原始时间。队列满时 Agent 返回 503，不静默删除已经确认的数据。永久拒绝或超龄批次进入 quarantine：

```sh
go run ./cmd/lightmoni-agent quarantine --config ./agent-config.json
go run ./cmd/lightmoni-agent quarantine --config ./agent-config.json --action retry --id BATCH_ID
# 确认该批次确实无需保留后，显式记录一次丢弃：
go run ./cmd/lightmoni-agent quarantine --config ./agent-config.json --action discard --id BATCH_ID --confirm-data-loss
```

主机数据默认 table=host、service=lightmoni-agent；Agent 队列状态使用同一机器指标表，HTTP/TCP 拨测默认 table=probe，目录日志默认 table=files；可按分组修改。进程仅采集配置的 `process_names` 通配符，每个匹配器最多 8 个进程；不会上传完整命令行。采集权限不足和网络/TLS/超时有独立状态，不伪装为正常零值。

容器中的 `127.0.0.1` 指该容器。Linux 可选择宿主网络连接 loopback Agent，或者显式将 Agent 绑定受限宿主地址并配置 `local_token`。SDK 的 Key 此时仅用本地 token，主服务私有 Key 仍只在 Agent 配置。避免将宿主接收端口默认开放到公网。

固定版本发布与 Linux 安装：

```sh
sh deploy/agent/release.sh 0.1.0 dist/agent
sudo sh deploy/agent/install.sh --release-dir dist/agent --config /path/private-agent-config.json
# 在线安装使用平台生成的完整命令，由当前项目提供鉴权下载。
sudo sh deploy/agent/uninstall.sh
```

默认重装/卸载保留配置、机器身份及 spool；卸载无需访问主服务。`--purge` 明确删除缓存，可能丢失已经由 Agent 接收但未送达的数据。正式镜像内置安装脚本、amd64 / arm64 Agent 包与 SHA256 校验文件，通过当前项目的 `/downloads/agent/` 下载接口提供，并以有效上报 Key 鉴权。本地开发或自定义版本可运行上述发布脚本生成内置包。


目录日志在分组中填写例如 `/var/log/nginx`、`*.log*`，根据需要开启子目录。默认跳过首次发现的现有内容，只读新增行；首次从头开关可导入已有日志。读取进度与日志队列原子保存，重启不会重复读取已入队内容。轮转建议重命名，避免快速 copytruncate 保持相同文件头导致无法识别。目录与文件需允许 `lightmoni-agent` 服务用户读取；检查平台机器详情的“采集状态”定位路径、权限或数量限制问题。日志是 UTF-8 逐行文本，压缩文件、符号链接不采集，超长行分片。事件时间为采集时间，原始业务时间不会自动解析。
