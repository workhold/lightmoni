# 现场验收

日期：2026-10-30（Asia/Shanghai）。结构化证据位于 [docker-report.json](evidence/docker-report.json)，浏览器记录在 [browser-report.json](evidence/browser-report.json)。报告中的时间戳使用 UTC。

## 运行范围

本机 Docker Desktop Linux Engine 29.4.3、Node 24.15.0。另运行两个使用 Docker 27.5.1 和 Node 24.15.0 的 DinD QA 节点，分别具有独立 daemon、网络命名空间、内部网段和持久卷。总计一个物理 Docker 主机、三个逻辑节点、两个集群；未声称跨物理机器或云网络验收。

MySQL 是商店手动应用；自定义 Node 留言程序和 OpenResty 是全局托管应用，各有两个集群部署。自定义程序由仓库源码和 Dockerfile 实际构建。实际镜像为 `mysql:8.4`、`lightmoni-cluster-demo-web:1.0.0`、`openresty/openresty:1.27.1.2-0-alpine`。

## 已通过的实际链路

- 通过生产资源 API、商店安装、受鉴权 Agent enrollment/activate、claim、私有 payload、events/result 与有效 lease 创建并执行全部工作负载。
- 两个集群使用同一个 `demo-web` 应用 ID/serviceName；命名端口分别映射到 24000/24001 和 25000/25001，端点查询显式指定集群，结果未混入其他集群。
- 两套集群入口均固定 80/443；同一个网站的公共域名/证书/路径配置分别代理本集群的 `http` 和 `admin` 上游。两个集群的 HTTPS 实际返回 200。
- HTTP POST 实际写入 MySQL，GET 读回；Web 容器实际重建后记录仍存在。应用停止、恢复后再次通过读写与重建检查。
- TLS 握手取回真实自签证书，核对域名、指纹和有效期。独立 TLS 连接避免会话恢复省略证书造成假阴性。
- 最终运行态连续三轮真实 HTTP 验证均通过，逐轮完成数据库写读、双端口、两集群与 TLS，见 [verification-rounds.json](evidence/verification-rounds.json)。
- 旧单集群 SQLite 原位迁移后，三套应用 ID 和原三份实例 ID 全部保留。故障替换后的旧实例仍作为历史保留；MySQL 原容器和数据目录未替换。

## 真实故障与 DNS mock

最终故障从 `2026-10-29T16:54:20.187Z` 开始，实际暂停整个 DinD 备用节点，其 Agent、Web 和 OpenResty 一起被冻结。没有伪造过期时间、成功回执或容器运行状态。

等待真实 Agent 心跳过期后，中心把 Web 与 OpenResty 调度到另一节点；新节点实际完成 Docker 部署、固定 80/443、完整网站配置、健康检查与 TLS 访问。于 `16:56:30.913Z` 验证入口可用。之后恢复故障节点并通过 Agent 执行清理旧实例。

公网 DNS transport 显式使用 mock，生产 DNS 归属和聚合流程实际运行：`demo`/`admin` 的 A 记录从 `192.0.2.11` 改为 `192.0.2.10`，同时保留第二集群的 `192.0.2.20`；非平台所有的 MX 记录仍保留。此结果不代表真实公网 DNS/ACME 账号验收。

初次 DinD 尝试因未运行官方嵌套 cgroup 初始化而失败；修正为官方 `dind` 包装器后，实际验证了带 CPU/内存限制的容器执行。早期故障探针过早检查新上游得到 503；最终脚本等待实际配置收敛后核对成功，失败尝试没有计为通过。

## 工作台与访问

工作台服务使用生产 `runtime/public` 与 `Auth`。Chrome 156 实际验证：无会话访问运维 API 返回 401；loopback 入口签发正式 `Demo administrator` 会话，后续使用 HttpOnly cookie。全局应用和网站可见，实际留言表单写入 MySQL，admin 端口读回数量；页面脚本错误为 0，详见浏览器报告。

视觉检查发现旧 UI 汇总把退役实例计入当前状态/机器，已修复。最终生产 bundle 的实际工作台中，三套应用均显示运行中，当前机器列表不再混入退役实例；历史仍保存在资源状态中。完整界面验收由本 SDD 的 UI 记录覆盖。

- 网站：<http://127.0.0.1:18080>
- Admin 命名端口：<http://127.0.0.1:18081>
- 工作台：<http://127.0.0.1:19043/qa/workbench>
- 原样 TLS 转发：18443

仅上述演示应用、QA 容器和专属节点卷被操作。未修改业务容器、生产机器、真实 DNS/ACME 或 Docker Desktop 全局设置。演示维持运行，启停与复现命令见 [README.md](README.md)。
