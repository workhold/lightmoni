# SDD 182 契约

- 合法标签为 `images`、`registry`、`sources`，缺失或未知标签回退 `images`。
- `/private-images` → `/image-management?tab=registry`；`/image-sources` → `/image-management?tab=sources`，均使用 replace 导航。
- 仓库摘要可跨 Registry 标签提供上下文，但镜像版本只属 `images`，对外入口只属 `registry`，凭据和代理只属 `sources`。
- 镜像查询 POST 仍是原只读任务协议，不计为配置写入；不得新增其他配置、凭据或代理写请求。
