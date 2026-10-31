# SDD 048 验证记录

验证日期：2026-10-30。本轮先提交设计 `51f30ea`（`docs: 设计脚本任务创建与日历调度（SDD 048）`），再实现脚本创建、日历调度及执行策略。

## 构建与类型检查

| 命令 | 结果 | 本地日志 |
| --- | --- | --- |
| 根目录 `npm run typecheck` | exit 0；runtime、ai-runtime、web 通过 | `/tmp/lightmoni-048-typecheck-final.log` |
| 根目录 `npm run build` | exit 0；TypeScript SDK、runtime、ai-runtime、web 通过 | `/tmp/lightmoni-048-build.log` |

Web 构建输出包含第三方 antd 的 `use client` 模块级指令提示；构建成功，未出现阻断错误。

## 自动化测试

根目录执行 `npm test`，exit 0，日志为 `/tmp/lightmoni-048-tests.log`。

| 测试集 | 总数 | 通过 | 跳过 | 失败 |
| --- | ---: | ---: | ---: | ---: |
| runtime | 527 | 510 | 17 | 0 |
| ai-runtime | 71 | 71 | 0 | 0 |
| TypeScript SDK | 18 | 18 | 0 | 0 |

runtime 的17项跳过依赖本次环境未满足的 Linux/root 条件或真实 ClickHouse/集成服务配置，包括 release/systemd/Linux Nginx/发布包及 live ClickHouse 链路。跳过不作为验收通过，也不据此声称真实环境链路已验证。

上述全量测试完成后，又补充了“仅报告 task.script.v2 的 Agent 同时执行基础和扩展脚本”的一项回归。随后执行最终定向测试：

```sh
cd runtime
node --import tsx --test test/task-schedules.test.ts test/task-script-options.test.ts test/assistant-tasks.test.ts
```

最终定向结果33/33通过、0跳过、0失败（计划15项、脚本选项7项、AI任务11项），日志为 `/tmp/lightmoni-048-final-targeted.log`。全量日志对应新增这一项之前的527项 runtime 快照；不能将本次结果表述为“全量528项已运行”。

定向测试覆盖：

- 计划与策略严格规范化、明确时区、非法日期、IANA 时区/DST、闰日五次预览。
- 临近到期 at 的正常首扫、一次消费、重启与停用/启用不重放、错过时段不补跑、Cron 与预览一致。
- 并发上限、队列截止、自动重试的延迟/次数/原快照，以及版本、目标、绑定、授权、取消与未知结果守卫。
- 自动重试排队后再次修改任务的领取拒绝；200条未到期记录不阻塞已到期重试。
- 字面 argv、绝对 cwd、最小环境、超时/取消及目录不存在时失败；v1/v2 能力门禁和仅 v2 心跳的兼容执行。
- AI 使用相同任务定义，草拟不执行，人工批准的所有者绑定、版本检查、幂等与过期边界。

## 浏览器验收

[ui-report.json](ui-report.json) 记录10组检查，使用实际 Web 生产构建与模拟 API，浏览器 pageerror 为0、意外请求为0。覆盖空白脚本入口、UTF-8上传校验与替换确认、上传后编辑保存、日历预览与计划切换、目标能力提示、审阅防重复提交、参数及目录无损往返、内置模板、单机覆盖及390px英文界面。

该浏览器验收明确 `api_fixtures=true`、`real_scheduler_execution=false`、`real_agent_execution=false`、`production_writes=false`。它验证界面交互和请求契约，不是浏览器到真实中心/Agent 的端到端验收。runtime 中的真实子进程测试也只代表本机受控执行，不代表生产主机或 vchive 已部署验证。

## 独立审查与设计同步

[独立审查](review.md) 发现的3项 P2 已修复并增加回归：自动重试领取前版本检查、编辑时参数/目录字面值保持、未到期重试候选造成的饥饿。本轮无未解决代码阻塞项。

仓库系统设计及使用文档已随实现更新。Doca 同步由整合者通过浏览器完成编辑保存，reload 后回读537个块并核对文字；22个原生图均在编辑器中只读核对节点、标签、位置和连线端点一致，未修改或保存图。在线同步的详细证据及适用范围以 [doca-sync.md](doca-sync.md) 为准。

本轮未发布镜像、未修改生产平台或用户主机。最终验收支持范围为本地构建、自动化回归、模拟 API 的浏览器交互及设计文档同步；真实 Linux/ClickHouse/用户主机部署仍需满足对应环境后单独验证。

界面截图：[中文桌面](evidence/task-authoring-zh-1440.png)、[英文390px](evidence/task-authoring-en-390.png)。
