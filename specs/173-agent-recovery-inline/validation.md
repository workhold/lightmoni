# SDD 173 验证记录

## 2026-11-15 生产只读定位

- 使用既有管理员会话打开 `vchive` 原 unknown 更新。当前记录为 0.1.0 `790cca58456a` → 0.1.0 `7011d507e1db`，状态 unknown，上次恢复响应尚未核对，平台正确禁止直接再次恢复。
- 执行固定只读 SSH 安装检查：root 实际 UID 0、Linux amd64、curl/tar/gzip/sha256sum/systemd、HTTPS 均通过，检测到既有 Agent；Agent 最近心跳仍为 2026-11-11 16:25:11。离线不等于未安装。
- 原记录只读核对失败，中心日志仅保留固定 `SSHError: ssh_failed`、`remote_exit_code=127`、`remote_reason_code=remote_command_failed`，未读取或记录秘密。代码核对发现 status、probe 和 recovery bootstrap 均依赖 `/opt/lightmoni-agent/current/node`。
- 两个相关源码发行 `790cca58456a` 与 `7011d507e1db` 的构建脚本均生成 `node_binary_sha256`，支持本修复的清单校验。未执行生产恢复、升级、卸载、重装或任意远程 Shell。

## 自动验证

- 新增 `agent-recovery-runtime.test.ts` 与现有 probe/SSH 测试：19/19 通过。覆盖 current 损坏后选择合格保留运行时、摘要篡改、路径逃逸、可写文件和无可用运行时失败关闭。
- `machine-agent-updates`、`agent-update-runner`、`agent-update-extract`：205/205 通过，原审批、恢复、unknown、重试、身份和快照围栏不变。
- 助手记录 SSR 与契约测试：7/7 通过；管理员有核对/恢复控件，成员没有。
- `agent-update-progress-polling.mjs`：9/9 真实浏览器隔离验收通过。覆盖终态轮询、只读核对、勾选后恢复、revision 变化不派发、上次恢复未核对禁止恢复、读取失败及卸载停止。
- `assistant-agent-updates` 与 `assistant`：21/21 通过；Web 助手 SSR/单元测试：37/37 通过。
- 所有 API 均使用本地 fixture；浏览器测试不接触生产。已回读最终 unknown 卡片截图，确认恢复说明、勾选与操作按钮分组展示。shell fixture 在 macOS 上使用合成 root 身份与真实权限位，不等于 Linux/systemd 实机验收。生产只读定位尚未证明修复后的恢复已在 vchive 成功。

## 交付边界

本记录不预写镜像、生产部署或恢复成功。`npm run typecheck` 与 `npm run build` 已通过；Web 仅有第三方依赖 `use client` 提示。`npm run version:check` 为 46/46 通过，当前版本保持 0.1.1。Markdown 本地链接/代码围栏、脚本语法和 `git diff --check` 通过。GitHub PR 与 merge commit 以最终记录为准。
