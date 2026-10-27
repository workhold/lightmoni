# SDD 026：实施计划与最终设计

日期：2026-10-27。实现、证据和待完成事项分别记录，最终交付状态见 [tasks.md](tasks.md)。

## 技术决策

沿用 Node.js/TypeScript 中心、SQLite、React 和 Agent pull job，不引入第二个控制面，不复制第三方面板代码。`runtime/src/operations` 为 website、certificate、compose、backup 提供 `validate/publicConfig/validateInput`；中心统一管理登记、revision、不可变方案、批准和执行记录，领域执行器负责真实 Nginx/Certbot、Docker/Compose 与文件/S3 操作。

配置保存和现场执行分离。`ops_resources` 保存节点、revision 和加密 config；`ops_runs` 保存不可变加密 payload、脱敏 preview、授权者、30 分钟有效期和 job；`ops_schedules` 保存加密输入、固定动作、目标 revision、Cron/时区和持续授权者；`ops_schedule_fires` 以 schedule_id＋UTC slot 去重并记录 schedule_revision。明确字段见 [contracts.md](contracts.md)。

普通 job 只含 operation ID、domain 和 capability，不保存私钥或 S3 秘密。Agent 使用 control credential＋当前 job lease 读取匹配节点、动作和批准记录的私有 payload，禁止重定向并限制载荷大小。中心 API 和 AI 工具均检查管理员；AI 仅可读取或提案，网页批准才创建真实 job。

## 节点执行与并发

同一 Agent 的 job 租约负责调度，但租约到期不能证明外部命令已停止。额外以 `dataDir/operations/execution.lock` 对全部运维写动作持久互斥，文件包含 operation ID、PID、时间和 executing/unknown 状态，以独占创建、0600、fsync 写入。unknown 或崩溃不自动释放；管理员核对原进程、子进程、Docker daemon、Nginx/文件状态后才可人工删除。只读动作不取得该写锁，可继续检查。不得复制同一 Agent 身份到不同 dataDir 并发运行；不同 dataDir 不是同一节点的分布式 fencing。

Compose 另有项目锁、节点归属 registry、generation 和 pending journal。固定 `docker --context default`，防止继承 `.docker/config.json` 的 currentContext；不支持任意远端 context/rootless socket。进程命令使用参数数组、shell:false、最小环境、超时/取消和合计输出限制，POSIX 失败时终止进程组。禁止继承 DOCKER_HOST、DOCKER_CONTEXT 或中心秘密环境变量。

资源执行中禁止改配置；批准事务检查资源 revision、有效期和同资源活跃任务。成功回执必须绑定当前 operation/resource 并带验证证据。部分修改、超时、结果过大或补偿失败不能确认时返回 unknown，既不自动重放，也不按模型解释改成成功。

## 领域设计

### 网站与证书

独占受管 Nginx 网关，不抢占现有 80/443 或改写其他面板。static 只接受小型 UTF-8 文本映射，proxy 使用无 userinfo/query/fragment 的 HTTP(S) upstream，默认验证上游 CA。配置先语法检查再切换，实际 HTTP 配置摘要与 HTTPS peer fingerprint 证明生效；失败恢复并复验。公共资产独立于私有 Agent dataDir，root master 降权 worker；私钥保持 0600。

共享 certificate_id 是动态依赖，不能声称网站 revision 冻结证书历史指纹。中心和 Agent 保护绑定站点的域名，换证时校验 SAN、握手和失败补偿。ACME 使用真实 Certbot webroot HTTP 验证，要求同域受管 HTTP 站点在 80 端口已生效并可读 challenge；不自动操作 DNS，续期通过显式动作或管理员计划。

### Compose

使用受限 JSON，不接收任意 YAML/宿主路径。登记和发现不授予写权限；所有写动作绑定 expected_generation，adopt 另绑定 inventory_sha256 与 acknowledge_recreate。受管标签、registry 和配置摘要共同核对归属。接管卷/网络使用核验后的真实名称，产品不删除数据卷。每个写动作保存新 generation，最多 1000 代；配置 rollback 只恢复配置。unknown 需人工核实、解除节点锁，并以新 apply/rollback＋acknowledge_unknown 收敛，原 operation ID 不重放。

### 备份与恢复

仅备份可信 root 目录的普通文件/子目录，拒绝链接、硬链接、特殊文件、越界、来源/存储重叠和不安全权限。默认 64 MiB/10000 文件，可设置到 256 MiB/20000；归档是 gzip manifest，含源目录模式、逐文件模式/内容/SHA256。该格式不会过滤业务秘密，也不加密归档正文。

本地按 resource ID 隔离、0600 原子落盘；S3 使用真实 SigV4 path-style PUT/GET/LIST/DELETE，限定 bucket/prefix/resource，HTTPS 仅本机测试可例外 HTTP，禁重定向。create 写入后回读核验；restore 先以 expected_target_sha256 做 CAS，保存 pre_restore，暂存校验，再次 CAS、rename 替换和现场复验。成功后的旧目录清理失败显示 cleanup_pending；补偿失败显示 unknown/recovery_required。pre_restore 永不自动 prune。

list 最多返回 100 条并保留 total/truncated；prune 处理完整受支持清单但只返回前 100 个删除 ID及 removed_total/truncated。S3 对象版本截到 128 字符，受支持目录/清单总量另有上限，不能把输出裁剪当无限容量承诺。

### 调度

五字段 Cron＋IANA 时区，UTC 分钟 slot 唯一去重；DST 回拨的两个 UTC slot 可各触发一次。中心启动或错过的分钟不补跑。只允许 backup create/verify/prune、certificate renew、website inspect、compose inspect；不允许周期恢复、重启或任意 shell。每次触发重查 users.active/admin 和 resource revision；同计划活跃任务跳过当前 slot。dispatching 中断/unknown 会冻结，管理员显式修改计划 revision 才能重新授权新 slot；人工运行采用相同动作、授权和互斥边界。

## 模块与界面

- 中心：`server/operations.ts`、`server/operation-schedules.ts`，接入既有 `agent-jobs`、凭据和数据库。
- Agent：`agent/operations.ts`、`agent/operation-lock.ts`、`agent/jobs.ts` 及四个领域执行器。原业务 systemd 发布不伪装为 Compose bundle 部署。
- Web：`OperationsPage.tsx` 统一网站、证书、Compose、备份、计划五页签；配置表单、预览、人工确认、回执/历史、中英文、主题及响应式布局。
- AI：`assistant/operation-tools.ts` 只注册 list/get/propose。网站/Compose 正文只返回数量/字节/服务摘要，资源分页按 28 KiB 预算给 next_offset；已知回执列表显式裁剪并保留 generation/hash。持久化提案只返回轻量 metadata/ID/review_url，避免写入后因正文过大报错；日志回执整段省略。

## 验证与交付

验证分层：领域单元/协议夹具 → 真实 SQLite/HTTP/租约/Agent 通路 → 真实 Linux Nginx 和 Docker → 隔离网页交互。夹具只证明协议、输入和失败边界；不得代替公网 ACME、真实 S3 厂商或生产并发/容量验收。证据见 [validation.md](validation.md) 和领域记录。

较早全量 runtime 回归为 359 通过、17 跳过、0 失败；后续补丁须完成最终定向复验。Web build 已通过。仓库系统设计与 Doca 必须同 PR 同步并最新版本回读；当前 Doca 编辑器异常，该步骤未完成。最后同步远端、检查 diff、补最终验证并创建待审 GitHub PR，由主任务核对；不直接推主干、不自动合并。
