# Agent 安装、卸载与维护执行器验证

## 已复现及修复

1. 独立卸载遗漏有限脚本的 `task-run-state.json`，且 unit 不存在时绕过未完成操作检查。非空执行 ID 或运维执行锁现在都在服务分支前检查；拒绝卸载与显式 purge，不停止服务、不删除文件或数据。
   - 修复前：脚本任务标记的 inactive/not-found × uninstall/purge 四项回归全部失败，空 ID 允许卸载一项通过。
   - 修复后：扩大至 script task、Agent job、运维锁三类标记，两种服务状态与两种删除选项，共 12 项拒绝场景及一项已完成空 ID 场景全部通过。
2. 真正空主机首次安装在激活后启动失败，文件回滚留下本次创建的空程序目录；下一次 fresh 被自己的残留目录阻止。现在仅在回滚成功时以非递归 `rmdir` 清理本次新建且仍为空的 releases 及程序根目录。
   - 修复前：实际 shell 安装失败回滚后再次 fresh，在 `Existing Agent installation detected` 被拒绝，失败回归一项。
   - 修复后：再次 fresh 能完成安装；原有 Node/Go 回滚、旧身份拒绝 fresh、配置和队列保留回归继续通过。

## 验证结果

- `node --import tsx --test --test-concurrency=1 test/agent-uninstall-script.test.ts test/install-release.test.ts test/agent-update-runner.test.ts`：39/39 通过（扩大标记矩阵前，卸载 5、安装 15、维护 19）。
- 扩大的 `agent-uninstall-script.test.ts` 单组：13/13 通过；安装和维护源码未因矩阵扩展再修改，覆盖合计 47 项。
- 三个 shell 脚本分别执行 `sh -n` 通过；`node --check deploy/agent/update-runner.mjs`、`git diff --check` 通过。
- 保留已有 fresh 覆盖保护：正常卸载保留身份与配置后仍不能 fresh 重装，本轮不引入重装协议。

## 测试边界与架构影响

测试运行真实安装/卸载 shell，但所有绝对可写路径均改写至临时目录；id、systemctl、安装/发布下载行为使用隔离 shim。未连接 vchive，未执行真实 SSH/systemd、生产安装/卸载或镜像构建。本证据不宣称真实 Linux 服务验收。

本文件所列执行器修复的架构同步为“不适用”：补全既有未完成任务互斥及失败回滚契约，未改变协议、身份、数据通道、持久目录或部署拓扑。SDD053 其他安装恢复设计的整体架构影响由主验证记录单独评估。
