# Implementation Plan: 注册式机器对账

## Technical Context
Node.js/TypeScript；现有 SQLite WAL、同步嵌套事务、加密接口、NodeStore、OperationsPlatformStore 和 signed managed executor；不增加依赖。独立 runtime/src/reconciliation 模块注册到 app.ts；以现有业务授权期望生成单机清单。

## Constitution Check
规格先行；中心保持授权与凭据所有权；不自动重放一次性脚本、unknown 作业或云 API；状态加密且公开数据显式白名单；现有数据库保留。架构变更涉及模块、数据存储和控制路径，docs/system-design.md 与 Doca 原生章节/图块同步并最新回读，完成证据记 evidence。

## Phase 0: Research
已通过只读研究核对最新 main：部署已有 placement、rolling/availability 和互斥，不重写调度；Agent 只比 revision；证书成功后无定期 inspect、同版本损坏不可修复。见 research.md。

## Phase 1: Design
ReconciliationRegistry 提供 register、refresh、tick、inventory。provider.collect 返回完整目标快照，校验后在单一事务 upsert；省略旧条目变 tombstone。desired hash 或绑定/actor 改变增加 generation 并清除旧核验。Provider.reconcile 通过现有通道检查/应用，回传有界状态和作业 ID；核心用 generation CAS 接受结果。保留所有未注册 provider 的持久条目，阻塞而不删除。

期望正文加密，summary 为无秘密结构化元数据；核心不读取秘密意义。周期调度、单次有界批量、同实例单飞、退避上限 300 秒、周期再检查 60 秒。provider 同步失败不产生删除；依赖必须属于同机且已核验当前代次。未知执行不自动重放。已有业务源是授权事实，完整快照周期修复中心重启前未投影的变更。

deployment provider 接到 cluster-workloads 内部，保留既有 placement、rolling、撤销、互斥、DNS 控制；生成实例具体配置含网站域名、端口/文件。定期实际 inspect 带期望配置；仅最新实际核验 configuration_matches 才一致；已知漂移复用 apply，manual 也恢复。file provider（runtime/src/reconciliation/certificate-files.ts）管目录证书：按机器拆目标，周期 inspect 实际发布入口、正文/版本/权限，再通过签名作业修复；unknown 和路径归属冲突阻塞。Agent provider 复用 NodeStore.effective，对 heartbeat 的运行内容和磁盘摘要分别比对；Agent 同版本也校验并修复配置。修改后立即刷新和驱动下发，周期全量刷新兜底。

## Project Structure
- runtime/src/reconciliation/{index,registry,agent-config}.ts
- runtime/src/shared/desired-state.ts
- runtime/src/ops/{index,types,cluster-workloads,certificate-cluster-delivery,certificates}.ts
- runtime/src/operations/platform.ts
- runtime/src/server/{app,nodes}.ts；runtime/src/agent/agent.ts
- runtime/test/reconciliation.test.ts 与 Agent/平台集成和执行测试

## Validation
核心合同测试覆盖多机、快照原子性、加密、代次 CAS、删除、依赖、退避、重启和未知 provider。集成测试覆盖 Agent 同版本漂移、部署 inspect drift、证书失败恢复、绑定和授权。运行 runtime typecheck、相关测试及完整 runtime suite。不修改生产环境。

## Lifecycle refinements
目录证书的 enabled 延续“自动同步”语义，关闭不会删除用户入口；显式 remove 动作持久化清理意图，核验后才允许删除目标。手动 sync 保存该次逻辑版本期望。旧 Agent 不具备 operations.platform.reconciliation.v1 时保留原轻量健康检查/证书下发，深度对账标记升级阻塞。Doca 原生新增章节/图块保存并按最新版本回读，原 911 块的内容及顺序全量比较不变。

## 发行设计补充

从固定 main 提交用 git archive 构建，避免工作区文件和运行时凭据进入镜像。按 Linux arm64、amd64 分别构建并记录完整 revision；隔离 ClickHouse/中心服务验证 HTTP、数据库、Web、SDK、Agent 原生包身份及编译后对账回归。OCI 每层 SHA256、受测 image config/rootfs 对比后，以分块上传发布固定多架构索引，再按 manifest digest 拉回比对。发布 GitHub prerelease 到同一提交，附件包含两架构 Agent 包、SHA256SUMS 和经过清理的验证证据。临时服务、卷和随机凭据最终清理。
