# 发行契约

- 镜像名为 `docker.heyphp.com/lightmoni/lightmoni:v0.1.2-20261115-152221-amd64`，不使用 GitHub 流水线，不发布 arm64 中心镜像。
- 构建源码必须是版本 PR 合入后的 main 合并提交；不得推送未合入功能分支或本地脏工作区。
- 凭据只使用受保护的 Docker 凭据状态，不进入命令日志、仓库、镜像层、URL 或文档。
- 本 SDD 不授权自动生产升级、自动恢复、自动卸载或清除 unknown。
