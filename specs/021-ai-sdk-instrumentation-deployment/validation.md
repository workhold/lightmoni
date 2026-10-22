# SDD 021：验证记录

> 记录截至 2026-10-23。验证结果覆盖中心部署状态/审批、Agent 回执闭环、受限 job/executor、只读 systemd preflight、release bundle 传输、计划层和扫描切片，不代表真实 Linux 主机部署或遥测闭环已经完成。

## 验收范围

本文件记录从规格到实现的可复核证据。本次切片实现了业务服务/目标/版本/部署计划元数据、中心状态迁移、管理员审批边界、脱敏部署事件、受限人工回滚闭环、Agent 回执驱动状态映射、Agent 只读 systemd preflight、私有 release bundle 上传/校验/租约下载、Linux Agent 安全解包与 current symlink 激活、只读源码扫描、明确 TypeScript/JavaScript 请求边界的结构化插桩提案、管理员确认后的安全 apply、AI 计划工具、纯逻辑 systemd 适配器、Agent job/executor/runner 和中心侧有界验证判定；受控源码构建、中心 ClickHouse 遥测验证、自动回滚和真实 Linux 主机验收仍待实现，不能把预检、审批、job 入队或 Agent 健康回执当作端到端部署完成。

## 规格与架构门

- [x] `spec.md` 定义 SDK 直连/Agent 模式、独立 Agent、源码插桩、部署适配器、审批、健康/遥测验证和回滚边界。
- [x] `plan.md` 定义 HLD/LLD 组件分层、数据模型、状态机、执行器和迁移策略。
- [x] `tasks.md` 将实现拆分为有依赖关系的任务，并标注当前状态。
- [x] `contracts/` 定义 HTTP/AI、适配器、Agent job 和插桩契约。
- [x] `docs/system-design.md` 已更新只读 preflight → 目标配置 revision → 部署计划控制路径、制品传输边界和 Mermaid 时序图。
- [ ] Doca 基线图此前已同步；本轮 bundle 上传/租约下载/current symlink/目录权限控制路径增量尚未同步。2026-10-23 检查确认 Codex CLI 配置了 Doca MCP endpoint，但当前执行环境没有对应 bearer-token 运行时凭据，浏览器仍返回“文档不存在 / 资源不存在或无权访问”；本轮未向 Doca 写入，不能标记完成。恢复安全凭据后须读取最新版本、保留原生图块，写入后回读文本、节点和连线。

## 功能验收矩阵

| 场景 | 预期 | 当前证据 | 状态 |
| --- | --- | --- | --- |
| Node/Python/Go/Rust 扫描 | 报告语言、框架、SDK 和候选位置，不执行项目代码 | `runtime/test/instrumentation.test.ts` | 通过（当前为启发式扫描） |
| 生成插桩 diff | 明确 TS/JS 多行请求边界逐文件生成摘要、unified diff、风险和验证命令；不自动写入；其他语言给手动步骤 | `runtime/test/instrumentation.test.ts`、`runtime/test/assistant-instrumentation-tools.test.ts` | 通过（受限提案） |
| 插桩 apply | 管理员确认、base revision、路径/符号链接/大小限制、原子写入和重复请求幂等 | `runtime/test/instrumentation.test.ts`、`runtime/src/assistant/index.ts` | 通过（本地 API/服务层；未执行构建） |
| revision 冲突 | apply 返回 409，不覆盖新修改 | `runtime/test/instrumentation.test.ts` | 通过 |
| 直连 SDK | 无 Agent 仍能上报中心 | 既有 SDK/接收测试 | 兼容性复核 |
| Agent SDK 模式 | Agent 本地持久化后用 data credential 上报 | 既有 Agent 队列；新闭环待复核 | 待验证 |
| systemd adapter probe | 缺 unit/systemd/坏路径时结构化拒绝 | `runtime/test/deployment-adapter.test.ts` | 通过（纯计划层） |
| Agent systemd preflight | 只读固定 argv；要求单独 `systemd.probe` capability；目标 unit/path 精确绑定；拒绝符号链接目录、masked/过渡态、跨 job 快照重放和部署阶段事件；不推进业务 deployment | `runtime/test/agent-executor.test.ts`、`runtime/test/service-deployments.test.ts`、`runtime/test/agent-jobs.test.ts` | 通过（mock systemctl；真实 Linux 主机未验证） |
| 预检快照失效 | 配置/Agent 绑定变化或超过 10 分钟时不作为当前快照绑定计划 | `runtime/test/service-deployments.test.ts` | 通过 |
| systemd plan | typed actions，禁止 shell | `runtime/test/deployment-adapter.test.ts` | 通过（纯计划层） |
| 服务/目标/版本/部署计划 | 管理员创建并生成 awaiting approval 计划 | `runtime/test/service-deployments.test.ts` | 通过（不执行） |
| 部署审批和状态迁移 | 已激活 Agent 且计划含授权 health_check 才能入队；Agent 有序阶段和最终健康回执推进状态；不可执行 generic plan 不向用户暴露批准操作 | `runtime/test/service-deployments.test.ts`、`web/src/app/ServiceDeploymentsPage.tsx` | 通过（不代表真实主机部署） |
| 管理员取消部署 | 未批准计划可转为 cancelled；已批准计划仅可在 Agent job 仍 queued 时原子取消；Agent 已领取后返回 409 并保持部署状态供人工核查；通用已领取 job 取消会写为 unknown | `runtime/test/service-deployments.test.ts`、`runtime/test/agent-jobs.test.ts` | 通过 |
| 部署事件时间线 | 计划/审批/Agent 阶段/终态/回滚请求和人工复核结果写入脱敏、按追加顺序可读事件 | `runtime/test/service-deployments.test.ts` | 通过 |
| Agent 事件顺序 | event 序号连续、重复请求幂等、阶段不能回退/跳跃；终态 event 不替代最终 result | `runtime/test/agent-jobs.test.ts` | 通过 |
| 取消和未知结果 | 仅未领取任务可安全取消；领取后取消、租约过期和不完整成功回执保留 unknown | `runtime/test/agent-jobs.test.ts`、`runtime/test/service-deployments.test.ts` | 通过 |
| 中心过期扫描 | Agent 离线后无需再请求，后台即可将租约过期任务转 unknown，并取消未领取的过期 job | `runtime/test/agent-jobs.test.ts` | 通过 |
| AI 部署事件工具 | 管理员可读取脱敏状态时间线，不把事件当作主机执行回执 | `runtime/test/assistant-instrumentation-tools.test.ts` | 通过 |
| 管理员确认的 systemd 回滚 | 新鲜安全 preflight、previous ready release、current-version CAS、restart/health 和 current-version 回执；首次部署/变化目标拒绝，unknown 收口为人工复核并要求新预检后显式重试 | `runtime/test/service-deployments.test.ts`、`runtime/test/agent-jobs.test.ts` | 通过（模拟 Agent/SQLite；真实 Linux 主机待验） |
| AI 服务部署工具 | 结构化 ID 生成审核计划 | `runtime/src/assistant/tools.ts` + typecheck | 通过（不执行） |
| Agent staging | digest 核对、root 所有且 Agent 组可写的受控 release 根目录、私有租约下载和幂等 job | `runtime/src/agent/executor.ts`、`runtime/test/agent-executor.test.ts`、`runtime/test/release-artifact-api.test.ts` | 通过（Linux root-owned 路径测试在 macOS/非 root runner 跳过） |
| Bundle 上传/下载与 GC | 管理员有界上传、私有 digest 存储、格式校验、lease 绑定下载；管理员 GC dry-run/确认、24 小时保留期、引用保护、单轮上限和上传互斥 | `runtime/test/release-artifact-api.test.ts`、`runtime/test/release-artifact-store.test.ts`、`runtime/test/release-bundle.test.ts` | 通过（硬存储配额和单包解析峰值优化待硬化） |
| Bundle 凭据排除 | 上传与 Agent 暂存拒绝常见凭据专用路径、私钥/知名 token、URL/DSN userinfo、查询参数、Basic Auth 和跨行配置字段；运行时引用/token 元数据可通过；错误不回显内容 | `runtime/test/release-bundle.test.ts`、`runtime/test/release-artifact-api.test.ts` | 通过（启发式，不保证检测所有秘密；有引用的 digest 不被 GC 删除） |
| 可执行部署计划 | 仅 ready release + 新鲜 ready preflight + 匹配 systemd 入口生成 typed actions，审批时复核目标/快照/制品 | `runtime/test/service-deployments.test.ts`、`runtime/test/release-artifact-api.test.ts` | 通过（真实 Linux 目标仍待验证） |
| Agent 健康成功 | 计划含授权 health_check 且最终结果有 `health.healthy=true` 后才进入 succeeded | `runtime/src/agent/executor.ts`、`runtime/src/server/agent-jobs.ts`、`runtime/test/service-deployments.test.ts` | 通过（不代表中心遥测已验证） |
| 中心遥测验证 | 业务部署后查询 ClickHouse 核对新遥测 | `runtime/src/deployment/verification.ts`（仅有界判定器） | 待实现 |
| 部署状态可读性 | 中文/英文显示各阶段；unknown 提示人工检查；成功文案说明遥测未验证 | `web/src/app/ServiceDeploymentsPage.tsx`、根目录 `npm run typecheck` | 通过 |
| 遥测延迟 | 显示部署成功、遥测未验证，不误报失败 | `runtime/test/deployment-verification.test.ts` | 通过（有界证据；真实查询待接入） |
| 健康失败回滚 | 仅管理员确认后恢复已登记的 previous release；自动补偿不在本切片 | `runtime/test/service-deployments.test.ts`、`runtime/src/agent/executor.ts` | 人工回滚闭环通过；自动补偿待实现 |
| 恶意输入 | 路径、unit、URL、shell、过期签名均拒绝 | 安全负向测试待实现 | 待验证 |
| 权限和审批 | 只有管理员能 apply/build/approve/rollback | instrumentation apply API + service deployment API + `service-deployments.test.ts` | 部分通过（插桩 apply、approve/rollback；build 待实现） |
| 重试和未知结果 | operation/job 幂等；租约过期和 Agent 重启回报 unknown | `runtime/test/agent-jobs.test.ts` | 通过（真实 probe/补偿仍待后续） |

## 必跑检查

实现代码后，在仓库根目录运行与变更匹配的检查，并将完整命令和结果补入此处：

```bash
npm --prefix runtime run typecheck
node --import tsx --test test/agent-jobs.test.ts test/service-deployments.test.ts # from runtime/
npm run typecheck
npm test
git diff --check
```

根目录通过 npm scripts 依次检查 runtime、ai-runtime、web 和 TypeScript SDK；runtime 脚本固定串行，避免后台生命周期测试互相争抢资源。

本次已运行：

- `npm --prefix runtime run typecheck`：通过。
- `npm --prefix runtime test`：历史基线串行运行 286 tests，272 passed、14 skipped、0 failed；本轮新增一项 Agent 阶段测试后，最新 runtime 套件为 287 tests、273 passed、14 skipped、0 failed。并发运行会让时序敏感的后台生命周期测试互相争抢资源，因此脚本固定串行。
- `npm test`（根目录，当前代码）：runtime 287 tests（273 passed、14 skipped）、ai-runtime 71 passed、TypeScript SDK 18 passed；0 failed。
- 插桩专用 `node --import tsx --test runtime/test/instrumentation.test.ts`：8 passed、0 failed；AI 工具专用 `node --import tsx --test runtime/test/assistant-instrumentation-tools.test.ts`：2 passed、0 failed；部署状态/迁移专用测试通过。
- `npm run typecheck`：runtime、ai-runtime、web 均通过。
- `git diff --check`：通过。
- `web/src/app/ServiceDeploymentsPage.tsx` 状态双语文案和 unknown/遥测提示已通过 web TypeScript 检查。
- `npm --prefix web run build`：通过，产物打包成功；依赖中的 `use client` 指令有现存 bundler warning。

本轮新增验证：Agent 阶段回执与部署状态/时间线在同一 SQLite 事务内写入；管理员取消或过期的未领取 job 可安全终止，已领取 job 取消/超时保留 unknown，中心定时扫描不依赖 Agent 再次请求；事件序号连续、阶段单调且拒绝跳跃/回退；审批要求计划含 capability 授权的 health_check；只有 verifying 后且最终 `health.healthy=true` 才能进入 succeeded；缺少证据的成功回执被转成 unknown；秘密和原始快照不会进入部署详情/时间线。

本轮追加切片：部署工作台仅对 ready 且含 actions/capabilities 的计划显示批准入口；管理员可取消未审批计划，或在 Agent 尚未领取时取消已批准 job。Agent 已领取后，取消请求被拒绝以避免把“取消”误解为远端进程已停止。Doca 在线副本回读状态仍需单独记录。

本轮追加切片：管理员可为目标配置 systemd unit 和受控 release directory，提交独立只读 `systemd.probe` Agent job，并在工作台查看快照新鲜度。中心校验结果并去除 Agent 额外字段，绑定 target/Agent/config revision，TTL 10 分钟。该预检不启动或修改业务服务；部署计划现在可绑定 ready bundle、生成 typed actions，并由 control credential + job lease 授权 Agent 下载；真实 Linux 主机仍待验证。验证命令：`npm --prefix runtime run typecheck`；`npm --prefix runtime test`（串行通过）。

本轮 UI 补充：管理员可以编辑已登记目标的 systemd unit 和受控目录；预检完成后工作台展示 systemd/unit 状态、当前版本、目录存在和可写情况、有效期及安全错误码，并在平台不支持安全目录检查时显示对应提示。人工回归中的预检步骤通过 Agent `systemd.probe` job 执行，不依赖 SSH。根目录 `npm run typecheck` 和 `npm --prefix web run build` 通过。

本轮安全补充：Agent 文件系统动作改用 Linux `/proc/self/fd` 锚定目录句柄并逐级 `O_NOFOLLOW`，避免路径检查后被 symlink swap；`current` 指针使用 `O_NONBLOCK` 打开并仅读取普通文件，避免 FIFO 阻塞 Agent job loop。macOS Agent 不声明安全目录检查可用，预检保持 not-ready；暂存与激活在非 Linux 平台明确拒绝。工作台区分“安全文件系统检查不支持”和“目录缺失”。

本轮既有验证结果（2026-10-22）：`npm run typecheck` 通过；runtime 串行全量 272 通过、14 跳过、0 失败；release bundle、artifact API/store 和安全路径负向测试通过；`npm --prefix web run build` 通过，仍有依赖包 `use client` 指令和大 chunk 警告；`git diff --check` 通过。macOS 上 Linux `/proc/self/fd` 文件操作测试（含 stage/activate、FIFO、权限祖先检查）按平台跳过，本机不能验证真实 Linux systemd。Doca 回读未完成；2026-10-23 的访问检查确认当前运行环境没有 bearer-token 凭据，在线设计增量仍未同步，不能标记完成。

本轮安全修复（2026-10-23）：只按文件名排除 `.env`/私钥等路径会漏掉 `config/app.json` 中的明文 key，随后 release 文件会变为主机用户可读。中心上传与 Agent 暂存共用 bundle 凭据检查，覆盖常见保留路径、私钥/供应商 token、URL/DSN userinfo、凭据查询参数、Basic Auth 和跨行有值字段；检查按有界重叠窗口处理、只解码 percent 编码一次，错误仅返回固定错误，不回显匹配内容。`${ENV_VAR}` 等常见占位符/运行时引用和 `token_count` 等元数据通过。复核还补了超长字段值及跨窗口空白用例。该检测是启发式拒绝规则，不能证明无秘密；制品只能包含运行文件，真实凭据仍须由目标机独立秘密管理注入。被拒绝上传不会使 release 就绪；bundle blob 留在私有 digest 存储，供引用感知 GC 清理，不会因校验失败误删共享 digest。定向验证和完整验证结果见下方追加记录。

2026-10-23 完整验证：`npm test` 通过（runtime、AI runtime、TypeScript SDK 全量测试）；`npm run typecheck` 通过；`npm --prefix web run build` 通过；`git diff --check` 通过。前端构建仍报告依赖包 `use client` 指令与大 chunk 警告。定向凭据扫描/API/Agent executor 验证：25 项中 14 通过、11 项 Linux 专属测试在 macOS 跳过、0 失败。完整 `npm test` 覆盖新增扫描回归；本机仍无法替代 Linux root 权限的目录句柄和 systemd 实机验收。Doca 图块增量仍待有权会话写入并回读。

本轮补充：release 根目录预检及执行现要求 root 所有、Agent 所属组有写权限、其他用户可读/遍历但不可写；失败的格式或 manifest 上传不再按共享 digest 立即删除，避免破坏其他 ready release。新增同 digest 误传回归测试。回滚结果未知会结束当前操作并保留 unknown receipt；管理员必须检查主机并通过较新的安全 preflight 后才能显式重试。普通部署 job 不得跳过 staging，阶段跳过例外只适用于固定 rollback action 组合。本机 macOS 不执行 Linux 目录句柄测试，必须由 root 权限 Linux CI/实机验证该权限门。

本轮新增回归验证：`node --import tsx --test test/agent-jobs.test.ts test/service-deployments.test.ts`（工作目录 `runtime/`）：8 passed、0 failed；覆盖普通部署不得跳过制品暂存、首次部署拒绝回滚、错误 current-version 成功回执不得标为 rolled_back、unknown 后不允许复用旧预检，并且管理员新预检后可显式创建新的 rollback operation。新增改动完成后，根目录 `npm test` 与 `npm run typecheck` 均通过；`git diff --check` 通过。

2026-10-23 制品并发门控：管理员上传路由使用每进程一个准入槽，覆盖私有落盘、bundle 解析/凭据扫描和 release ready 更新；槽满返回 `503 artifact_upload_busy`、关闭连接且不积累等待队列。集成测试通过受控慢速上传验证第二个有效请求被拒绝，而首个请求完成后槽位可用。该门控不消除单个最大 bundle 的高峰内存占用（压缩、解压与文件副本可能同时驻留），也不提供跨进程配额。

2026-10-23 管理员孤儿 GC：新增 `POST /api/v1/admin/release-artifacts/gc`；默认 `{}` 仅 dry-run，只有 `{ "confirm": true }` 才删除。保留所有 release 状态记录的 digest，只处理 mtime 超过 24 小时的普通内容文件；每轮最多扫描 10,000 项、删除 500 项，跳过符号链接、异常名称和硬链接，并和上传共用单进程互斥门。达到上限提供当前进程内最多有效 5 分钟的游标，绑定模式和初始截止时间，后续轮次重新读取 release 引用；新扫描、完成、重启或超时使旧游标失效并释放目录句柄。读取与 GC 共用可信祖先 UID/写权限校验。API 覆盖管理员拒绝、严格请求类型、双向 busy 互斥、dry-run、确认删除、cursor 续扫及 pending release 引用保护；存储覆盖 10,102 项扫描续页、500 项删除上限不漏后续条目、最新引用保护、截止时间不漂移、cursor 模式/失效和 unsafe ancestor/symlink/hardlink。定向 API/store 共 10 项通过；runtime 全量 279 passed、16 skipped、0 failed；AI runtime 71 passed、TypeScript SDK 18 passed；全仓 `npm run typecheck` 通过，最终 runtime 类型检查及 `git diff --check` 通过。已 fetch 远端，`origin/main` 没有本分支未包含的提交。

硬磁盘配额、跨进程锁与单包解析峰值优化仍待实现。Builder 审查确认当前 `CodeTaskService` 不是操作系统沙箱，本机也没有 Docker/Podman/bwrap；自动源码构建 T007 继续待实现，不能在中心身份下执行用户脚本。Doca MCP 工具及资源目录均为空，浏览器再次访问在线基线仍显示“文档不存在”；本轮未向 Doca 写入，在线同步发布门保持未通过。

- deployment adapter unit tests（合法/非法路径、摘要、健康检查、rollback）及 service deployment 状态迁移/审批/事件测试；
- deployment verification tests（服务/实例归属、UTC 窗口、deadline、样本上限和健康但遥测未验证）；
- SQLite migration/repository 与 API 权限/幂等集成测试；
- Agent job claim/lease、事件幂等、结果、过期 unknown、重启 unknown、capability allow-list 和回执脱敏测试；`npm --prefix runtime exec tsx -- --test runtime/test/agent-jobs.test.ts runtime/test/agent-job-runner.test.ts runtime/test/agent-executor.test.ts`：5 passed、0 failed。
- scanner fixture、golden diff、revision conflict 和 secret 排除测试；
- 临时 systemd/mock executor 的成功、失败回滚、Agent 离线、遥测延迟端到端测试；
- `rg` 检查 token、密码、私钥和原始 SSH 输出没有进入源文件、日志样例、PR 或文档正文。

## 手工回归步骤

1. 建立一个只含测试服务的 workspace，运行扫描并确认没有读取 `.env` secret。
2. 生成插桩 diff，修改 workspace 后尝试 apply，确认 revision conflict；恢复后由管理员 apply 并核对 changed files。
3. 为目标机器登记 systemd unit 和受控 release directory，通过 Agent `systemd.probe` 执行只读预检；检查状态诊断和有效期展示，修改目标配置后确认旧快照失效；未激活 Agent 时确认 deployment approve 被拒绝。
4. 激活 Agent，创建 systemd plan，核对 typed actions、制品 digest、previous snapshot 和 review URL。
5. 管理员 approve，观察 Agent 事件和健康检查；用中心查询验证新 batch，核对 deployment timeline。
6. 用故意失败的 health check 触发 rollback，确认旧版本恢复且 Agent 仍心跳。
7. 模拟 Agent 断线/进程重启，确认状态为 unknown/重探测，不发生盲目重复 restart。
8. 在 Doca 写入前读取最新版本；保存后回读设计文本、流程图节点和边。图应包含源码 workspace、SDK 扫描/人工确认/构建、Agent preflight、systemd 计划、管理员批准、已接入的 Agent job/executor 协议以及待实现的真实验证/回滚边界。

## PR 发布前检查

- [x] 代码只在功能分支，目标为 `main`，没有直接推送主干。
- [x] SDD 任务状态和实现一致；未实现 provider 明确列在限制中。
- [x] `docs/system-design.md` 与 SDD/contracts 已同步本轮安全架构；Doca 对应原生图块增量仍未完成。
- [ ] Doca 原生图块已写入并回读节点和连线；当前执行环境缺少受保护的 bearer-token 运行时凭据，且浏览器显示资源不可访问，恢复安全访问后补齐并更新本 PR。
- [ ] 管理员审批、secret 脱敏、SSH 清理提示和错误码均有 UI/AI 展示。
- [x] 根目录 `npm test` 和 `npm run typecheck` 通过；Agent 只读 preflight、release bundle 上传/下载/安全解包、systemd typed actions 和管理员确认的回滚闭环已实现并由测试覆盖，真实 Linux 主机验证、受控源码构建、中心遥测验证和自动补偿仍待实现。
- [x] PR #25 已创建并保持待审核；未经用户明确授权不合并。
