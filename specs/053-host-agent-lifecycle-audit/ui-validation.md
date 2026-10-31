# 主机管理与 Agent 生命周期 UI 验证

## 范围与隔离

验证使用本工作区构建的生产 Web bundle。Playwright 将 bundle 复制到临时目录，拦截全部 HTTP 与 WebSocket；没有启动平台服务、连接真实 SSH、操作 vchive、写入生产或安装 Agent。所有浏览器上下文和 bundle 临时目录都在结束时关闭/清理。原 8080 服务未操作。

新验证器 `web/src/app/verify-host-agent-lifecycle.mjs` 是可重复运行的回归源码；运行时 fixture 数据和临时目录不提交。截图放在 ignored `artifacts/screenshots/`，文本验收报告保留在本 SDD。

## 修复与验收

- 部署历史可直接审阅已持久化的原计划或查看原记录，不重新做 SSH、不新建计划。
- 创建计划的响应丢失或主机身份不匹配时，按本次 SSH check ID、凭据 ID 与此前历史 ID 排除集合恢复唯一原记录；历史不可读或不匹配时只允许读取核查，禁止重复 POST。
- apply 响应中断且原记录暂不可读时，原确认按钮锁定；读取 running/unknown/succeeded 原记录后展示真实状态，不假报成功、不重放 apply。
- unknown 安装提供当前有效 SSH 凭据选择和固定只读核对；远端尚未派发的阶段可在无 SSH 凭据时请求平台核对。人工结束需有效原因及二次确认，说明不会停止远端流程、不会确认安装成功；结束后保留 unknown 与操作人、时间、原因，不再提供 apply 或核对入口。
- 主机登记、主机凭据绑定和中央凭据创建的响应未知时，隐藏重复保存操作并清除表单秘密，提供返回列表或刷新主机详情核查；没有按名字/IP 猜测合并记录。
- 已退役 Agent 关联不会仅因 agent_id 非空被批次 UI 拒绝；仍要求服务端能力许可和 SSH 预检明确远端 absent。保留配置/身份的主机不能据此跳过后端首装保护。
- 批次排除未人工结束的 unknown 安装，并正确展示带端口的 IPv6 SSH 目标。
- 安装入口以服务端明确返回的 `deploy_agent` 能力为准；只有缺少该能力字段时，才用本地 `agent_id + agent_status` 作兜底。人工结束 unknown 后，即使缓存状态仍为 online/offline，也能按服务端许可进入固定只读预检；服务端拒绝时仍不会发起 SSH。远端 absent 与绑定可替换仍由计划/执行端核验，不据此跳过保护。

## 最终构建与测试

构建与类型检查通过，`git diff --check` 通过。以下五套验证在最后一次 Web 构建后并行运行，期间没有再次构建 Web，均正常退出（exit 0），共 **110 项通过**；全部 `errors=[]`、`unexpected=[]`。

| 验证器 | 通过数 | 文本报告 |
| --- | ---: | --- |
| 生命周期恢复与未知保存 | 19 | `evidence/web/ui-report.json` |
| 主机身份与异步选择 | 13 | `evidence/identity/ui-report.json` |
| 批次主机操作 | 24 | `evidence/bulk/bulk-host-node-ui-report.json` |
| SSH 检查与计划 | 18 | `evidence/ssh/ui-report.json` |
| 登记与凭据保存 | 36 | `evidence/onboarding/onboarding-ui-report.json` |

最后 bundle：

- Entry：`/assets/index-CjcfNUO5.js`
- Entry SHA256：`28be01498abfc74b2f0e0ef63c9b2a11644d4a48346fe252bb8d76de325a6865`
- Index SHA256：`b7eae1cf89acd3da5e6856a0ceb6d1442f2fea6eb4dfff13cd5522aabc16cb50`

生命周期与身份报告各自记录了相同 bundle hash。原始七场景基线失败保留在 `evidence/web-baseline/ui-report.json`，其中页面错误与未拦截请求均为空；最后生命周期套件包含新增的恢复、人工结束和创建响应失联场景，不能将两套场景数直接当成相同测试集比较。

最终补充的能力优先级回归先在未修 bundle 上执行：`evidence/web-capability-baseline/ui-report.json` 为 17 项通过、2 项失败，失败分别是 resolved unknown 加缓存 online/offline、服务端允许时被本地状态提前拒绝；服务端拒绝场景通过。应用单条前端兜底条件修正后，生命周期 19 项全部通过。后端与 `statusOf` 未因这项修正改变。

已有批次/SSH/登记 fixture 补齐主干已使用的 `host-labels`、`task-hosts`、单主机 tasks 与 agent-updates 读取契约；批次筛选定位使用当前“主机标签”名称，没有为让旧 fixture 通过而更改生产业务行为。

## 目视核对

已查看最终中文 1440px、英文 1440px、中文 390px 的真实浏览器截图：目标地址、有效凭据、只读核对与人工结束原因均可见；窄屏恢复控件竖向排列，说明文本和 IPv6 目标换行正常。截图位于：

- `artifacts/screenshots/specs/053-host-agent-lifecycle-audit/evidence/web/installation-unknown-zh-CN-1440.png`
- `artifacts/screenshots/specs/053-host-agent-lifecycle-audit/evidence/web/installation-unknown-en-US-1440.png`
- `artifacts/screenshots/specs/053-host-agent-lifecycle-audit/evidence/web/installation-unknown-zh-CN-390.png`

## 边界

这是生产 bundle 的浏览器协议/交互验证，不能代替真实 Linux systemd 安装、主机权限、代理连通性或重启后恢复的端到端验证；这些由后端与安装脚本的独立测试覆盖。未执行真实主机安装或卸载。登记及凭据创建的防重复限于当前窗口；服务端创建幂等协议没有在本次变更中引入，用户仍需在重新创建前核查列表。
