# 发布设计与契约

1. 核对所有关联工作树与 PR，保留主分支全部提交；从固定合入源码 git archive 构建，不带本地运行凭据。
2. Docker Desktop 分别构建 linux/amd64、linux/arm64，保留包完整性、固定 Node 摘要和镜像 revision 标签。
3. 使用真实隔离中心/ClickHouse 完成两平台检查；额外核对下载的 Agent 权限 helper/unit/低端口分类及网站路径代码。临时凭据只存0600忽略文件，清理测试资源。
4. 核对本地 OCI 与实际测试镜像 rootfs/config，一致后上传固定标签与 latest，回读远端索引、平台 manifest/config并独立拉取；固定标签禁止异内容覆盖，latest检查并发变化。
5. 发布 GitHub Release，默认 Compose 和部署说明固定新镜像；验收证据与引用更新经独立 PR 合入 main。此发布不自动执行生产更新。
