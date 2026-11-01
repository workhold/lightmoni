# 汇总发行验收

日期：2026-11-01。用户已授权包含其他会话的全部变更经 PR 合入 GitHub main 并发布 Docker。

本轮待合入 [PR #44](https://github.com/workhold/lightmoni/pull/44)、[PR #47](https://github.com/workhold/lightmoni/pull/47)、[PR #55](https://github.com/workhold/lightmoni/pull/55)、[PR #58](https://github.com/workhold/lightmoni/pull/58) 均已合入；固定源码 6642bd019917b4c469960a068b60870afa56e970 包含全部合并提交。所有关联功能工作树干净，旧域名同步分支与 main 的 squash 提交补丁一致，无遗漏未提交变更。见 [合并回执](evidence/merged-prs.json)、[整合核对](evidence/integration.json)。原有应用商店、Logo/YAML、镜像管理等均保留。

## 发布与验证

- Docker：docker.heyphp.com/lightmoni/lightmoni:20261101-6642bd0 与 latest。两者回读相同 OCI 索引 sha256:ea9998e9f44f4867814eb10780947bea7e66bcf2e52fd848cd9488cdcc474ae1，支持 linux/amd64、linux/arm64。从 main 的固定 git archive 构建，不带工作区或运行凭据。工具/上下文 SHA256、平台材料见 [build-inputs.json](evidence/build-inputs.json)。
- 双平台实际生产容器各 27 项检查通过，使用真实隔离 ClickHouse、非 root 中心，覆盖管理员初始化/登录、身份、31项商店、Logo/YAML、证书材料、SDK/Agent下载与校验、打包 Agent 运行和 AI 模块。额外核对下载的匹配架构 Agent 包含固定权限 helper、Docker 组、低端口 capability、启动检查、网站公开/临时目录及 bind 诊断。见 [生产检查](evidence/container-smoke.json)。
- 双平台独立无网络只读容器核对 Docker 补装、网络分类、端口诊断的生产网页与中心模块；未知 Docker 状态保持 unknown，见 [整合检查](evidence/integration-smoke.json)。本轮整合后 Web 单元146项、权限/网站/证书18项、Docker/端口73项通过，类型检查和双架构生产构建通过。
- 31 个 OCI blob SHA256、大小及实测 rootfs/config 核对通过；远端平台 manifest/config/index 回读一致；两个平台分别重新拉取后 rootfs/config 与实测镜像相同。见 [发布摘要](evidence/registry-summary.json)、[独立拉取](evidence/verified-release.json)。固定标签拒绝异内容覆盖，latest 发布前检查并发变化，24 个历史固定标签保持，见 [历史标签](evidence/historical-tags.json)。
- 根/兼容 Compose、有/无历史 LIGHTMONI_IMAGE 共四种组合通过，新默认固定版本，原卷、服务与健康依赖保持，见 [Compose检查](evidence/compose-checks.json)。
- [GitHub Release](https://github.com/workhold/lightmoni/releases/tag/20261101-6642bd0) 已发布且指向同一源码，见 [回执](evidence/github-release.json)。测试中心、数据库、卷、网络和0600临时运行凭据已清理，无关服务保持，见 [清理记录](evidence/cleanup.json)。原始构建/测试日志位于忽略目录 .local-dev/image-release-072/。

## 架构与生效范围

发布本身架构同步不适用，仅打包已完成设计同步的功能。权限架构见 docs/system-design.md 第71节、docs/agent-deployment.md 与 [Doca 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)。SDD071 最终seq917，707个原块和34个原生图保留，新正文及8节点/10连线核对，见 [原功能回读证据](../071-agent-deployment-permissions/evidence/doca-readback.json)。SDD060 是尚未实现的独立执行器目标设计；当前标准 Docker 管理授权接近宿主 root，普通受信管理员脚本继承实际服务权限。

真实 Linux 普通用户、组/capability/只读根、真实 Nginx 网站下发、反向代理、80/443、配置重载、失败及版本恢复、HTTPS证书轮换、私钥0600 的验收见 [SDD071](../071-agent-deployment-permissions/validation.md)。Docker CLI/socket 权限采用只读 Engine API fixture，不能冒称已执行全部第三方业务或真实远端 apt 安装；一键补装暂支持 Ubuntu/Debian。

本轮发布没有重建线上中心、升级 xiangxiaojia 或修改其业务。现有部署需沿用原 Compose 项目、环境与数据卷执行 pull/up，再通过平台升级目标 Agent 并重新部署原应用，权限修复才生效。默认引用与本证据通过发布 PR 交付 main，合入状态以 GitHub 最终回执核对。
