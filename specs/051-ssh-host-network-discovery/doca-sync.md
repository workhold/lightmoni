# 架构同步记录

- 架构影响：是，SSH 安装检查在同一已验证会话中增加有界只读网络发现，安装 Agent 前可观测主机名与网卡；快照来源和平台连接来源独立失效。
- 仓库：`docs/system-design.md` 第 13.7 节补齐发现、存储、`observed_via`/`hostname`、SSH 目标代际与 Agent 身份边界；第 13.6 节总览图增加 SSH 直接发现分支，第 13.7 节增加分路流程图。
- Doca：[LightMoni 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)。使用 fresh MCP context、当前 writing（文档创作）手册和最新 schema，以局部 rich_text_edit 保存原生段落与流程图。
- 最新版本正文回读：第 13.7 节 7 段正文与仓库逐段一致；原总览图保留 7 个节点 ID/坐标，更新标签并增加一条发现连线，7 节点/7 连线精确回读；新增分路图 10 节点/10 连线精确回读。
- 原有 23 张原生图中，仅上述目标图按本次设计修改，其余 22 张逐字段一致。551 个无关原有块的内容、属性、ID 保持一致，所有原有块 ID 与顺序保留；仅新增 5 个块，无整篇替换。
- 保存与最新版本回读均已确认；未将结构回读称为浏览器视觉渲染验收。机器可读证据：[doca-readback.json](doca-readback.json)。
- Doca token 仅存在于 getpass worker 内存，通过 0600 本地 Unix socket 提供 MCP 调用；不进入仓库、文档、URL 或日志。同步不连接生产平台或 vchive。
