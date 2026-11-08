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

现场核对为只读，本次未部署、修改生产 DNS 或归属日志。需在包含本次修复的中心版本部署后，继续以网站 DNS 状态及厂商回读确认线上恢复。
