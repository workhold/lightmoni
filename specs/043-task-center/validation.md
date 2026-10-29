# 验收记录

本轮在 macOS 本地完成开发与验证。未操作 vchive、生产主机或生产 Agent，未发布镜像。

| 检查 | 结果 |
| --- | --- |
| `npm test` | runtime：487 通过、17 跳过；ai-runtime：71 通过；TypeScript SDK：18 通过。总计 576 通过、0 失败 |
| `npm run typecheck` | runtime、ai-runtime、web 均通过 |
| `npm run build` | SDK、runtime、ai-runtime、web 均通过 |
| 最终执行与 AI 回归 | `node --import tsx --test test/task-center.test.ts test/assistant-tasks.test.ts`：25/25 通过；纳入最后的 control 凭据检查、相对路径和 unknown 人工结束修复 |
| 最终 runtime 构建 | `npm --prefix runtime run build` 通过，包含所有执行侧收尾代码 |
| 生产前端包浏览器验收 | `node web/src/app/verify-task-center.mjs`：17/17 通过，使用 API fixtures；中文桌面、390px 英文、成员只读、完整操作及异常流程，无页面异常或意外 API |
| 本地实际 HTTP/SQLite 页面检查 | `http://127.0.0.1:18080/machines?tab=tasks`：真实登录、任务与模板接口、主机标签与目录页面通过；不使用 API fixtures，不执行 SSH |
| `git diff --check` | 通过 |

17 项跳过是已有 Linux/systemd、Nginx、发布包或外部 ClickHouse 集成的环境条件。不能据此声称完成生产部署验收。执行测试实际启动 Node.js/POSIX shell 子进程，覆盖最小环境、超时、输出限制、取消、父进程崩溃清理、结果补交与不重放。AI 测试覆盖真实 HTTP 审批、权限、加密、事务幂等、陈旧提案与人工结束后的失效检查。

## 设计同步

架构影响适用：主机标签归属、通用任务定义与独立执行协议、持久调度、租约、人工决议、AI 行动提案边界。

- 仓库：`docs/system-design.md` 第 11.2、11.3、13、22.3、27 节；README 指向系统设计和本 SDD。
- [Doca 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)：从 seq 788 更新至 789 并回读验证。
- 已核对 4 段原文更新、29 个新增原生块及两张流程图的节点/连线；保留 371 个无关顶层块、14 张既有原生图和并行开发的集群章节。
- 新增控制图为 12 节点/13 连线，状态图为 7 节点/7 连线。验证的是在线原生图数据，未宣称在线图截图视觉验收。

## 证据与边界

- `execution-tests.json`：执行协议与实际子进程验收。
- `ui-report.json`：17 项浏览器验收。
- `local-runtime.json`：本地实际服务检查。
- `doca-sync.json`：在线保存及回读结果。

新库默认启用指标采集与服务拨测；旧数据库保留已有启停选择，因此当前本地历史拨测任务仍为停用。拨测无目标显示待配置，启用不等于已执行。脚本需要支持 `task.script.v1` 的新 Agent；旧 Agent 显示需升级，不能被误选派发。脚本以 Agent 用户权限执行，有界子进程不构成操作系统沙箱。unknown 的人工确认只记录管理员核对决议，不把历史改成成功，也不能证明远端停止。
