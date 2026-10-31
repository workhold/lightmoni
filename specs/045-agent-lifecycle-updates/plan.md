# 实施设计

## HLD

主机管理/AI 提案 → 固定发行计划 → 用户审批 → 中心 SSH 编排 → root systemd 独立维护器 → 原子切程序 → 新 Agent 出站 control 心跳 → 中心确认 commit。无确认则远端超时回退；不确定则 unknown→只读核对。

中心持久保存发行内容寻址缓存、维护计划/回执、下载票据散列与批次。缓存随平台 dataDir 保存，不依赖容器内 downloads 目录在审批后保持不变。下载票据与 enrollment/control/data 完全分离。

## LLD

- `machine-agent-updates.ts`：目录、计划、审批、后台健康确认、历史/核对、串行 rollout、平台启动恢复。
- `machine-agent-update-ssh.ts` 与 `deploy/agent/update.sh`：固定命令和独立 systemd worker，root 私有事务目录、安全 JSON receipt、生命周期锁、安装指纹及审批运行状态比较、确认期限。
- `agent/release.ts`：从本进程实际运行代码所属发行目录读取 metadata/安装摘要，不能动态读取 current 后把旧进程误报成新程序；boot_id 为进程实例唯一值。
- `build-agent-release.mjs`：构建 revision/build/schema、外部发行清单和维护器；首装写可读的非秘密安装摘要。
- `managed-machines.ts`/task/job/lifecycle：统一维护 fence，现有任务与生命周期操作双向阻塞。
- UI：主机通道显示真实运行版本；审阅单机升级/回退、历史与核对；批量逐机审阅和结果。
- AI：查询版本、准备升级/回退、查询结果；仅返回安全元数据和审阅链接。

状态数据兼容域固定为 schema 1；只回退程序而不恢复队列。旧受管 0.1.0 Node 安装须明确识别为现行 schema 1；任意未知 manifest/程序不按兼容推测处理。所有远端返回有大小和形状限制，错误持久化采用固定安全信息。

## 验证与文档

执行器独立真实 Linux 验证，中心用真实 SQLite/HTTP 与可控 SSH runner 覆盖状态和故障注入，UI 浏览器检查。同步系统设计、部署文档、README 和 Doca 原生控制/状态图，读回最新在线版本确认。

## 主干集成实施

在隔离 worktree 合并最新 main；逐项解决系统设计、Agent 心跳、节点 API、任务派发和主机页面冲突，保留双方能力。通过 AgentUpdateAccess 的凭据使用回调复用集中凭据记账，避免更新模块直接依赖凭据库实现。补充集成测试并运行升级/身份/任务回归、类型检查、构建与浏览器 fixture。保持原 045 维护协议与架构，系统设计合并由主线程统一核对 Doca。
