# 验收记录

日期：2026-10-19。分支 `feat/assistant-ssh-bootstrap`，基于已合入 PR #18 的 `origin/main`（`a10dc40`）。

## 完成行为

- AI 工具 `check_managed_machine_ssh` 和主机页“SSH 安装检查”共用真实 SSH 登录及固定只读预检；结果严格转换为枚举和布尔值。
- `propose_agent_install` 生成持久化待审核计划，返回主机审核链接。用户打开链接审阅同一 ID，明确确认后才执行；安装失败会刷新真实部署状态。
- 检查绑定目标与私钥，校验有效期、架构、指纹、权限、已撤销/过期凭据。检查和安装单机互斥；目标/凭据变化或过期后要求重新检查。
- 平台为 HTTP 时仍可检查 SSH，但 HTTPS 安装条件失败。Docker 增加 openssh-client；使用说明已更新。

## 验证证据

- `npm --prefix runtime run typecheck`、`npm --prefix runtime run build` 通过。
- `npm --prefix runtime test`：204 项，201 通过、3 项沿用环境条件跳过、0 失败。最近的确认参数限制和过期处理另通过全部 17 项相关测试。
- `node --import tsx --test test/managed-machines.test.ts test/machine-ssh.test.ts test/machine-ssh-live.test.ts`（runtime 目录）：17 项全部通过。
- 真实 SSH 测试在本机高位 loopback 端口启动临时 OpenSSH 服务，生成临时主机密钥和客户端密钥，验证真实握手、固定检查、精确指纹、不匹配指纹、错误私钥、超时和取消。临时服务与密钥退出后清理，没有使用用户保存的主机或凭据。
- Web 全部 133 项现有单测通过；`npm --prefix web run build` 通过。
- `node web/src/app/verify-machine-ssh.mjs`：11 个生产前端隔离场景通过；检查失败/成功、指纹错误、取消、自动架构、保存计划不执行、同 ID 审核确认、失败后状态刷新、过期限制、中英文、助手审核跳转和成员权限。详见 [ui-report.json](ui-report.json)。API 全部拦截，浏览器错误及未知请求均为 0。
- 本地平台保留原 `.lightmoni` 数据目录和主密钥，重启后 `/healthz` 返回 ok，`/machines` 提供本次生产前端。

## 验收边界

没有在用户真实机器上安装/升级 Agent，没有调用真实大模型，没有构建发布容器。SSH 预检与本机真实握手已验证；远程 Linux 完整 systemd 安装仍依赖现有安装流程，其前置 glibc/发行包兼容性及业务机器实机验收边界保持原说明。只支持直接 SSH 无口令私钥；跳板/SSM/密码自动登录、通用 shell 和网页终端不在本次范围内。

旧待审核部署计划需要重新检查后生成；完成的历史记录保留。PR 等待用户审核，不自动合并。
