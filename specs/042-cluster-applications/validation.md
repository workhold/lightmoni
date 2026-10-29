# 验收记录

日期：2026-10-30（Asia/Shanghai）。功能分支 `codex/042-cluster-applications`，已推送origin并创建 [GitHub PR #18](https://github.com/workhold/lightmoni/pull/18)，目标main，草稿待评审；未合并。

## 自动化验证

| 检查 | 结果 |
| --- | --- |
| `npm --prefix runtime test` | 553 项：532 通过、21 跳过、0 失败 |
| AI Runtime 测试 | 71 通过、0 失败 |
| TypeScript SDK 测试 | 18 通过、0 失败 |
| `npm run typecheck` | 通过全部工作区 |
| `npm run build` | SDK、Runtime、AI Runtime、Web 全部通过 |
| 最终 UI 修复后 `npm --prefix web run build` | 通过，生产 bundle 已更新 |
| `git diff --check` | 通过 |

Runtime 已包含 85 项运维控制面用例（82 通过、3 项 Docker 专用用例默认跳过）；真实 Docker 链路另由下述 Demo 验收。跳过项未计为通过。

## 浏览器与界面

主 Agent 在独立 loopback QA 环境运行 `LIGHTMONI_CLUSTER_UI_URL=http://127.0.0.1:5199 node web/src/app/ops/verify-cluster-ui.mjs`。环境使用实际 SQLite、加密配置、HTTP 路由和资源控制器，显式 QA 管理员；禁用外部云调用和 Agent 执行，不用于代替 Docker 验收。

覆盖两个集群、一机唯一归属、同名独立应用、托管逐集群 2×1CPU/512MiB 与 3×2CPU/1GiB、固定宿主端口、serviceName 编辑限制、真实 revision 冲突保持输入、DNS/ACME 快捷回填、商店建议、双集群公共网站设置与各路径命名端口。保存刷新后再次编辑，断言两个集群的应用及端口仍正确读回。390px 列表无页面横溢，窄屏与 200% 等效视口的表单保存按钮可达。

最终代码连续三轮通过，逐轮页面脚本错误均为0；结构化记录保存在 [evidence/ui-live](evidence/ui-live/)。桌面顶部与逐集群区域、窄屏、200% 截图及录屏位于被忽略的 `artifacts/screenshots/specs/042-cluster-applications/evidence/`。

独立视觉评审复核稳定截图及录屏后，未发现可观察的视觉阻断。修正了初次截图处于弹窗过渡帧的问题，精简 MySQL 重复部署提示；补录首次进入、新建弹窗、真实保存后列表和成功反馈，以及商店抽屉切换。发现并修复网站编辑初始 effect 清空已保存上游的问题。当前应用汇总排除退役实例，生产 Demo 的三套应用实际显示运行中。截图工具仅报告原有 `favicon.ico` 404，页面脚本错误为 0。

## 真实 Docker / 数据库 / 故障验收

详见 [Demo 验收](../../examples/cluster-demo/VALIDATION.md)、[脱敏 Docker 报告](../../examples/cluster-demo/evidence/docker-report.json)及[连续三轮 HTTP 记录](../../examples/cluster-demo/evidence/verification-rounds.json)。

- 一台物理 Docker 主机、三个逻辑节点、两个集群；两个 DinD 节点有独立 daemon、网络命名空间、网段和卷。没有声称多物理机或多地域实机验收。
- MySQL 手动部署；同一全局 Web 和 OpenResty 应用各部署两个集群，走实际生产资源 API、Agent enrollment/activate、claim、私有载荷、续租和执行回执。
- Web 双命名端口，OpenResty host 固定 80/443，网站按集群发现对应端点；实际 POST/GET 写读 MySQL，重建 Web、停止和恢复后数据仍在，两个集群 TLS 均返回 200。
- 暂停整个当前 DinD 节点，等待真实 120 秒心跳过期；实际换机部署、配置校验、HTTP/TLS 通过后恢复入口，再恢复旧节点并清理退役实例。
- DNS transport 使用明确 mock；平台归属与聚合流程真实执行，换机 A 记录 `.11→.10`，保留第二集群 `.20` 和外部 MX。证书为实际自签 TLS，未验真实公网 DNS 传播或公有 ACME。
- 原单集群应用、实例和数据路径原位规范化，ID 及 MySQL 数据保留。浏览器在生产 bundle 和 Auth 下实际获得 HttpOnly 会话、查看应用/网站、提交并读回 MySQL 留言。

## 架构双端同步

架构影响：增加稳定机器集群归属、全局应用及逐集群发布、局部发现、多端口预留、托管入口及 DNS 聚合的数据和控制路径；管理员、加密配置、Agent 凭据和 lease 边界保持。

- 仓库：[docs/system-design.md 第42章](../../docs/system-design.md)。
- Doca 方案：[集群与应用统一部署方案](https://doca.heyphp.com/#/r/9a1e7f9c-e177-4113-a77b-0952ea747c6a)，位于“轻量告警系统”知识库。
- Doca 基线：[LightMoni 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)。
- 保存后按最新版本回读，第42章文字、8 个原生节点及 6 条连线一致；既有 356 块内容及顺序完全保留，新章节追加在末尾。结构化证据见 [doca-sync.json](doca-sync.json)。

## 兼容范围与后续边界

033 的独立 service/node_pool/gateway_group 停止新建和部署，保留历史与业务数据；此前 042 的单集群应用/网站原位规范化。新应用 serviceName 使用小写字母、数字和短横线、最长 63 字符且不可变。副本不建立数据库复制，托管不迁移本地数据。

首版商店为内置受控目录；自定义镜像/Compose 已支持，Demo 源码由独立 Dockerfile 构建。第三方商店源、平台自动源码构建流水线、多物理机/云网络与真实公网 DNS/ACME 留待后续验收。演示主机预登记在隔离数据库，本次没有经过 SSH 安装链路。
