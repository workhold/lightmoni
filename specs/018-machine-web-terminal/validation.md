# 验收记录

2026-10-19，基于已合入 PR #19 的 `origin/main`（`8a6203d`），分支 `feat/machine-web-terminal`。

PR：[主机管理交互式 SSH 终端小窗 #20](https://gitea.heyphp.com/lightmoni/lightmoni/pulls/20)，等待审核，未合并。

## 已实现

- “主机管理 → 登录终端”打开真实 xterm 小窗，使用登记主机的用户名、端口、有效 SSH 私钥和已确认指纹。单私钥自动连接，多私钥显式选择；支持 Ctrl+C、UTF-8 输入输出、PTY 尺寸变化、全屏、断开和重连。
- HTTP 创建短时会话，WebSocket 绑定管理员、创建者、原登录 cookie 摘要和主机；升级强制检查 Origin。单次连接，不能把其他地址、命令或秘密传给创建接口。
- 与 SSH 预检/部署共享单机互斥。修改/删除主机被阻止；撤销在用凭据立即断开。输入前及定期检查角色、登录、凭据和目标；关闭窗口、离页、网络关闭、退出和平台停止释放资源。
- 有建连/空闲/总时限、用户/全局数量限制、输入大小限制和带 ACK 的输出背压。SQLite 仅保存连接元数据，命令、输出及私钥不进入日志、数据库或 AI。
- 文档说明私钥范围、远端 shell 历史边界、代理 Upgrade/Origin/Cookie 透传，以及会话粘滞要求。

## 执行结果

- Runtime 类型检查与构建通过；Web 类型检查和生产构建通过。
- Runtime 全套测试：212 项，209 通过、3 个现有条件性测试跳过、0 失败。
- SSH/主机专项：`test/machine-terminal.test.ts`、`test/managed-machines.test.ts`、`test/machine-ssh.test.ts`、`test/machine-ssh-live.test.ts` 合计 25 项全部通过，真实 SSH 未跳过。
- Web 现有单元测试 133 项全部通过。
- `node web/src/app/verify-machine-terminal.mjs`：9 个生产浏览器验收场景通过。使用真实 HTTP/WebSocket 和临时 loopback sshd，验证中文输入、Ctrl+C、全屏后实际 `stty size`、主动断开/重连、关闭/重新打开、导航卸载、390px 窄屏、中英文和多私钥选择；浏览器异常与意外接口响应均为空，见 `ui-report.json`。
- `node web/src/app/verify-machine-ssh.mjs`：11 个现有 AI SSH 预检、计划审核、安装状态、双语与成员权限场景全部通过。
- 本地平台已保留原 SQLite、加密主密钥和 ClickHouse 配置重启到新构建，`http://127.0.0.1:8080/healthz` 返回 200。没有把测试主机或测试凭据写入该平台。
- `git diff --check` 通过；提交前 fetch 确认基于最新 main。

截图在本地 `artifacts/screenshots/specs/018-machine-web-terminal/`，不提交截图。

## 当前支持边界

交互终端仅支持管理员、直接 SSH、无口令私钥和固定 SHA256 主机指纹；暂不支持 SSH 密码、带口令私钥、跳板机/SSM。会话在单进程内，不恢复原 shell。测试使用临时 SSH 配置和密钥，没有连接或修改用户登记的远程主机。人工终端不进入 AI 工具目录，AI 原有固定预检和人工确认部署边界保留。
