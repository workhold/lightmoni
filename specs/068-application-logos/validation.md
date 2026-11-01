# 应用 Logo 与 YAML 配置验收

日期：2026-11-01。规格、设计、数据模型、契约和任务先于对应实现更新。

- 31 个内置模板均带自己的本地品牌图，来源、固定提交、SHA256、许可和署名随仓库交付；浏览器不请求第三方图片。
- 自定义应用支持创建时上传、预览，已有应用独立替换/移除。PNG/JPEG/WebP 在浏览器归一化，中心有界验证 PNG；独立版本不创建配置修订或部署任务。非法输入、权限、原子回滚、冲突、数据库关闭重开后的持久化均已覆盖。
- 历史 Compose 配置回显为 YAML；创建/修改可切换高级 YAML。单容器保持类型、挂载和部署信息；服务环境占位按键恢复，新增占位拒绝，历史扩展别名从公开投影移除。托管发现 services.*.ports 并忽略 YAML 宿主端口，保留原监听范围/名称/协议；expose 不发布；手动模式采用 YAML 映射。保存后显示规范化 YAML，注释和原始排版不持久化。

## 检查

- runtime 完整套件：935 项，911 通过、24 跳过、0 失败；最终后端调整后定向套件 60 项通过、0 失败。覆盖 PNG/实际 HTTP/SQLite、应用/集群、环境占位和 YAML 端口行为。完整日志位于忽略目录外的本地 /tmp/lightmoni-068-runtime-full.log 和 /tmp/lightmoni-068-final-tests.log，原始日志不进入仓库。
- runtime 与 web TypeScript 检查通过；网页 YAML 单元测试 2 项通过，覆盖规范化回显/往返和拒绝不能表达的字段/多服务/网络别名。
- 真实 HTTP/SQLite 浏览器验收：中文深色桌面、英文浅色桌面、中文浅色 390px、英文深色 390px 四组通过，JavaScript 错误为零；31 个品牌图完整解码。覆盖 Logo 创建、上传格式、保存失败保留输入、刷新、取消、替换、并发冲突/重新加载、移除回退；覆盖 YAML 创建与修改、秘密占位、历史 Compose 和托管端口。见 [ui.json](evidence/ui.json)。截图在忽略的 artifacts/screenshots/specs/068-application-logos/evidence/，人工核对桌面品牌卡片、窄屏 Logo 编辑及 YAML 编辑，弹窗与保存按钮可用。
- 浏览器服务为真实本地中心/SQLite 验收夹具，没有调用远端 Agent 执行第三方应用。只有失败重试用例由浏览器注入 503。

## 架构同步

新增中心 SQLite Logo 表、独立认证图片端点及 YAML 输入控制路径，属于架构变更；同一 SDD/PR 更新仓库 docs/system-design.md 第 68 节和 [Doca 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)。保存 seq 912 后回读 7 个新增原生段落全部一致，原有 33 个原生图的节点、边和属性完整相同，见 [doca-readback.json](evidence/doca-readback.json)。没有新增 Agent 能力或部署拓扑。凭据未进入源码、文档或验收证据。

## 交付

用户已授权全部本次提交通过 PR 合入 main、推 GitHub、发布 Docker。功能已由 [PR #56](https://github.com/workhold/lightmoni/pull/56) 合入 main。从固定源码 46a4ac11c50de7fc48790744a462c871d8172df5 构建的双平台 Docker 与 GitHub Release 已发布，生产容器验收、摘要及回执见 [SDD 069 发布验收](../069-application-logos-release/validation.md)。
