# SDD 025：验证记录

## 影响判断

- 仅调整 Web 导航展示及与已有路由一致的菜单可见性。系统运行架构未变，仓库系统设计和 Doca 同步不适用。
- 原菜单对成员显示“服务部署”，但该路由实际要求管理员；本次应隐藏该无权访问入口，保留后端与路由鉴权。

## 构建和差异检查

- `npm --prefix web run build` 通过（含 `tsc -b`）。Vite 仍报告第三方 `use client` 指令与大块体积告警，未阻断构建。
- `git diff --check` 通过。构建产物更新到本地 `runtime/public`，不提交生成文件。
- 独立只读复核确认页面路径、双语名称、子路由高亮和 AI 当前页上下文沿用原有含义，三项管理员导航与现有受保护路由一致。

## 浏览器交互与视觉验证

使用本次生产构建和两个临时只读 API fixture 服务，分别返回管理员、成员身份，不连接真实主机、不生成部署任务、不修改平台账户。原本地 8080 登录未成功，因此本次视觉验收不声称使用真实账户完成业务操作或验证后端权限。

- 管理员：五个分组、十二个唯一路径；“运维工具”包含主机管理、节点助手、服务部署。点击服务部署后顶部标题和唯一 `aria-current="page"` 均为 `/services`。
- 成员：保留五组九入口，隐藏 `/machines`、`/services`、`/admin`。直接打开 `/services` 仍跳转 `/settings`，fixture 未收到成员的 services/machines API 请求；节点助手正常显示只读提示。
- 子路由 `/agents/install` 正确归属 `/agents`，顶部标题仍为 Node assistants。
- 英文：五个分组与十二项标签、链接提示均即时切换；当前页面及高亮保留。深色中文和浅色英文均做截图检查。
- 收起：侧栏宽 52px，保留十二项图标链接的可访问名与 title，分组间四条分隔线。分组标题在视觉上隐藏且保留语义；Tab 从 Machines 移到 Node assistants。
- 手机宽度 390×844：成员展开/收起都无页面横向溢出，展开宽 200px、收起宽 52px，节点助手当前页高亮保留。
- 短屏 1280×600：导航容器高 396px、内容高 722px，可滚动到底部。管理后台链接中心实际命中该链接；导航底部 y=470、AI 按钮顶部 y=478，留有 8px 间隙。只加内容 padding 不能解决固定按钮遮挡，因此为滚动容器预留了独立底部区域。
- 临时视口覆盖已恢复；以上 fixture 请求均为 GET，不触发写入。

## 本地视觉证据

截图保存在被 Git 忽略的 `artifacts/screenshots/specs/025-grouped-sidebar-navigation/`：

- `grouped-sidebar-zh.png`：中文管理员导航。
- `grouped-sidebar-light-en.png`：浅色英文导航。
- `member-mobile-collapsed.png`：390×844 成员收起导航。
- `admin-short-screen.png`：1280×600 滚动到设置入口。

本次只验收导航及直接相关页面展示，未重新执行 SSH、模型调用、部署执行或监控数据链路回归。

## 交付

仅向 GitHub 推送功能分支并创建待审核 PR，不向 Gitea 写入，不自动合并。

## 分类折叠修订验收

- 用户要求分类默认收起。规格调整为：侧栏展开时仅展开当前路由分类，其他分类收起；可单开或全收。侧栏缩成图标时仍提供所有入口。
- 修订后的生产构建（含类型检查）与 `git diff --check` 通过，沿用上述临时只读 fixture。
- `/machines` 初始只有“运维工具”展开；点击“数据与接入”会收起运维，且不改变 URL。Space 关闭数据组后，展开数及可见链接数均为 0；Tab 跳过隐藏链接直接到系统设置，Enter 可展开系统设置。
- 点击个人设置后导航到 `/settings`；浏览器返回 `/machines` 时恢复展开运维工具，当前高亮仍为 `/machines`。
- 侧栏缩成图标时全部 12 个管理员入口可见，分类按钮不参与键盘导航；重新展开时恢复当前展开组。
- 成员 `/agents` 默认只展开运维工具，里面仅出现节点助手；页面继续显示只读提示，主机管理和服务部署均不出现。
- 独立只读复核未发现阻塞问题。截图 `accordion-current-group.png` 保存本地，修订推送至同一 [GitHub PR #4](https://github.com/workhold/lightmoni/pull/4)。

## 开放 PR 整合（2026-10-27）

- 将导航分组与现有主干的页面懒加载、管理员 `/operations` 路由整合；未改变已有登录回跳、路由保护或功能页面实现。
- 在“运维工具”分类新增管理员入口“网站与运维 / Websites & operations”，包含网站、证书、容器、备份和计划任务。顶部标题与 AI 当前页上下文继续使用该页面已有的“运维工具 / Operations”，避免把导航分类名和子入口显示为同名条目。
- 导航配置共五组十三个唯一路径；成员过滤保留九项入口，隐藏 `/machines`、`/services`、`/operations`、`/admin`。当前分类默认展开、其他分类默认收起、单开或全收以及图标侧栏逻辑沿用原实现；`/operations` 现在能正确匹配当前分类与页面标题。
- `npm --prefix web run typecheck`、`npm --prefix web run build`（包含 `tsc -b`）及 `git diff --check` 通过。生产产物生成到被忽略的 `runtime/public`；构建仍有第三方 `use client` 与大块体积提示，无构建错误。
- 整合后的浏览器验收见 [SDD 027 验收记录](../027-pr-consolidation/validation.md)，覆盖管理员十三入口、成员九入口、折叠、中英文、路由保护、窄屏和短屏。仅变更导航展示与原有路由的衔接，系统设计及 Doca 架构同步仍不适用。
- 本次统一交付为[整合 PR #8](https://github.com/workhold/lightmoni/pull/8)，原 PR #4 的交付状态仅代表原提交时点。
