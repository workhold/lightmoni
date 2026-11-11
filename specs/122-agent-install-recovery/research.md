# Research

## 已确认根因

线上同一主机三次首装均在 enrollment 前退出。唯一程序残留为 Agent 服务覆盖目录内的 `20-docker-access.conf`，添加 `SupplementaryGroups=docker`。安装器正确拒绝覆盖；预检漏报、卸载漏删、错误码未透传导致反复失败。调查未执行线上清理或重装。

## Decisions

- Decision: 两个固定覆盖目录作为现有程序足迹。Rationale: 空目录和悬空链接也必须拒绝 fresh，避免检查与安装漂移。Alternative: 放开覆盖或静默删除会绕过权限限制，拒绝。
- Decision: 使用同一共享 shell 保护块校验与删除。Rationale: 线上/离线入口一致；仅接受 root 所有且其他用户不可写的平面普通文件，有界摘要纳入既有快照。Alternative: 无条件 rm -rf 或忽略计划后变化不满足原卸载契约。
- Decision: 非零退出仍保留 unknown，提供具体拒绝原因；恢复错误后读回原记录。Rationale: SSH 退出不能证明没有远端副作用，不能重放安装或伪造终态。Alternative: 仅按错误文本自动标 failed 不安全。
- Decision: 不引入新技术或外部集成；所有信息来自仓库与已采集的线上证据，无待研究的技术选择。
