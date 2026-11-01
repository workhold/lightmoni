# 发布契约

- 仓库：docker.heyphp.com/lightmoni/lightmoni；固定标签 20261101-e3a5276 与 latest 为同一双平台 OCI 索引。固定标签已存在不同内容则拒绝覆盖。
- 源码：e3a527697c6718ee1e423a6341a48d313d4f193e；两个平台 org.opencontainers.image.revision 与 GitHub Release target_commitish 必须一致。
- 不改变 application/host_ports 的 API，沿用 SDD 062 契约。省略字段与旧参数兼容。
- 默认 Compose 直接使用固定发布标签，旧 LIGHTMONI_IMAGE 不覆盖；保留原服务、卷、健康依赖和运行身份。
- 凭据仅通过 Docker credential helper 或权限0600的测试运行时文件提供，不写入 Git、输出、URL、发布正文。
