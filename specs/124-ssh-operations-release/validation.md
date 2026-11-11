# 验证记录

## 发布前

- GitHub #167、#168、#170 均已合入；查询时开放 PR 为 0。
- `origin/main` 为 `902b54fbc3ff82498a8ba7dbaae8af40dea47d6e`，本次 CA 修正从该提交分支。
- 在 `linux/amd64` 与 `linux/arm64` 上用与发行 Dockerfile 同样的 CA bootstrap 和 HTTPS Debian 软件源完成 `apt-get update`；两架构均通过，保留 TLS 及 apt 签名验证。
- 生产当前 Compose、环境文件、主密钥已备份到生产 root 私有目录。SQLite 一致快照为 2,949,316,608 字节，独立 `PRAGMA quick_check` 返回 `ok`，耗时 466.7 秒。
- 生产卷、ClickHouse 及当前中心服务尚未更改。

## 待完成

固定镜像构建、发布 PR、生产切换与健康回读。
