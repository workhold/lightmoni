# Data Model

不新增数据库字段或迁移。

- agentInstallationPaths 补齐两个固定服务覆盖目录。
- AgentRemovalObservation.program_sha256 继续为不透明摘要，增加覆盖目录元数据、文件名、内容和文件元数据；paths_safe 包含目录/子项校验；installation/helper_present 包含覆盖残留。
- removedAgentPaths 增加两个固定目录，现有计划展示与回执沿用。
- SSHRemoteFailure.remote_reason_code 白名单增加既有安装器的 agent_service_override_not_allowed，仍不保存任意日志。
- 部署 unknown/resolved 等状态、enrollment 撤销和审计语义完全沿用。
