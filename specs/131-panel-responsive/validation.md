# SDD131 验收记录

日期：2026-11-12。分支：`codex/131-panel-responsive`。

## 诊断与架构同步

- Agent 默认每 30 秒通过 control 心跳上报；主机列表/详情从中心 SQLite 读取，不在开页时 SSH。文件面板此前每个 HTTP 请求都建立新的 SSH/SFTP 连接，保存后刷新还会额外重连。Vite 已输出内容哈希资源 URL，但主 HTML 原为 `no-cache`，可被浏览器存储。
- 架构影响：中心文件通路增加绑定管理员登录会话的短时 SSH/SFTP 连接状态，原凭据、主机指纹、文件版本/审计边界保留。仓库 [系统设计第 107 章及第 131 章](../../docs/system-design.md)同步状态与文件会话路径；浏览器直连 Agent 的可达性、TLS、授权和运行身份缺口已列入设计判断。
- [Doca《LightMoni 系统设计基线》](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 已更新第 107 章与新增第 131 章。seq 1793 完整回读确认原 1000 块按原顺序保留（仅目标文字更新），原 55 张原生流程图的 509 节点和 532 连线逐图相等；新增图 6 节点、5 连线及目标正文相等。补充同登录多面板共享语义后，在最新 seq 1797 回读第 107、131 章目标段落和新增图，文本及 6 节点、5 连线均相等。标题已恢复为原名。详见 [回读证据](evidence/doca-readback.json)。

## 实现与检查

- 主机读取：`GET /machines` 与详情仍只读中心已持久化的 Agent 心跳，不进行 SSH。新增 `agent_observed_at`；服务端摘要复用已读取的网络快照。浏览器验证中，主机响应在慢 Agent/标签响应之前已渲染，最近上报时间可见，2.5 秒活动操作刷新未重叠或饿死辅助请求；挂起请求在 6 秒运行中/15 秒常规截止后释放占用，下轮可重试。角色切换立即隐藏旧权限数据。
- 文件会话：真实 OpenSSH/SFTP 测试确认目录、读、写、刷新连续操作只建立 1 条 SSH 连接；旧无会话头接口独立建连。跨登录拒绝、凭据撤销和目标变化失效、20 秒闲置/10 分钟最长时限、同登录多面板复用及按引用关闭、服务停止等待在途请求均通过。第二个同登录、同主机、同凭据面板共享已有连接；不同凭据不能抢占。写入发布后撤销返回“结果未核实”并记 `unknown` 审计，确定的版本冲突仍返回 `file_changed`；写请求不自动重放。
- 静态缓存：GET/HEAD 覆盖 `/`、`index.html`、SPA 回退、带哈希 JS/CSS、未版本化文件和缺失资源。HTML 为 `no-store`，带哈希资源一年 `immutable`，未版本化资源一小时，缺失 `/assets/` 返回 404。实际 Vite 构建的 102 个资源及 HTML 中 13 个资源引用均为内容哈希命名；构建变更由新 HTML 引用新 URL。
- `git fetch origin main` 后 `origin/main` 与分支基点均为 `aef73ae`，无需合并冲突。`runtime npm run typecheck`、`web npm run build`、`git diff --check` 通过；最终定向 runtime 测试共 100/100 通过（managed machines 86、machine files 13、static cache 1）。
- 浏览器 `verify-host-status-loading.mjs`、`verify-host-resources.mjs` 与 `verify-host-file-maintenance.mjs` 均通过；后者连续三轮通过。现有 `verify-agent-operation-progress.mjs` 的成功状态进度条断言与 `origin/main` 已有页面行为矛盾，本次未修改该无关旧断言。

上述为本地验收；尚未部署到线上，不能把它视为生产网络延迟或真实机器规模下的体验测量。
