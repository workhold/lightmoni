# 应用 Logo 与 YAML 配置版本发布

用户授权全部本次提交通过 PR 合入 main、推送 GitHub 和发布 Docker。SDD 068 已经 PR #56 合入，固定源码 46a4ac11c50de7fc48790744a462c871d8172df5。发布 docker.heyphp.com/lightmoni/lightmoni:20261101-46a4ac1 与 latest，支持 linux/amd64、linux/arm64，包含生产网页、双平台 Agent 和四种 SDK。

验收 Logo 与高级 YAML 在实际生产镜像中的认证接口、独立图片版本和模块行为，核对已有 31 项目录、Web 和 Agent/SDK，远端 OCI 回读、独立双平台拉取和历史固定标签不变。更新默认固定版本及部署文档，经发布 PR 合入 main。不自动重建既有用户服务。

架构同步不适用：仅打包已合入 SDD 068 并更换默认版本引用，不新增职责、存储、协议、控制路径或拓扑。功能架构已在 PR #56 同步 docs/system-design.md 第 68 节和 Doca seq 912；7 个新增段落一致、原有 33 个原生图完整保留。
