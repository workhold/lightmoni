# 验收记录

日期：2026-11-08（Asia/Shanghai）。独立功能分支 `codex/113-dns-ownership-readback`，提交前已同步 `origin/main` 的 `577ccc6`；验收后主干新增内容仅为发行证据文档，相关运行时代码一致。

## 现场只读核对

通过用户已登录的监控工作台读取网站及托管域名记录：网站 v6 已发布，期望入口为 `edge-49b2209ee4168ec9.doc-a.cn`；DNSPod 回读 `docker` 的 CNAME 值为 `edge-49b2209ee4168ec9.doc-a.cn.`、TTL 600、默认线路、已启用。网站状态报 `dns_owned_record_modified_externally`。本机解析器的只读 CNAME 查询也返回此带点目标；这不替代权威/公网传播验收。

归属身份使用原始 value，第一次厂商回读不能验证，后续协调又把同一 Record ID 的末尾点差异判为外部修改。PR #149 已修正默认线路参数，本次修正独立的回读比较问题。

## 修复与兼容

按用户补充要求，CNAME 比较键统一为 ASCII 小写、末尾带 `.`。厂商回读交替有点、无点均可匹配。ensureDnsRecords 的归属保护/外部识别/更新/最终验证与人工 DNS 创建、修改回读共用此规则；原始配置和回读值保持原样。

已有 verifying/applied 日志保持原归属 ID 和 Record ID，无需手工改数据库或删除云记录。不同目标仍拒绝；TTL、线路、已声明权重、授权和未知结果保护不变，TXT 继续逐字比较。

## 本地回归证据

- 修复前：`node --import tsx --test --test-name-pattern='CNAME readback' test/platform-cloud-certificates.test.ts`，阿里云与 DNSPod 2/2 均复现 `dns_owned_record_modified_externally`。将普通/加权 DNSPod 夹具改为实际末尾点回读后，原有两项回归也失败。
- 修复后定向检查：CNAME 回读、TXT 归属和 DNSPod 共 8/8 通过。
- 用户补充有点/无点兼容后，再运行 `node --import tsx --test --test-concurrency=1 test/platform-website-routing.test.ts test/platform-clusters.test.ts test/platform-cloud-certificates.test.ts`：150/150 通过，0 跳过。
- `npm run typecheck`（runtime）通过；`git diff --check` 通过。

跨厂商测试在同一记录上交替返回有点/无点和不同大小写，覆盖历史 verifying/applied、所有输入/回读组合、TTL 修改、稳定归属与远端 ID、等价外部记录不接管、人工 CRUD 保留原始回读、实际目标变化拒绝。TXT 的大小写变化和末尾点变化分别拒绝。普通/加权 DNSPod 既有测试使用带点回读，补上上一轮夹具遗漏。

## 架构与交付边界

架构同步不适用：既有协议的语义比较修复，不改变组件职责、数据/控制路径、厂商协议契约、存储格式、凭据边界或部署拓扑；`docs/system-design.md` 与 Doca 在线设计无需修改。

以上为修复 PR 的只读现场核对记录；用户随后授权“合并部署发版”，发行结果记录如下。


## 合并与制品验收

PR [#153](https://github.com/workhold/lightmoni/pull/153) 已按用户授权合入；固定源码为 `f0d729d7f93bee1d432d4d5f178370690e97a73a`。使用该提交的 `git archive` 构建，输入 SHA256 为 `c33ffae07b231f6a421758ca2c667b09618fa3cc1623cac2a1ac12e955a7cf07`，不包含本地发行记录和未提交文件。

`linux/amd64` 与 `linux/arm64` 成品分别以非 root 中心、真实隔离 ClickHouse、SQLite/HTTP、SDK 写入查询、Agent/SDK 下载及摘要运行 57 项验收，各 57/57、0 错误。两架构分别运行成品编译模块回归：安装/协调 127/127、仓库凭据及 DNS/CNAME 69/69、主机容器 11/11、Docker 安装器 5/5、托管协调 19/19、镜像扫描 7/7。测试容器、卷、网络及临时凭据均已清理。

Docker 固定标签 `docker.heyphp.com/lightmoni/lightmoni:20261108-dns-cname-v1` 已发布，逐个核对本地 blob、成品 rootfs/config 与远端 blob/manifest/config/index；索引为 `sha256:f7eacae9dcd92db4756e633dae1fa32fa7a67c02bd49b0620f3cae649d5c5406`。amd64 manifest `sha256:9f2b0cea79fdc2af440559da4b634ce0a5cf5504b55683e477a79b8205541259`，arm64 manifest `sha256:2e1a56af942fa395241fd183833f47a9afc9a518a41ff2550046cb4538cc99ce`。原 Docker `latest` 的摘要保持不变。

`evidence/` 保存构建输入、双架构构建元数据与验收、编译回归、索引、Registry 回读和下载包摘要；生产原始 DB、环境、主密钥与容器配置不进入仓库。


## 生产部署与恢复

更新前通过原有 1Panel 终端执行完整 SQLite 在线快照，`quick_check=ok`，页数/传输页数均 464243、页大小 4096、总计 1901539328 字节。原 Compose、环境、容器配置与 32 字节 master key 保存在生产 `/opt/lightmoni/backups/sdd113-dns-cname-20261108`，目录 0700、文件 0600；仅脱敏摘要进入证据。

在无排队/运行中签名作业的边界，只重建 LightMoni 中心；生产拉取摘要与固定 OCI 索引一致。2026-11-08 22:28:43（Asia/Shanghai）确认 amd64 中心健康、源码版本正确。挂载、环境键值、端口/网络、master key 与其他容器均保持不变；文件审计表、主机 Docker 模块和私有仓库凭据能力保留。无需升级或重启 Agent。

网站 `fb2bb27e9a85a7e83cb46412d3eab67a` 继续发布 v6，DNS 错误已清空，22:28:42 的厂商回读验证成功。原 Record ID `2446142290` 保留、归属记录仍为 1 条，journal 从 `verifying` 恢复为 `applied`。本次回读值为无点的 `edge-49b2209ee4168ec9.doc-a.cn`，与故障现场有点回读均由统一比较键兼容；没有人工删除、重建、接管或修改 DNS 归属日志。

部署后浏览器重新读取网站列表及详情，分别显示“DNS 厂商已确认”和“最近回读成功”，原红色 DNS 错误消失；截图见 `evidence/production-dns-verified.png`。本机可信 TLS 请求中心 `/healthz` 返回 200 与 `status:ok`；仓库 `/v2/` 返回预期的 401（入口仍有认证）。此结果证明厂商回读与当前访问入口恢复，不将其宣称为所有公网缓存传播完成。
