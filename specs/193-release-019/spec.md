# SDD 193：0.1.9 Agent 生命周期修复发布

## 目标

将 PR #266、#267、#268 合入后的 `main` 作为 0.1.9 发行：统一平台、Agent、SDK、MCP 与构建默认版本，发布 linux/amd64 中心镜像，更新生产中心，并用新中心验证维护围栏闭环与剩余 Agent 升级入口。

## 范围与验收

1. 版本号由统一脚本从 0.1.8 升至 0.1.9，`version:check` 全部通过；Compose 使用固定 `v0.1.9-<UTC 时间戳>-amd64` 标签。
2. Runtime、AI Runtime、Web、TypeScript SDK 构建通过；Agent 生命周期维护围栏、主机批量按钮和 Agent 更新定向回归通过。
3. 从合入后的最终 `main` 提交本地构建 linux/amd64 镜像，不用 GitHub 流水线；镜像 OCI revision 必须等于该提交。
4. 隔离验收中心与 ClickHouse 健康、首页、`/healthz`、实例版本、MCP 版本、双架构 Agent 包和 SDK 校验和后，才推送固定标签与 `latest` 并回读摘要。
5. 生产保留既有 Compose、`.env`、主密钥、状态卷与遥测卷；切换前做轻量一致性备份，切换后核对中心/ClickHouse 健康、实例版本、维护围栏页面和按钮状态。
6. 剩余 Agent 升级仍走原生审批批次；失败、回退或 unknown 暂停后续主机。升级成功必须回读精确版本、源码修订、包摘要和心跳，不能用中心镜像版本替代主机验证。

## 兼容与边界

- 本 PR 只做统一版本准备与发行 SDD，不改变组件职责、协议、存储、凭据或部署拓扑。
- 中心镜像不会自动升级已安装 Agent。
- 生产业务应用恢复和历史 unknown 审计继续沿用原有领域流程；发布成功不等于应用绑定恢复完成。
- 功能架构影响已在 PR #268 的 SDD 192 与 `docs/system-design.md` 中记录。
