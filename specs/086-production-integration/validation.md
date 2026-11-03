# Validation

## 交付状态

2026-11-03 已完成真实生产链路：https://abc.heyphp.com。Demo 源码位于 `examples/abc-demo/`；不是静态占位页，页面按钮发送真实 POST 请求并显示应用生成的请求 ID。细节见 [demo-delivery.json](evidence/demo-delivery.json)。

- 线上中心运行 `docker.heyphp.com/lightmoni/lightmoni:20261103-a5793d5`，健康检查正常。固定标签与 latest 均已发布 linux/amd64、linux/arm64，index `sha256:a258f76083b7e0a60f95a8ef50cb58ad388658b25e7b2f8fdb903553f3ebfc19`。每架构实际镜像通过42项检查，包括真实独立内网 IP 的 HTTP/TCP 探针；逐 blob、测试 rootfs/config 与远端 manifest 回读匹配。见 [readiness-release.json](evidence/readiness-release.json)。
- GitHub #72–#74 已经集成 PR #77 合入，#79 修复 CentOS systemd 版本格式，#80 修复内网绑定健康目标。发布源码 a5793d51f19270ce8a51e54b0477d2606cce5654 与 main 574773806ab4bdcc7923b6c78345cc95c70854d6 的运行代码一致；本次最终 PR 仅记录验收和发布元数据。
- 生产 schema v2 使用独立新卷，schema v1 卷、配置、SQLite 一致性备份和 master key 受保护保留。管理员沿用现有凭据，DNS/SSH 凭据保留；旧主机/任务/作业状态不迁移。ClickHouse 容器与遥测卷未重建。
- zz-bj-1 已运行单个统一 root Agent，三个已批准能力签名就绪，原独立 executor 单元不存在。CentOS 8 的 Docker 26.1.3 / Compose 2.27.0 验证通过；Agent 更新至 a5793d5 后身份保持，容器清单、签名运维与 root 脚本均有真实成功回执。
- Registry 与 OpenResty 通过平台真实安装。私有入口 https://registry-demo.heyphp.com 使用独立 HTTPS Basic Auth，未登录401、登录后200，证书受信。Demo 双架构镜像已向该仓库发布并核验15个 blob。
- Demo 手动部署固定私有镜像 digest，运行 UID/GID 65532、只读根文件系统，命名端口 `http` 在内网自动分配为 20003。部署与后续巡检 healthy=true，restart_count=0。此次私有来源下载并验证2113字节 manifest 元数据，复用相同本地镜像层；不把本次描述为冷缓存全量下载测试。
- 托管网站绑定 `abc-demo:http`；DNS 厂商与独立服务器回读 abc A 49.232.14.169。HTTPS /healthz 返回200与正确服务名；HTTP 返回308到HTTPS。证书 SAN 为 abc.heyphp.com，Let's Encrypt YR2 签发，有效至2027-01-31 23:56:54 UTC，已配置自动续期；尚未到期，不声称实际续期已执行。
- Chrome 打开公网网站并点击按钮得到真实请求ID；独立生产服务器可信 TLS 客户端再次验证健康/状态/POST，pings从1增至2。截图位于忽略的 `.local-dev/production-upgrade-083/`，最终交付画面为 `demo-public-live.png`。

## 服务名补充验收

手动、托管应用均有全局唯一且创建后固定的服务名。手动网站可在各路径选择应用服务与命名端口，或直接填写反代 URL；托管网站仅选择服务和命名端口，自动发现集群及健康实例。应用部署模式与网站路由模式互相独立。

- 既有后端和界面已实现此契约，无需新建兼容字段或另一套发现协议。SDD 已明确记录规则。
- 相关集群/网站测试52/52通过，覆盖手动应用服务身份、手动网站服务/URL混合路径、托管发现、IPv4/IPv6、网关本机/跨机地址与无健康实例503。
- 线上 Demo 为手动应用 → 托管网站；私有镜像入口为手动网站 → Registry 服务。真实编辑器验证手动后端来源切换和 URL 输入，取消后回读已保存的托管网站 revision1保持不变。见 [service-discovery.json](evidence/service-discovery.json)。

## 网络边界与架构同步

公网实测发现云 EIP/NAT 可绕过“仅绑定内网 IP”的假设，直接访问 Registry 20000。已通过精确代码审批的签名 root 作业部署专用 DOCKER-USER 规则：仅原始目的172.21.0.16:20000、ORIGINAL方向，允许172.21.0.0/20，其余DROP。内网访问200，公网后端超时，HTTPS认证仍正常，DROP计数增长。

root 所有的幂等脚本与 oneshot 单元启用，Docker Requires/After 依赖该单元；直接重复应用脚本幂等，Docker持续运行。本次未重启主机或 Docker，因此只确认持久配置和依赖，不声称实际重启验收。停止依赖单元会影响 Docker；变更网络或端口需同步规则。见 [registry-network.json](evidence/registry-network.json)。

仓库 `docs/system-design.md` 第86章与 [Doca 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 同步：health.host/部署拓扑原有回读seq944；网络边界保存seq946、最新目标块回读seq947与仓库逐字一致。仅插入目标段落，不对既有原生图节点/连线或无关块下发改写命令。见 [doca-readiness-sync.json](evidence/doca-readiness-sync.json) 和 [doca-network-sync.json](evidence/doca-network-sync.json)。服务名补充仅明确既有契约，架构变更不适用及理由见服务发现证据。

## 检查范围与历史证据

- 最新 Runtime 完整1645项：1613通过、32项环境依赖跳过、0失败；typecheck/build通过。内网健康修复定向49/49，最终服务发现回归52/52，跳过不计为通过。
- 整合基线根 typecheck/build通过，AI runtime71/71、TypeScript SDK22/22；SSH诊断12/12保持unknown及恢复互斥。Demo HTTP测试1/1与双架构实际容器测试通过。
- 重建前独立执行器仅容器能力的验证属于历史基线；当前交付以上述统一 Agent 实测为准，不混同两套运行模型。
- 不把单台 Demo 验收等同于所有云厂商、所有商店应用或自动故障迁移均完成实机测试。数据库、master key、环境文件及 DNS/SSH/Registry 秘密均不进入此目录。
