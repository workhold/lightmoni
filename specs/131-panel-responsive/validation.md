# SDD131 验收记录

日期：2026-11-12。分支：`codex/131-panel-responsive`。

## 诊断与架构同步

- Agent 默认每 30 秒通过 control 心跳上报；主机列表/详情从中心 SQLite 读取，不在开页时 SSH。文件面板此前每个 HTTP 请求都建立新的 SSH/SFTP 连接，保存后刷新还会额外重连。Vite 已输出内容哈希资源 URL，但主 HTML 原为 `no-cache`，可被浏览器存储。
- 架构影响：中心文件通路增加绑定管理员登录会话的短时 SSH/SFTP 连接状态，原凭据、主机指纹、文件版本/审计边界保留。仓库 [系统设计第 107 章及第 131 章](../../docs/system-design.md)同步状态与文件会话路径；浏览器直连 Agent 的可达性、TLS、授权和运行身份缺口已列入设计判断。
- [Doca《LightMoni 系统设计基线》](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 已更新第 107 章与新增第 131 章。seq 1793 完整回读确认原 1000 块按原顺序保留（仅目标文字更新），原 55 张原生流程图的 509 节点和 532 连线逐图相等；新增图 6 节点、5 连线及目标正文相等。补充同登录多面板共享语义后，曾在 seq 1797 回读第 107、131 章目标段落和新增图，文本及 6 节点、5 连线均相等。标题已恢复为原名。详见 [回读证据](evidence/doca-readback.json)。
- 本轮首开优化及有界 SFTP READ 属于既有中心文件控制路径内的请求与读协议变化，仓库第 107/131 章和 Doca 目标段落已同步。Doca seq 1799 最新版本回读 `sdd107-host-files-2`、`sdd131-files-1`、`sdd131-files-2` 文字逐段相等；原生 `sdd131-flow` 仍为 6 节点、5 连线且 ID 与连接关系相等。本轮仅改文字，未操作图块；此前 seq 1793 的原 55 图完整结构核对仍有效。未来 Agent 主动出站通道仅作为独立架构选项，本 PR 不实现。

## 实现与检查

- 主机读取：`GET /machines` 与详情仍只读中心已持久化的 Agent 心跳，不进行 SSH。新增 `agent_observed_at`；服务端摘要复用已读取的网络快照。浏览器验证中，主机响应在慢 Agent/标签响应之前已渲染，最近上报时间可见，2.5 秒活动操作刷新未重叠或饿死辅助请求；挂起请求在 6 秒运行中/15 秒常规截止后释放占用，下轮可重试。角色切换立即隐藏旧权限数据。
- 文件会话：真实 OpenSSH/SFTP 测试确认目录、读、写、刷新连续操作只建立 1 条 SSH 连接；旧无会话头接口独立建连。跨登录拒绝、凭据撤销和目标变化失效、20 秒闲置/10 分钟最长时限、同登录多面板复用及按引用关闭、服务停止等待在途请求均通过。第二个同登录、同主机、同凭据面板共享已有连接；不同凭据不能抢占。写入发布后撤销返回“结果未核实”并记 `unknown` 审计，确定的版本冲突仍返回 `file_changed`；写请求不自动重放。
- 静态缓存：GET/HEAD 覆盖 `/`、`index.html`、SPA 回退、带哈希 JS/CSS、未版本化文件和缺失资源。HTML 为 `no-store`，带哈希资源一年 `immutable`，未版本化资源一小时，缺失 `/assets/` 返回 404。实际 Vite 构建的 102 个资源及 HTML 中 13 个资源引用均为内容哈希命名；构建变更由新 HTML 引用新 URL。
- `git fetch origin main` 后 `origin/main` 与分支基点均为 `aef73ae`，无需合并冲突。`runtime npm run typecheck`、`web npm run build`、`git diff --check` 通过；最终定向 runtime 测试共 100/100 通过（managed machines 86、machine files 13、static cache 1）。
- 浏览器 `verify-host-status-loading.mjs`、`verify-host-resources.mjs` 与 `verify-host-file-maintenance.mjs` 均通过；后者连续三轮通过。现有 `verify-agent-operation-progress.mjs` 的成功状态进度条断言与 `origin/main` 已有页面行为矛盾，本次未修改该无关旧断言。

上述为本地验收；尚未部署到线上，不能把它视为生产网络延迟或真实机器规模下的体验测量。

## 首开与文件读取增量验收

- 主机列表已有账户与凭据元数据时，浏览器首次打开文件面板只发送一次带 `initial_path:"/"` 的 `POST file-session`，响应同时带会话和目录；没有串行详情 GET 或初始目录 GET。列表缺少完整凭据元数据时仍先取详情。真实 SSH/SFTP 浏览器验收三轮完整文件维护与一次旧列表格式回退均通过，见 [浏览器证据](../117-deployment-followups/evidence/files-ui.json)。
- 真实 SSH/SFTP 文件测试 19/19 通过，覆盖合并首开、旧建连响应、初始目录失败后释放新/共享引用、另一面板并发打开时不误关共享会话、320 KiB 读取；模拟 SFTP 验证最多 8 个并发 READ、短读补齐、提前 EOF 报 `file_changed` 且关闭前收束在途请求。`runtime` 类型检查、`web` 生产构建与静态缓存 HTTP 测试 1/1 通过，`git diff --check` 无空白错误。
- 隔离本机真实 sshd 的 10 轮中位数：原先建会话 41.3 ms + 首次列目录 6.0 ms；合并请求 44.9 ms。本机差异很小；生产网络中的收益来自减少浏览器到中心的串行往返，尚未测量生产延迟。构建资源仍为内容哈希 URL，静态缓存测试确认 HTML `no-store`、带哈希 JS/CSS `public, max-age=31536000, immutable`。

## 交付

- GitHub PR：[提升主机状态与文件管理响应速度](https://github.com/workhold/lightmoni/pull/178)，已于 2026-11-12 合并到 `main`，合并提交 `01dff1b76d2f13740bff6b994923fd4d71f51d0b`。

## 固定镜像发布增量

- 已推送固定镜像 `docker.heyphp.com/lightmoni/lightmoni:20261112-01dff1b-panel-responsive-v1`，源码固定为上述合并提交。远端回读多架构索引 `sha256:8709794c41586f0c6ce3960ac506bbeea4c49d2e1dee1a59a5166aa5f21fbac1`，其中 `linux/amd64` 清单为 `sha256:78a699392c68c1c2eac24017d62329e31b190483c3f26fe307647bd4299a3797`，`linux/arm64` 为 `sha256:a076beb892cadd77b59ea9177424527faa645589342c8c9138febce70a5bc882`。推送前标签不存在。两平台实际拉取均得到该索引；分别运行 Node 检查中心入口、AI runner 和两种 Agent 归档存在，`tar -tzf` 与归档 `release.json` 的平台/source_revision 均通过，镜像 OCI revision 均为完整 `01dff1b76d2f13740bff6b994923fd4d71f51d0b`。每个平台均有 67 个哈希 JS、14 个哈希 CSS，HTML 引用 `/assets/`。构建使用 HTTPS USTC Debian 镜像，保留 apt 签名校验。Compose PR 与生产部署结果按实际完成情况补记。
- 2026-11-12 15:56 UTC 发布前公网基线：`https://moni.heyphp.com/` 返回 HTTP 200，`Cache-Control: no-cache`；`/healthz` 为 HTTP 200。当前 HTML 引用的 `/assets/index-B11B5bqQ.js` 和 `/assets/index-Cd3qI-as.css` 均返回 HTTP 200、`Cache-Control: public, max-age=31536000, immutable`。因此现网 JS/CSS 长缓存已生效，但主 HTML 尚未达到本 SDD 的 `no-store`；需在新镜像部署后重测。
- 本发行增量只修改 Compose 的固定中心镜像标签；架构影响不适用。既有文件会话架构同步已在本 SDD 与 PR #178 中完成，Doca 最新回读见上文。
