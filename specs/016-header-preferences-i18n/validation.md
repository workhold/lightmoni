# 验收记录

日期：2026-10-19。覆盖全站固定界面文案，保留业务名称、用户输入、日志、SQL、代码、模型回复和接口原始内容。

## 实现与兼容

- 登录账户移到全局右上角，展示头像、昵称/用户名和角色；个人资料保存后同步，菜单提供个人设置、外观与语言、退出。左下角保留导航收起入口。
- 顶部快捷配色与个人设置复用同一控件：深色、浅色、跟随系统及蓝/青/紫/橙强调色。兼容原 `lightmoni.appearance`；语言与强调色采用独立本地偏好，存储不可用时当前会话仍可操作。
- 显式 React 翻译覆盖登录、概览、接入、节点、主机、管理、大盘/编辑器、日志、告警和助手；同步 HTML lang、Ant Design 与 dayjs locale，不重挂载整站。切换语言不会翻译请求字段、SDK 命令或 AI 上下文数据。
- 无后端接口、数据库迁移或 SDK/Agent 协议变化。

## 自动验证

- `npm --prefix web run build` 通过，包含 TypeScript 构建检查；保留原有 Ant Design/Vite 打包提示。
- 全部 Web 单测 133/133 通过：`node --test web/src/shared/*.test.mjs web/src/app/*.test.mjs web/src/features/*.test.mjs web/src/features/assistant/*.test.mjs web/src/features/alerts/*.test.mjs web/src/features/dashboards/*.test.mjs web/src/features/logs/*.test.mjs`。新增断言确认英语标签不改变业务名称、SQL 参数、SDK 地址校验边界、未知用量与小额费用含义。
- `node web/src/app/verify-header-preferences.mjs` 通过 13 组场景：右上角身份、资料草稿与保存同步、主题及强调色持久化、系统主题变化、正常/减少动态效果下的快捷弹窗、跨标签页同步、33 个页面/页签英文文案、长名称与展开/收起导航、1280/390 宽度、非法存储回退、成员权限、存储受限、退出失败/成功。0 页面错误、0 意外请求。见 `ui-report.json` 与 `route-translation-report.json`。
- `node web/src/features/assistant/verify-language-state.mjs` 最终生产包 6 组通过：助手抽屉与全页提问/表/服务/工作区、大盘草稿与 SQL、告警规则参数与阈值，以及登录/初始化输入与校验文案，在双向切语言后保持状态。包含 390px 布局，0 写请求、0 页面错误、0 意外请求；见 `language-state-report.json`。已人工检查四张草稿/登录/初始化截图。
- 顶部偏好另定向重跑 12 组（跳过已验收的 33 页扫描）通过，强调色边线同步更新；最终生产包的登录卡片修正由上述 6 组状态验证覆盖。只读平台健康检查仍通过。
- 既有接入管理浏览器验证 13 组通过；SDK 接入验证三种发布语言 × 两种上报模式 × 桌面/窄屏通过，包含地址、代码复制及草稿保持。

浏览器验证使用构建产物与隔离状态化 API fixture，未改用户真实账号、密钥或节点，未发供应商模型请求；这些结果不代表真实数据库写入或真实模型生成的端到端验收。

## 验证中发现并修正的问题

- 原全局减少动态效果规则为所有元素添加 `.001s` 过渡，会使弹窗定位组件同步测量读到旧屏外坐标。仅将该媒体查询中的 transition duration 改为 `0s`；正常动画保留，两种模式的语言菜单、配色、内部选择框和账户菜单均可操作。
- AI 助手上下文使用稳定页面标题，展示层单独翻译，避免语言变化覆盖用户选择的范围和工作区。
- 三处凭据撤销/禁用确认框改用 Ant Design App 上下文，继承语言与主题。
- 顶栏层级低于窄屏展开侧栏，避免覆盖品牌与导航；已人工检查桌面浅色英文、窄屏深色英文和展开导航截图。
- 登录布局使用可收缩的 grid 轨道，修复原卡片最小内容宽度在 390px 屏幕造成的横向溢出。

截图保存在本地忽略目录 `artifacts/screenshots/specs/016-header-preferences-i18n/`。

## 本地平台

继续使用原 `.lightmoni` 数据目录。`http://127.0.0.1:8080/healthz` 返回 `status:ok`，`/api/v1/setup` 返回 `required:false`；仅检查运行状态，不重置原有用户、模型或凭据。

## 交付

已同步远端 main，创建 [PR #18](https://gitea.heyphp.com/lightmoni/lightmoni/pulls/18)，等待人工审核；本分支基于待审核 #17，建议先合入 #17。未直接推 main，未执行合并。
