# 验收与交付：应用商店扩展与 DBX

日期：2026-11-01；分支：`codex/066-app-catalog-expansion`。

## 最终行为

新增 27 个应用，保留原有 4 个，共 31 个。分类数量：数据库 8、中间件 7、DevOps 7、AI 7、工具 1、网站与网关 1；工具仅 DBX。逐项版本及官方来源见 [catalog-matrix.md](catalog-matrix.md)。Redis 归中间件，Docker Registry 归 DevOps；既有模板标识和安装参数保留。

所有新增模板包含实际安装配方、固定版本、必填参数、运行要求和独立持久卷；复杂应用带内部依赖或明确要求外部服务。服务端验证类型、URL origin、端口、稳定广播地址、部署模式和已知目标架构。中英文表单按模板设置资源，窄屏分类可操作。

## 已执行检查

| 检查 | 结果 | 范围与证据 |
| --- | --- | --- |
| Runtime / Web TypeScript | 均通过 | `npm --prefix runtime run typecheck`、`npm --prefix web run typecheck` |
| Runtime 全量回归 | 905 通过、24 跳过、0 失败，共 929 | `npm --prefix runtime test`；末轮新增负例及脚本可读性整理后另跑定向回归 |
| 最终定向回归 | 54 通过、0 失败 | application-catalog、application-install、platform-clusters、platform-store、operations-platform；覆盖全部新模板、非法参数、真实 HTTP/SQLite 加密与脱敏、旧安装和 Agent 能力领取 |
| 实际 Agent 配方渲染与 Compose 校验 | 27 配方 / 57 服务通过 | [compose.json](evidence/compose.json)；使用 renderManifest 和 `docker compose config --quiet`，未启动容器 |
| 浏览器 | 4 组通过、无 JS 错误和页面横向溢出 | [ui.json](evidence/ui.json)：中文/深色/1440、英文/浅色/1440、中文/浅色/390、英文/深色/390；减少动态效果；分类数量、工具仅 DBX、搜索、必填密码、默认端口/资源、复杂应用/GPU要求 |
| DBX 真实安装 | 通过 | [docker-live.json](evidence/docker-live.json)：实际 Agent 回执成功；未登录需认证、错密拒绝、正确登录；新建 SQLite 测试连接与数据标记在强制重建后均保留 |
| 初始化真实安装与后续观测 | 通过 | 同上；实际 Agent 安装 init + nginx，初始化退出 0，安装与后续 inspect 均健康；单测另验证非 0、OOM、冒充标签和缺服务不能成功 |
| Harbor 官方 prepare 源码及配置读取 | 通过，有限覆盖 | [harbor-prepare-smoke-evidence.json](evidence/harbor-prepare-smoke-evidence.json)：核对官方源层 SHA，在具备依赖的临时容器及兼容 htpasswd harness 中执行实际配方脚本；验证配置、共享密钥路径、UID10000 读取、卷子路径、同配置重复执行不改变密钥；不等于完整官方镜像运行 |
| Dify 入口 Nginx | 语法通过 | [dify-nginx-smoke.json](evidence/dify-nginx-smoke.json)：实际 nginx 镜像执行 `nginx -t`，只有服务 DNS 使用测试值，未执行上游 API/插件业务 |
| 官方镜像接口核对 | 完成公开元数据记录 | [upstream-images.json](evidence/upstream-images.json)：官方 registry manifest/config、入口、架构与持久目录核对；不将 manifest 可取得称为完整镜像已运行 |
| 临时资源清理 | 通过 | 真实冒烟剩余本轮容器/卷/网络为 0；浏览器与 API 临时 fixture 已关闭 |
| Diff 与远端主干同步 | 通过 | `git diff --check`；`git fetch origin main` 后基于 `5890608`，无主干新增提交与合入冲突 |

浏览器真实 HTTP 安装通过管理员 fixture 创建加密资源和待执行任务；该部分使用受控 QA Agent，未伪造完成回执。真实 Docker 验证由独立 live fixture 进行。截图保存在忽略目录 `artifacts/screenshots/specs/066-app-catalog-expansion/evidence/`。

DBX Docker Hub 层下载超时，实际使用项目官方 CNB 镜像；已核对 Hub 与 CNB 对应平台的 manifest/config/layers 身份相同，index digest 的差异不冒充相同。实际运行平台 arm64、身份摘要见 docker-live.json。

## 兼容与运行前提

- 依赖一次性初始化的配方要求新 Agent 能力 `operations.platform.oneshot.v1`，旧 Agent 不领取；普通旧应用不新增该要求。
- Harbor 仅 amd64，需要 Docker Engine 26+ 与 Compose 2.26+ 的卷子路径支持，指定机器及稳定外部 origin；无需宿主 socket、特权容器或宿主文件系统挂载。
- FastGPT 要求用户提供可连接的 S3 兼容服务及不同的公有/私有 Bucket；私有 Bucket 不能匿名访问。镜像仓库未提供上游所引用的部分 MinIO/sandbox 标签，因此明确外部存储，并采用与目标版本 sandbox 源码树相同、可取得的固定标签。
- vLLM 要求 NVIDIA GPU、驱动、Container Toolkit 和可访问的模型；Ollama 默认 CPU，模型在安装后按应用操作下载。业务管理员、插件、模型供应商等初始化按各应用指引完成。
- 有固定广播地址的中间件及 Git 服务限制手动选择机器。单节点配方不提供数据库复制或数据迁移；多容器资源按每容器设定并预留总和。

## 架构影响与在线同步

适用。新增模板元数据/构建职责、一次性服务健康语义、第三方 AI/外部 S3 拓扑与凭据边界。仓库更新 [docs/system-design.md 第 66 节](../../docs/system-design.md)。Doca [LightMoni 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 新增对应章节。

保存 seq 911 后按最新版本回读：新增 7 个块与目标文本一致；文档块数 686 → 693；原有 33 个原生图的节点、连线与全部属性均保持一致。只插入新块，未改写已有块；[doca-readback.json](evidence/doca-readback.json) 保留逐区域结果。运行时凭据未进入仓库、文档或证据。

## 未覆盖与交付边界

本机未验证 NVIDIA 推理，也未逐一启动全部 27 个第三方应用进行业务验收。Harbor 官方完整镜像的大层下载未完成，见 [harbor-prepare-blocked-evidence.json](evidence/harbor-prepare-blocked-evidence.json)，因此其完整组件互通、推拉与线上重启仍需 amd64 环境验收。Dify/FastGPT 完整模型与插件业务未实测。上述限制不以 Compose 校验或源码验证替代。

代码通过功能分支交付 GitHub Draft PR，目标 main；不自动合并、发布镜像或更新线上容器。交付：[GitHub Draft PR #53](https://github.com/workhold/lightmoni/pull/53)，实现提交 `78501fc`。
