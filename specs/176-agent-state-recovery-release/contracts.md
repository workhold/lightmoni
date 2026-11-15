# 发行契约

- 镜像为 `docker.heyphp.com/lightmoni/lightmoni:v0.1.3-20261115-164421-amd64`，不使用 GitHub 流水线，不发布 arm64 中心镜像。
- OCI revision 与内置 Agent 的 source_revision 必须等于版本 PR 的 main 合并提交。
- 不覆盖旧固定标签，不把发布或中心部署写成 Agent 已恢复。
