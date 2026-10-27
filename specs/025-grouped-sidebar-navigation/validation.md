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
