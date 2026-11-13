# SDD 133 验收记录

## 行为与兼容

- 管理员点击单机“升级 Agent”后只提交一次 `POST .../agent-updates/start`。服务端使用登记的默认 SSH 凭据和只读远端探测架构，选择该架构最新的已验证发行；内部计划固定摘要与主机现场并立即执行。回退、批次及旧计划链接仍走原审批协议。
- `queued` 且无领取、开始或尝试证据的任务保留队列并等待维护结束；已领取、运行中或 unknown 工作继续阻断维护。`zz-bj-1` 截图体现旧入口“部分操作暂不可用”；本地修复验证了对应门禁路径，但没有直接读取这台生产主机的任务账本，不能把具体现场阻塞来源视为已证实。
- 阶段事件独立持久化，按操作 ID 回读。每次操作最多保留最近 100 条固定阶段与时间，不含 SSH 原始输出或秘密；平台重启时未确认操作标记 unknown 并追加事件。

## 本地验证

- `npm --prefix runtime run typecheck`、`npm --prefix web run typecheck`：通过。
- `node --import tsx --test test/machine-maintenance.test.ts test/machine-agent-updates.test.ts`：89/89 通过，覆盖自动架构目标、单次启动、排队脚本延期、任务领取围栏、旧回退/批次及重启 unknown。
- `node scripts/test-agent-update-direct-ui.mjs`：6/6 浏览器检查通过，覆盖一次提交、无发行/计划表单、阶段日志、失效默认凭据及异步主机切换。
- `npm --prefix web run build`、`git diff --check`：通过。
- 浏览器为本地构建与 API fixture；运行时测试为模拟 SSH。没有据此声称生产主机已完成 Agent 升级。

## 架构同步

- 架构影响：有。新增管理员单次升级控制路径、维护队列判定和持久阶段事件；凭据边界、固定维护器及成功证明保持原协议。
- 仓库章节：`docs/system-design.md` 第 28.1、28.2、28.4、28.6 节；使用文档 `docs/agent-deployment.md` 和 `README.md` 已更新。
- Doca：[LightMoni 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 的 Agent 版本、升级与回退章节，编辑回执 `saved: true`，seq 1800。最新版本回读 `agent044-p-2`、`agent044-p-11`、`agent044-p-19` 与原生 `agent044-maintenance-flow` 均与目标一致；流程图 14 个节点和 14 条连线逐项一致，无关块未修改。

## 发布与生产

本地验证先于合并。合并提交、镜像摘要、生产备份、部署和健康回读须在相应操作完成后追加真实证据，不用本节本地检查代替上线验收。
