# Web 与部署权限验证

日期：2026-11-02。全部使用本地隔离 fixture；没有连接生产平台、真实 SSH 或修改 vchive。

- `npm run typecheck --prefix web`：通过。
- `npm run typecheck --prefix runtime`：通过。
- `npm run build --prefix web`：通过；依赖的 use client bundler 提示保留，不影响构建退出码。
- `node web/src/app/verify-host-execution-ui.mjs`：17 项隔离浏览器检查通过。单个和批量首装默认 root、取消 user；统一服务/账户入口；精确账户切换审阅；创建与批准失联只读恢复、不重放；过期计划可取消；原凭据失效阻止批准；回读目标/载荷改变禁批；真实 UID/代次不符禁用高权限；普通角色无管理调用；英文深色界面；unknown 可选择有效 SSH 凭据只读 reconcile，凭据不可用或原计划回读失配时禁用。
- `cd runtime && node --import tsx --test test/agent-deployment-permissions.test.ts`：13 项通过，其中新增 4 组 root 配置、实际身份、所有权/权限和 user 冒充 root 的边界检查。root 所有权通过受控 lstat fixture 模拟，不代表真实 Linux root 验收。
- `git diff --check`：通过。

浏览器证据输出到忽略目录 `.local-dev/evidence/unified-agent-runtime/host-ui/`：`results.json`、`runtime-review-zh.png`、`runtime-dark-en.png` 和 `runtime-unknown-reconcile-zh.png`。已人工查看中文审阅和只读核对截图，明确列出容器管理、root 脚本、受管主机运维三类能力，并说明作业仍需独立批准；不会展示另一套执行器安装/维护入口。

标准、恢复与离线卸载的 managed journal gate 进行了静态审查：调用可信 CLI 的只读状态，SQLite 完整性/schema 核验失败则拒绝，fenced 非空或 pending_results 非零阻止卸载；停服后再次核验，再删除内部签名状态。业务目录保留。该审查不能代替真实 Linux/systemd 卸载回测。

本文件只覆盖上述 Web、定向权限单元测试和卸载静态审查；运行时、系统服务、Docker、Doca 同步、GitHub PR 与线上升级证据由本 SDD 的总验收记录分别说明。
