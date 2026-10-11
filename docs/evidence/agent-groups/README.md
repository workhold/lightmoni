# Agent 分组、表单任务与目录日志验收

2026-10-11。本次以既有监控工作台的 Ant Design 组件、主题和间距为基线，将 Agent 的任务调整为分组统一下发，用四个 Tab 编辑机器指标、拨测任务、目录日志与上报配置。分组概览显示当前任务及同步状态，机器支持平台改组，接入入口带入所选分组生成安装命令。没有新增设计系统，也没有 JSON 编辑入口。

## 已实现

- 同组共用任务及 revision；首次安装按命令中的分组加入，已有机器以平台保存的组为准，重装/重连和旧组心跳保留平台分配。旧机器迁移到默认分组。默认组、非空组不能删除。
- 机器指标启停、采集项、间隔、指定进程；HTTP/TCP 任务目标、成功码、间隔、超时；每类数据有独立逻辑上报表。关闭机器指标仍可保存拨测、目录任务。
- 目录日志启停、绝对目录、文件名规则、子目录、首次历史读取。新内容按行采集，SQLite 原子保存批次和字节进度；覆盖重启、重命名轮转、截断/文件头变化、半行等待、超长 UTF-8 行分片、队列满后恢复。来源含主机/文件/代次、路径及字节位置，事件时间标记为 observed。
- 接入时选择/搜索分组，Key 默认授权该组的机器、拨测和目录表，也支持显式所有 table。命令使用 `systemd-ask-password` 接收 Key 并经 stdin 保存为 0600 连接配置，页面可单独复制 Key。既有身份、队列和平台改组结果保留。

## 验证结果

最终代码连续三轮页面验证通过，详情分别见 [第 1 轮](verification-1.json)、[第 2 轮](verification-2.json)、[第 3 轮](verification-3.json)。每轮覆盖真实创建/修改与刷新回读、失败保留输入和重试、合法表名/目录校验、秒数转换、两台机器共享任务、平台改组和旧组心跳、关闭机器指标后的保存、分组搜索、入口联动、CLI/Key 复制，以及 1440/750/390 视口；浏览器运行时错误均为 0。原 Key/接入验证同步连续三轮通过，见 [补充记录](../ingestion-table-keys/README.md)。

后端通过：

```sh
go test -race ./internal/agent ./internal/server ./cmd/lightmoni-agent ./internal/auth ./internal/ingest
npm --prefix web run typecheck
sh -n deploy/agent/install.sh
sh -n internal/server/agent-dist/install.sh
```

`TestAgentDirectoryLogsThroughGroupControlAndIngest` 启动真实 Agent Run、分组控制、Auth、SQLite、队列、转发与 Ingest，验证只授权 logs_a/logs_b 的 Key 能接收文件日志；平台改组后新内容写入新表，且没有尝试默认 host/probe 表。ClickHouse 的 HTTP 存储边界为替身。

Linux amd64/arm64 安装包已重新生成，并在隔离的 Linux 容器中验证 SHA256、两个架构的 version/configure/check、指定分组保存和配置权限 0600。容器宿主架构为 arm64，amd64 程序通过模拟执行；未声称真实 systemd 安装、真实 ClickHouse 存储或物理掉电验收。现有运行实例需要加载新主服务与更新 Agent 程序。

## 视觉与交互证据

沿用 Tab 指示条、Modal 展开/关闭、保存加载与结果反馈三处基础动效。[交互录像](interaction-1.webm) 和 [录像接触表](motion-contact.png) 保留实际操作及过渡。主 Agent 自检，未安排独立视觉评审；没有编造评分。

最终桌面截图：`host-form-3.png`、`probe-form-3.png`、`log-form-3.png`、`saving-3.png`、`groups-3.png`、`install-3.png`。窄屏：`form-390-3.png`、`form-750-3.png`、`install-390-3.png`、`install-750-3.png`。已查看桌面、手机长页及目录表单的 [200% 局部](log-form-200.png)，检查中文换行、表单层级、目标表和主动作。

减法处理：移除原远程 JSON 输入和私有配置下载，将手动 revision、毫秒等细节转换为保存版本和秒；列表诊断改成可读状态，分组规则只在摘要与改组操作附近提示，没有额外装饰图像或重复说明。

## 复现

分别运行后端与 Vite：

```sh
go run ./scripts/ingestion-qa
LIGHTMONI_DEV_API_URL=http://127.0.0.1:18882 npm --prefix web run dev -- --port 5178 --strictPort
```

然后依次运行（QA 后端使用临时 SQLite，勿替换为生产实例）：

```sh
LIGHTMONI_QA_RUN=1 node web/src/app/verify-agents.mjs
LIGHTMONI_QA_RUN=2 node web/src/app/verify-agents.mjs
LIGHTMONI_QA_RUN=3 node web/src/app/verify-agents.mjs
```

目录采集的上限、读取权限、UTF-8 分片、copytruncate 检测边界和源文件已删除/覆盖的恢复限制见 [README](../../../README.md) 与 [公共契约](../../contracts.md)。隐藏输入工具的接口依据 [systemd 官方文档源文件](https://github.com/systemd/systemd/blob/main/man/systemd-ask-password.xml)。
