# SDD 026：统一验证记录

日期：2026-10-27。状态：实现、分层验证与Doca同步已完成，GitHub PR #6等待人工审核。本记录不把代码已实现等同于生产已验证。

## 验证矩阵

| 范围 | 已有证据 | 边界/状态 |
| --- | --- | --- |
| runtime全量回归 | `npm --prefix runtime test`，373通过、17跳过、0失败，共390项 | 最终锁目录fsync补丁另做下列定向回归；跳过项含环境依赖，不记为通过 |
| 最终补丁回归 | operations领域与Agent job定向75项，72通过、3跳过、0失败；其中executor 9/9 | 覆盖fsync后的持久锁、跨进程/SIGKILL、写后EIO保锁与已知前置拒绝释放 |
| 类型与后端构建 | `npm --prefix runtime run typecheck`、`npm --prefix runtime run build`、`npm --prefix ai-runtime run typecheck`均通过 | 最终补丁后复验通过 |
| Web构建 | `npm --prefix web run build`通过 | 既有第三方use client/chunk体积提示，不等于真实平台交互验收 |
| 中心API与Agent通路 | SQLite加密、管理员限制、revision/过期/繁忙、私有control+lease载荷、真实备份经HTTP批准/Agent runner/绑定回执 | 端点与真实文件使用本机隔离环境，不是生产平台写操作 |
| 备份/计划 | `node --import tsx --test test/operations-backups.test.ts test/operations-schedules.test.ts`，16项通过 | 真实本地文件；S3是独立验签HTTP夹具 |
| AI与执行器 | 最终定向回归覆盖`operations-ai.test.ts`和`operations-executor.test.ts` | 含512KiB真实store提案、28KiB分页无遗漏、CAS证据、秘密/日志省略、进程组取消与持久写锁 |
| 网站与证书 | [领域验证](validation-websites.md)，含真实Linux Nginx和TLS | 该文记录领域新增补丁和真实环境的分别范围，未验公网ACME |
| Compose | [领域验证](validation-containers.md)，真实Docker Engine29.3.0/Compose5.1.0 | 生命周期/接管/配置回退/卷保留/unknown及default context已实测，不代表所有Compose小版本或生产负载 |
| Web交互 | 隔离内存模拟后端127.0.0.1:19865 | 已清理临时服务；不能称真实平台全流程或远端写操作 |
| 仓库架构文档 | `docs/system-design.md`第26章与`docs/operations.md` | 已核对最终实现、支持边界和在线文本 |
| Doca | 第26章文字seq411回读；新增原生图保存/回读seq412 | 原247块/6图保留，新33文字块及15节点/17边已核对，见下方证据 |
| GitHub PR | [#6](https://github.com/workhold/lightmoni/pull/6)，功能分支`feat/operations-foundation`→`main` | 已创建待审，未合并 |

## 备份与计划的具体证据

备份测试执行真实目录创建、快照、恢复、目标CAS冲突、符号链接/恶意归档/损坏摘要、大小限制、权限与恢复前副本保留。S3夹具独立计算签名，实际收发PUT/GET/LIST/DELETE并测试写入后响应断开返回unknown。106份备份只返回100条；prune实际删除105份并保留删除总数，不能把返回的100个ID当全部清理量。

计划测试覆盖五字段Cron/IANA时区、DST、UTC slot去重、繁忙跳过、unknown/dispatching冻结、显式重新授权、重启跳过错过分钟、授权管理员降权/停用。真实HTTP API检查管理员、revision冲突与加密输入。fixture不能证明生产调度吞吐或跨进程fencing。

## 隔离网页交互证据

使用内存模拟后端，不连接生产平台，完成：网站/证书/Compose/本地备份表单保存不执行；网站inspect预览→人工确认→模拟回执；S3目标字段与密码遮蔽；固定backup create计划启用；中英文、浅深主题、390×844移动布局。浏览器console error/warn为空，Web构建通过；临时服务与浏览器测试资源已清理。

这些交互证明前端表单、状态和适配，不能证明真实SSH、Linux、S3或公网CA在页面上已跑通。

## 未验证与运行约束

- 未获授权公网域名，没有向公网CA申请或续期；ACME为已实现真实Certbot调用和前置条件检查，公网验收仍未完成。
- 未在AWS/MinIO等真实S3厂商执行验收；SigV4夹具验证不能替代厂商兼容性、权限策略、持久性或大对象容量验证。
- 没有生产高并发/大容量、跨节点发布、K8s、数据库在线一致性/迁移恢复或任意YAML兼容声明。
- Linux受管备份目录需root管理且不可被业务用户写入；归档可能含业务秘密，产品不筛除/加密备份正文，必须保护目录、传输和云存储权限。
- 写动作持久锁为`dataDir/operations/execution.lock`；unknown/崩溃保留，管理员核实进程/daemon/现场后才人工解除。只读操作仍可检查；不能复制Agent身份到多个dataDir绕过锁。
- Docker固定本机default context，禁止继承currentContext改发远端；没有任意rootless socket/远端daemon验收。

## 架构同步与最终交付证据

- 本次改变中心运维领域、加密配置/私有载荷、节点执行和调度控制路径，属于架构变更。仓库设计见`docs/system-design.md`第26章；配套输入、约束与恢复步骤见本SDD和`docs/operations.md`。
- 在线文档：[LightMoni 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)，第26章。通过Doca Streamable HTTP MCP写入，33个新增文字块在seq411回读，与预期内容一致；网页重新加载确认标题与章节顺序。
- 原有247个块逐块深比较相等、相对顺序一致，包含原6张原生流程图。新增运维控制图保留为可编辑原生图，块ID为`ca797620-3473-4683-b77a-58f7f968d79c`，保存回执`saved=true, seq=412`；同一版本按blockId回读确认15节点、17边、端点和路由数据与预期完全一致。epoch为`63d4490e-11da-4b5a-8674-cd671d8ad4b6`。浏览器重新加载后可见第7张彩色流程图。
- 已核对最终真实Linux领域证据和模拟网页交互的不同范围；未将模拟UI视为真实平台全流程验收。真实隔离测试的专属容器、卷、网络、临时服务与目录已清理。
- 最终`git diff --check`通过，生成的`web/tsconfig.tsbuildinfo`未纳入提交；已同步GitHub `origin/main`，基线为`0735d26fd29ff54b956e7a30d5b988a30bef9d17`，无新增远端主干提交或合并冲突。
- 已创建待审[GitHub PR #6](https://github.com/workhold/lightmoni/pull/6)，目标`main`；仅推送功能分支到GitHub，未推送Gitea、未合并。
