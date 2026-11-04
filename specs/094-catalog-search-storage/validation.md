# SDD094 验收

- 主干基线：origin/main a9588e6，独立工作区与 codex/094-catalog-search-storage 分支；用户原工作区的 compose.yaml 与发行证据未纳入。
- runtime / web 类型检查、runtime 构建、web 生产构建通过；前端现有 Ant Design use-client 打包提示仍为警告。
- application-catalog、application-logos、platform-clusters 共53项通过：35个唯一模板、8类、必填参数、主密钥长度、RustFS两端口、随机凭据一致性、公开回读/加密持久化及旧安装回归。
- 实际 Agent manifest 经 Docker Compose config 验证：31个扩展配方、65个服务均通过。此数量不含保留的4个基本模板。
- 实际浏览器验证4组：zh-CN/dark/1440、en-US/light/1440、zh-CN/light/390、en-US/dark/390。8类数量、搜索、新增四个本地Logo解码、安装表单、旧DBX/Dify/GPU/多端口/架构要求均通过，页面错误0，无页面溢出。截图保存在本工作区 artifacts/screenshots/specs/094-catalog-search-storage/evidence，文字证据为 evidence/ui.json。
- 镜像清单已通过官方 registry 元数据核对 amd64/arm64，固定标签与摘要见 evidence/images.json；完整镜像层下载出现 CDN TLS handshake timeout，元数据检查不代表完整拉取或启动成功。

## 架构同步

适用：新增工作负载部署拓扑、存储与凭据边界。仓库 docs/system-design.md 第66节目录数量、第66.1节搜索/抓取/云存储、第68节Logo数量已更新；[Doca系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 同批更新。成功保存后按最新seq1741回读，目标文字逐项一致；原49个原生图块（含节点/连线属性）保持，全部无关块内容一致。证据见 evidence/doca.json。不改变平台API、数据表或权限，无生产安装、发布或主干合并。

## 容器业务冒烟

实际状态在 evidence/live.json 及补充记录中列出。Docker Compose config、HTTP/SQLite和浏览器均不能代替第三方容器业务验收；未拉取完成的镜像不声称启动通过。可用 quickstart.md 复现官方镜像冒烟。

- 已完成真实 linux/arm64 SearXNG 冒烟：原生入口启动、/healthz、HTML 首页和 format=json 检索均通过；20项浏览器截图已保存并检查代表性桌面/手机画面。SearXNG 未声明上游引擎全部可用。临时容器、网络、卷和配置已清理。
- Meilisearch、RustFS、Firecrawl：官方镜像层拉取未完成，CDN TLS 超时重试后仍未具备完整镜像；尚未通过这些版本的容器业务冒烟。已提供复现脚本；不将此项列为通过。功能PR保持draft，便于复核后继续验收。

## 交付

[GitHub Draft PR #100](https://github.com/workhold/lightmoni/pull/100)，目标main。提交前已fetch核对远端主干，无冲突；当前分支仅包含本次目录、分类、Logo、SDD和验证变更。剩余镜像下载已停止，未遗留本轮测试容器、网络或卷。
