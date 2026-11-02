# SDD084 验收记录

验收日期：2026-11-02。工作分支：`feat/084-host-ssh-accounts`。所有本轮验证在本地隔离环境执行，未连接生产平台或 vchive，未安装、升级、卸载用户主机的 Agent。

## 最终行为与身份边界

- 主机资产不再保存登录用户名或主机级默认凭据；SSH 账户独立建档，凭据授权必须属于明确账户。用户名不可变，账户删除保留历史审计；同名重建不会继承旧权限。中央加密凭据库继续复用，局部解绑不影响其他账户。
- 单台、批量和 AI 安装预检默认自动选账户，优先登记的 root，再检查已验证高权限和其他有效账户。root 名称仅决定顺序，真实权限仍须检查；取消自动选择后仅检查显式指定账户。
- 连接、鉴权或权限不足的固定只读预检可以继续下一个已登记候选，每次尝试持久记录。主机密钥不匹配、取消、超时、无效响应和非权限安装前置条件失败均停止，不用换账户绕过。
- 安装计划冻结最终账户 ID、用户名、账户及凭据修订；修改默认值不改变已批准身份。安装派发后结果 unknown 不重放，另选账户只能执行固定只读核对，保留原批准身份和核对身份。
- 终端、更新、回退、卸载、权限切换、Docker 安装和 AI 计划复用服务端账户解析，不从主机字段或账户名推断权限。普通操作不因默认失效而跨账户回退。

## 自动化验证

| 检查 | 结果 | 范围与限制 |
| --- | --- | --- |
| `npm --prefix runtime test` | 1622 项，1590 通过、32 跳过、0 失败 | 账户/API/数据库、安装和维护、审批快照、unknown 核对、角色边界；跳过不计为通过 |
| `npm --prefix ai-runtime test` | 71/71 | AI runtime 回归 |
| `npm --prefix sdk/typescript test` | 22/22 | SDK 回归；未增加 SDK 对 Agent 的依赖 |
| `npm run typecheck` | 通过 | runtime、AI runtime、Web |
| `npm run build` | 通过 | SDK、runtime、AI runtime、Web；最终 Docker 权限文案更新后另行完成 Web 类型检查和生产构建 |
| 浏览器交互 | 94/94 | 下表列明真实 SSH 与隔离 API 的差别 |
| `git diff --check` | 通过 | 提交前再次检查 |

最终只读审查发现 AI 的 `propose_agent_install` 缺少运行模式参数，已补充可选 `runtime_mode: root | user`（默认 root），严格校验后透传到同一安装计划；SSH 安装账户与 Agent 常驻模式保持分离。补充的 AI、主机管理、安装恢复及竞态定向测试 81/81 通过，runtime 类型检查通过；该补验在上表完整回归后执行，属于最终小修复的定向验证，不冒称全量回归又执行了一次。

Runtime 跳过主要依赖 Linux/root/systemd、可用 Docker、ClickHouse、显式启用的集成环境或 Go 基线工具链；完整跳过名称及最终日志摘要 SHA256 见 [test-summary.json](evidence/test-summary.json)。这些结果不能解释为所有生产能力已端到端验证。

| 界面脚本 | 项数 | 证据 |
| --- | --- | --- |
| `verify-connection-credentials.mjs` | 7 | [凭据库](evidence/ui/connection-ui-report.json) |
| `verify-host-registration-onboarding.mjs` | 3 | [主机登记](evidence/ui/registration-ui-report.json) |
| `verify-machine-credential-retention.mjs` | 3 | [期限与账户授权](evidence/ui/retention-ui-report.json) |
| `verify-machine-ssh.mjs` | 18 | [SSH 检查与部署界面](evidence/ui/machine-ssh-ui-report.json) |
| `verify-host-agent-lifecycle.mjs` | 19 | [生命周期与丢响应](evidence/ui/host-lifecycle-ui-report.json) |
| `verify-machine-terminal.mjs` | 9 | [真实本地 SSH 终端](evidence/ui/terminal-ui-report.json) |
| `verify-host-execution-ui.mjs` | 23 | [自动/手动账户、审批与 unknown](evidence/ui/host-execution-ui-report.json)、[截图人工检查记录](evidence/ui/host-execution-manual-qa.md) |
| `scripts/test-docker-executor-copy-ui.mjs` | 12 | [统一 Agent 权限文案](evidence/ui/docker-permissions-ui-report.json) |

终端脚本使用临时本地 sshd，实际验证公钥登录、UTF-8 输出、Ctrl+C、PTY resize、断开重连、卸载组件释放连接及账户默认凭据隔离；其余浏览器脚本使用隔离 API fixture，均无页面异常或非预期 API 请求。人工检查单台/批量手动账户、unknown、运行账户审阅和英文暗色截图；Docker 检查覆盖中英文及 390px 暗色布局。截图保留在本地忽略目录，仓库仅保存无秘密报告。

## 真实边界与补充检查

`machine-ssh-live.test.ts` 使用临时本地 sshd 验证真实握手、精确主机密钥固定、私钥认证、超时和取消。`machine-ssh.test.ts` 另以真实 loopback TCP 静默端点及缩短的 ssh2 握手期限确认 `client-timeout` 映射为 `timed_out`，自动预检回归确认此类错误停止切换账户。完整 runtime 回归包含这些断言。

免交互 sudo 与无权限用户的真实操作系统边界沿用 SDD083 隔离 Linux/sshd 证据，详见 [SDD083 验收](../083-unified-agent-runtime/validation.md)；该既有证据不代表本轮重新在 Linux 主机执行了完整安装。当前账户解析与非 root 首装、权限切换流转通过 HTTP/数据库及模拟 SSH 回归；本轮未执行真实远端 systemd 首装、完整升级/回退/卸载或容器业务端到端操作。

扫描确认实际代码无 `managed_machines.username/default_credential_id` 读写、主机级旧凭据路由或客户端旧用户名回退；账户与执行目标中的 username 是新模型的必要字段。旧开发数据库在业务写入前拒绝启动，schema-baseline 测试确认无自动清空、迁移或秘密写入。升级前须备份旧数据并使用新的数据目录，这是本次不保留兼容实现的明确影响。

## 架构同步

本次影响数据模型、账户凭据边界、安装控制流与 AI 预检。仓库 [系统设计](../../docs/system-design.md) 已更新当前基线、13/13.3/13.4/13.6、81 和 84 章。

[Doca 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 已在 seq 942 回读 30 个目标块，包含两张新增原生流程图。原有 783 块与 40 张图保留，新增两张图各 9 节点、10 条边；文档标题仍为“LightMoni 系统设计基线”。证据见 [doca-sync.json](evidence/doca-sync.json)。这里只确认原生图结构与文本回读，没有单独声称 Doca 渲染截图验收。

## 交付边界

已提交 [PR #73](https://github.com/workhold/lightmoni/pull/73)，面向 main，非 Draft；创建后 GitHub 显示 MERGEABLE/CLEAN，无配置检查回执。本分支包含尚未合并的 [PR #72](https://github.com/workhold/lightmoni/pull/72) 统一 Agent 生命周期实现及本次 SDD084 多账户变更。未自动合并 PR、关闭其他 PR、发布镜像或部署生产。
