# LightMoni Agent 执行节点接入与断网恢复

平台接入：在“数据接入 → 执行节点接入”选择初始任务标签、从内网/公网地址列表选择上报入口并填写 Key，复制安装命令以部署 LightMoni Agent。运行实例称为执行节点，在“节点助手”中绑定多个任务标签；中心下发与任一标签匹配的启用任务，同一任务重复命中只执行一次。任务类型为指标采集、服务拨测和目录日志，在“任务管理”中独立编辑，配置冲突时整体拒绝保存。无匹配任务时内部采集和拨测暂停，业务转发继续。Key 默认填入当前标签匹配的启用任务所需表；空任务标签不会自动授权默认采集表。

旧分组会迁移为同名任务标签和独立任务，已有节点身份、配置参数、目标表及中心分配保留。CLI 的 `--group-id` 继续表示初始任务标签，重连不会覆盖中心保存的多个标签。

Agent 独立运行，由自己的进程管理器或容器编排负责启动、停止和重启，生命周期独立于业务实例。以下 `run` 命令以前台进程运行，收到 SIGTERM 后关闭；网页安装器目前提供 systemd 安装流程。业务通过 SDK 上报，退出时完成自己的 SDK flush/shutdown，Agent 继续运行并处理采集与待补传数据。每个 Agent 实例使用独立数据目录，并在重启或容器重建后保留该目录；多个 Agent 实例不能共用同一队列目录。

中心和 Agent 均使用 Node.js / TypeScript，业务八种 SDK 保留。Linux amd64 / arm64 发布包自带 Node 24.15.0，要求 glibc ≥ 2.28；主机无需预装 Node/npm。源码开发时建议使用 Node 24.15.0，并先在仓库根目录执行 `npm run setup`、`npm run build`。Go 工具链只用于 Go 业务 SDK，不用于运行 Agent。迁移说明见 [SDD 007](../../specs/007-node-runtime-migration/spec.md)。

从仓库根目录运行 CLI，自动保存连接配置（Key 仅保存在本机配置文件）：

```sh
read -r AGENT_REPORT_KEY
printf '%s' "$AGENT_REPORT_KEY" | node runtime/dist/agent/main.js configure --config ./agent-config.json --endpoint http://127.0.0.1:8080 --group-id default --key-stdin --require-data-dir ./agent-data
unset AGENT_REPORT_KEY
node runtime/dist/agent/main.js check --config ./agent-config.json
node runtime/dist/agent/main.js run --config ./agent-config.json
```

同机两个业务分别使用 `service=order-api` 和 `service=worker`，`table=business`、`endpoint=http://127.0.0.1:4318`。业务 SDK 不配置主服务 Key；执行节点使用一个上报 Key 上报两份数据。Key 不属于 service，主服务记录实际认证的 Key 来源。更换配置中的上报 Key 后重启 LightMoni Agent，已有持久批次 ID 和内容保持不变。

`node runtime/dist/agent/main.js status --config ./agent-config.json` 显示积压、receipt、quarantine 和采集器状态。业务 SDK 到执行节点的成功确认表示 SQLite `synchronous=FULL` 提交完成；主服务确认后执行节点回收 spool，receipt 保留至少配置的保证窗口。业务 SDK 尚未得到节点 ACK 的内存数据可能随业务进程崩溃丢失。

可停止主服务，发送日志与多维计数，然后重启 LightMoni Agent 和主服务，确认补传保留原始时间。队列满时执行节点返回 503，不静默删除已经确认的数据。永久拒绝或超龄批次进入 quarantine：

```sh
node runtime/dist/agent/main.js quarantine --config ./agent-config.json
node runtime/dist/agent/main.js quarantine --config ./agent-config.json --action retry --id BATCH_ID
# 确认该批次确实无需保留后，显式记录一次丢弃：
node runtime/dist/agent/main.js quarantine --config ./agent-config.json --action discard --id BATCH_ID --confirm-data-loss
```

主机数据默认 table=host、service=lightmoni-agent；执行节点队列状态使用同一机器指标表，HTTP/TCP 拨测默认 table=probe，目录日志默认 table=files；可在独立任务中修改。进程仅采集配置的 `process_names` 通配符，每个匹配器最多 8 个进程；不会上传完整命令行。采集权限不足和网络/TLS/超时有独立状态，不伪装为正常零值。

容器中的 `127.0.0.1` 指该容器。Linux 可选择宿主网络连接 loopback 执行节点，或者显式将 LightMoni Agent 绑定受限宿主地址并配置 `local_token`。SDK 的 Key 此时仅用本地 token，主服务私有 Key 仍只在 LightMoni Agent 配置。避免将宿主接收端口默认开放到公网。

固定版本发布与 Linux 安装：

```sh
npm run release:agent -- 0.1.0
sudo sh deploy/agent/install.sh --release-dir runtime/downloads --config /path/private-agent-config.json
# 在线安装使用平台生成的完整命令，由当前项目提供鉴权下载。
sudo sh deploy/agent/uninstall.sh
```

默认重装/卸载保留配置、机器身份及 spool；卸载无需访问主服务。`--purge` 明确删除缓存，可能丢失已经由执行节点接收但未送达的数据。正式镜像内置安装脚本、amd64 / arm64 自带 Node 的 LightMoni Agent 包与 SHA256 校验文件，通过当前项目的 `/downloads/agent/` 下载接口提供，并以有效上报 Key 鉴权。本地开发或自定义版本可运行上述发布脚本生成内置包，默认输出 `runtime/downloads`。Linux 安装器将应用和运行时安装到 `/opt/lightmoni-agent`，systemd 启动独立的 `lightmoni-agent` launcher；业务进程退出不停止该服务。本次 macOS 验证包含 Node Agent 队列和真实 ClickHouse 联调，未执行 Docker 镜像构建或 Linux systemd 实机安装，见 [验证记录](../../specs/007-node-runtime-migration/quickstart.md)。


目录日志任务中填写例如 `/var/log/nginx`、`*.log*`，根据需要开启子目录。默认跳过首次发现的现有内容，只读新增行；首次从头开关可导入已有日志。读取进度与日志队列原子保存，重启不会重复读取已入队内容。轮转建议重命名，避免快速 copytruncate 保持相同文件头导致无法识别。目录与文件需允许 `lightmoni-agent` 服务用户读取；检查平台执行节点详情的“采集状态”定位路径、权限或数量限制问题。日志是 UTF-8 逐行文本，压缩文件、符号链接不采集，超长行分片。事件时间为采集时间，原始业务时间不会自动解析。

可先运行 `npm --prefix runtime run typecheck` 和 `npm --prefix runtime test`。针对隔离中心的真实链路测试从 `runtime` 目录运行：

```sh
LIGHTMONI_DOMAINS_URL=http://127.0.0.1:18885 node --import tsx --test test/agent-live.test.ts
```

账号使用 `LIGHTMONI_DOMAINS_USER` / `LIGHTMONI_DOMAINS_PASSWORD` 指定，不要指向生产中心；未提供 URL 时该测试默认跳过。
