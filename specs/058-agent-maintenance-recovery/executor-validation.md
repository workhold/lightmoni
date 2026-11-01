# 离线卸载、脚本交付与升级/回退验收

## 实现与缺陷修复

- 平台固定 SSH 模板与离线脚本共享 `agentMaintenanceShellGuards`，以文本一致性回归阻止两套检查漂移。固定程序及关键祖先要求常规类型、无符号链接、root 所有且不允许其他用户写入；Agent 数据目录保留专用服务用户所有权。
- 执行锁及 task/job 标记以保守策略检查。仅不存在、空对象或显式空 id 可以放行；目录、链接、悬空链接、过大、不可读和不确定内容阻止卸载。另覆盖 awk 会截断 NUL 的实测差异，先按字节数拒绝二进制损坏，再校验 JSON 空状态。
- 停止服务后、禁用或删除前再次检查路径及任务标记，避免停止期间迟到的任务标记被忽略。正常卸载保留配置、身份和队列，`--purge` 才删除两个固定 Agent 数据目录；不移除系统账户或业务目录。缺少 identity、部分程序及已移除状态可离线清理，手动脚本明确不撤销平台凭据。
- 新发行把 `uninstall.sh` 放入校验过的 runtime 包；安装到 `/usr/local/sbin/lightmoni-agent-uninstall`，失败精确恢复原文件/权限，并清除本次创建的空目录。旧包没有此脚本时保留现有 helper，继续兼容已校验包。
- 管理员无需 enrollment 即可通过固定 `GET /api/v1/agent-maintenance/uninstaller` 取得文件名、脚本和精确 SHA256；成员/未登录请求拒绝，缺失、目录、链接及超大文件不返回。
- 升级与主动回退同步目标 runtime 自带的卸载脚本；失败恢复原 helper 字节与权限，原本不存在时清理新 helper 及本次创建的空父目录。旧包无 helper 时记录 `uninstaller_updated:false`。新 runtime 的脚本摘要纳入程序指纹，手改回退源脚本会令回退证据失效；无脚本旧 runtime 的原指纹保持不变。升级任务标记检查也拒绝异常 JSON 和悬空执行锁。

## 已执行检查

1. `node --import tsx --test --test-concurrency=1 test/agent-uninstall-script.test.ts test/agent-uninstaller-download.test.ts test/install-release.test.ts test/agent-update-runner.test.ts`：首轮 **69/69 通过**（离线 32、下载 2、安装 16、原升级/回退 19）。
2. 扩展 helper 事务及指纹后单独执行 `test/agent-update-runner.test.ts`：最终 **30/30 通过**，包括主动回退、自动恢复、缺失/旧 helper、符号链接目标、异常标记与回退源手改。
3. 最终收紧 JSON 空白与 NUL 后执行 `--test-name-pattern='standalone and platform|uncertain task marker|cleared script marker|rolled-back fresh' test/agent-uninstall-script.test.ts test/install-release.test.ts`：**11/11 通过**。其中 NUL 用例曾复现失败，增加字节检查后通过；fresh 回滚断言包含 helper 与本次创建的空目录。
4. `npm run typecheck`、`sh -n deploy/agent/install.sh deploy/agent/uninstall.sh`、`git diff --check` 均通过。

## 证据边界

上述使用重写固定路径的临时目录、合成 root/stat/systemctl 与 SQLite/HTTP fixture；stat 模拟 root 身份但保留真实权限位，仅验证拒绝/恢复逻辑，不宣称真实 Linux root 所有权、systemd 或 SSH 验收。临时目录由测试清理；未 SSH 生产或 vchive，未安装依赖、构建大包、启动 VM 或发布镜像。发行包实物检查新增脚本内容断言，但本轮未设置 `LIGHTMONI_RELEASE_DIR`，不将它计作已执行的真实双架构打包验收。
