# SDD 173 契约

## 恢复运行时

- 候选顺序为 current 的合法受管目标，再为 releases 的直接子目录；不使用递归查找、环境变量路径、用户输入或任意命令。
- `node`、`release.json` 必须是非链接的 root 安全文件，发行目录必须 root 所有且不对组/其他用户可写；Node SHA256 必须等于清单的 `node_binary_sha256`。
- 该选择只证明“有一个可启动维护器的运行时”，不证明当前 Agent 发行健康，也不改变更新状态。真实恢复结果仍由原维护器和平台记录决定。
- 没有合格候选返回固定错误；原始 stdout/stderr 不进入 AI、页面或日志。

## 内联恢复

- reconcile：同一记录 POST `/reconcile`，默认使用原审批凭据；只读核对可以更新平台记录，但不得重放远端维护。
- recover：管理员先审阅并勾选；POST 前 GET 复验相同 machine/update ID、unknown、`recovery_revision` 和 `recovery_requires_verification=false`，再提交 `{confirm:true,expected_revision}`。
- revision 变化、记录变化、上次恢复未核对、成员或 malformed 响应均不得恢复。失联响应保留 unknown 并提示重新只读核对，不自动重试。
- 更换 SSH 凭据、批次控制和完整技术证据仍使用原主机管理窗口。
