# Research

- 中心约 1.7 万生产 Go 行，Agent 2593 行；Node 镜像目前仍以 Go 为入口，现有 TS 主要为前端和 Mastra worker，属于完整迁移。
- 使用 Node SQLite 的同步事务避免跨 await 共享事务，WAL/FULL/busy_timeout/foreign_keys 保持；64 位数据使用 BigInt 或字符串。
- bcryptjs 兼容旧 bcrypt；AES-256-GCM 保留 nonce+ciphertext+tag 的 base64 格式；沿用 master.key 派生 ClickHouse reader 密码。
- OTLP schema 与 Go deterministic protobuf 作为协议基线，receipt 指纹必须用固定样例差分验证；旧冻结 BLOB 原样重放。
- SQL 需要 ClickHouse 方言 AST 解析和账户双重限制；不能以 startsWith SELECT 代替原防护。
- Agent 机器采集通过跨平台信息库及 Linux 平台适配，Node runtime 随分发包提供，保留架构/平台校验。
- 告警与通知调度必须单实例接管，切换前关闭原调度；所有测试使用隔离副本和受控供应商。
