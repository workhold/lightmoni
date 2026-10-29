# LightMoni Agent 运行与断网恢复

Agent 接入统一从“主机管理”发起：同屏登记名称及 SSH 目标地址、端口、用户名、密码或私钥和保存时长，默认密码登录、保存 6 小时；也可只登记后补凭据。主机公钥指纹用于核验远端身份，不能替代密码或私钥，不随登录凭据到期删除。有限保存到期/撤销清除，永久保存须明确确认、直到撤销，二者均加密保存且不因 Agent 激活提前清除；建议优先短期保存。核对指纹、执行预检并审阅计划后，由平台安装。平台内部生成预绑定主机 ID 的一次性 enrollment，随后签发 Agent 独立 control/data 凭据。不再提供独立脚本安装、共享上报 Key 控制或手工主机关联；源码启动命令不能创建有效平台身份。完整步骤和凭据边界见 [部署与恢复](../../docs/agent-deployment.md)、[系统设计](../../docs/system-design.md#133-当前登记主机与-agent-身份一体化sdd-038)、[SDD 038](../../specs/038-registered-host-agent-onboarding/spec.md) 与 [保存时长](../../specs/039-host-registration-credential-retention/spec.md)。

Agent 独立于业务生命周期运行。平台安装 Linux amd64/arm64 systemd 服务，发行包自带 Node 24.15.0、要求 glibc ≥ 2.28；容器发布、自动 sidecar/DaemonSet 注入未实现。中心与 Agent 均为 Node.js / TypeScript，发布语言矩阵以 [SDK 说明](../../sdk/README.md) 与接入页为准。

## 源码开发入口

先在仓库根执行 `npm run setup` 和 `npm run build`。已有受管主机配置和独立身份的 Agent 可以以前台方式运行：

```sh
node runtime/dist/agent/main.js check --config /path/private-agent-config.json
node runtime/dist/agent/main.js run --config /path/private-agent-config.json
```

`run` 收到 SIGTERM 后关闭，不能与使用相同状态目录的 systemd 实例同时运行。独立实例不得共用或克隆身份、队列；重启原实例保留持久目录。未配置主机预约的旧身份不能通过共享 SDK Key 接入，不自动补建主机。

业务 SDK 默认使用中心地址和 SDK Key 独立上报，不依赖 Agent。本地 OTLP 接收仅作为显式使用的 Agent 能力；配置时使用 Agent 的本地接收地址及 local token，Agent 上游使用自己的 data 凭据，业务不持有 Agent 控制秘密。Agent 可使用相同 TypeScript SDK 为自身采集与任务打点。

## 本地状态与队列

`status` 显示积压、receipt、quarantine 和采集器状态。`check` 只验证本地配置，不代表中心鉴权、网络、任务和数据上报均正常：

```sh
node runtime/dist/agent/main.js status --config /path/private-agent-config.json
```

Agent 在 SQLite 持久化后才确认已接收批次；中心确认后回收 spool，receipt 保留有界保证窗口。SDK 尚未得到确认的内存数据可能随业务崩溃丢失。队列容量、最大重放年龄和存储空间均有限，满队列返回 503；永久拒绝或超龄批次进入 quarantine，不静默删除已确认数据。

隔离区维护前停止 Agent，避免并发修改队列：

```sh
node runtime/dist/agent/main.js quarantine --config /path/private-agent-config.json --action list
node runtime/dist/agent/main.js quarantine --config /path/private-agent-config.json --action retry --id BATCH_ID
```

只有接受数据丢失后才使用 `--action discard --id BATCH_ID --confirm-data-loss`。维护后重启服务并核对实际中心数据，不通过删除 queue 文件解除容量压力。

## 任务和日志

任务在主机工作区独立管理，Agent 和任务可绑定多个标签，任一标签相交就下发，重复命中只执行一次。无匹配任务时内部采集/拨测暂停，冲突配置整体拒绝。任务标签不授予 SSH 或任意命令执行权限。机器指标、拨测和目录日志默认逻辑表为 `host`、`probe`、`files`。

目录日志使用明确绝对目录、文件匹配与读取权限；默认只采集首次发现后新增的内容，后续新文件完整采集。读取进度与日志队列原子保存，支持重启续读、重命名轮转和截断检测。服务用户必须有目录遍历和文件读取权限；仅采集 UTF-8 文本行，跳过压缩文件和符号链接，超长行分片。事件时间为采集时间，原始业务时间不自动解析。

## 构建、测试与卸载

维护发行物使用 `npm run release:agent -- 0.1.0`；构建 Linux 包不代表已完成 Linux 运行验收，也不是用户独立接入入口。安装/卸载脚本由平台固定流程调用，用户从主机管理审阅并确认卸载；删除主机记录不会停止远端 Agent，且有效 Agent 身份必须先移除。网页卸载保留身份、配置与队列用于核查，不开放 purge。

本地检查：

```sh
npm --prefix runtime run typecheck
npm --prefix runtime test
```

隔离真实中心测试可从 `runtime` 目录运行：

```sh
LIGHTMONI_DOMAINS_URL=http://127.0.0.1:18885 node --import tsx --test test/agent-live.test.ts
```

使用 `LIGHTMONI_DOMAINS_USER` / `LIGHTMONI_DOMAINS_PASSWORD` 指定隔离账号，不指向生产中心；未提供 URL 时默认跳过。实际覆盖与未验收边界以对应 SDD 记录为准。
