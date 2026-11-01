# 验收记录

日期：2026-11-01。基于 origin/main 1b5ee64 的独立工作树 `codex/069-docker-environment`；原工作区的应用图标改动未混入。

## 完成行为

- 主机列表显示可用、未安装、缺少 Compose、服务不可用、权限不足、待检测、过期，以及观测时间；未知与过期不能误报未安装。
- 主机列表、主机应用/Docker 清单、应用失败详情复用统一环境面板；提供明确确认、凭据选择、后台状态、只读结果核对、Agent 即时采集。
- 固定 SSH 安装支持 Ubuntu/Debian、amd64/arm64、systemd、root/免密 sudo，拒绝软件包冲突。补齐 Engine/Compose 后，为匹配身份的标准 Agent 配置 Docker 补充组并重启。安装状态不等于 Agent 观测，仍须采集核对。
- 修复 Docker 缺失错误分类和“单机已失败、顶部仍安装中”的摘要；保留原应用与历史，重新部署仍为显式动作。

## 已执行验证

- runtime 定向 HTTP/SQLite/Agent lease/SSH fixture 回归：122 项，120 通过，2 项真实 Docker 条件测试跳过，0 失败。覆盖角色、确认、幂等、主机绑定、秘密脱敏、错误分类、观测新鲜度、恢复、持久闸门、作业领取、SSH 生命周期与任务中心。日志见 evidence/runtime-tests.txt。
- runtime/web TypeScript 类型检查通过；web 生产构建通过。构建保留现有第三方 Ant Design use client 指令告警，不影响产物。
- 真实 Chrome + loopback HTTP/SQLite 浏览器：六种状态、确认安装、关窗重开、SSH 成功不掩盖旧 Agent 观测、权限诊断、OpenResty 缺失失败与补装目标、390px、中英文；0 页面异常。见 evidence/ui-report.json。SSH 结果为受控 fixture。
- 新增 Compose 探测涉及的应用观测回归另行运行 13 项全部通过，见 evidence/observability-tests.txt。
- shell 语法检查通过；校验拒绝非法操作 ID、静态回执白名单、无卸载/用户组/socket 宽权限命令、核验 Agent 身份与固定补充组配置。
- git diff --check 通过，提交前 fetch origin/main，落后提交数为 0。

## 架构同步

适用。仓库 docs/system-design.md 第 69 节；[Doca LightMoni 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)。写后逐块回读五段正文与原生图（6 节点、5 连线），保留既有凭据图全文；对照前后 outline 的全部 200 个返回项一致。Doca outline 固定截断 200 项，未将该对照声称为全部 700 块的逐块校验。新增标题被宿主自动转列表后已用真实块 ID 修正并移至文末；原文档标题已恢复。最终版本与证据见 evidence/doca-readback.json。

## 限制

本机未执行远端 apt 软件包安装、真实 systemd/SSH 连接或真实 Linux Agent 权限重启验收；不能把 fixture 当作实际主机安装成功。未发布镜像、部署生产、合并 main。自动安装暂限 Ubuntu/Debian，其他系统通过官方手动指南。

## 交付

[GitHub PR #55](https://github.com/workhold/lightmoni/pull/55)，目标 main，草稿待评审；未合并或部署。

## 汇总合入

2026-11-01 用户授权包含其他会话的全部变更经 PR 合入 main 并发布。同步最新 main，保留 SDD 068 与 069 两个设计章节；SDD 071 将标准 Agent 的 Docker/网站权限纳入安装发行包，与本流程的固定服务附加组配置兼容。最终发布与实机边界由汇总发布记录说明。
