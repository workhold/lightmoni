# Contracts

- 无新增后端 API 或数据库迁移；账户继续使用 `User` 的 `nickname/name/avatar_url/role` 和 `POST /api/v1/auth/logout`。
- 新语言偏好：`lightmoni.language = zh-CN | en-US`，缺失或非法时中文；`useI18n()` 返回 `language`、`setLanguage` 和 `t(chinese, english)`。不在模块加载时冻结翻译后的标签。
- 外观偏好：沿用 `lightmoni.appearance = dark | light`，增加 `system`；新增 `lightmoni.accent = blue | teal | violet | orange`，缺失/非法回退 blue。localStorage 不可用时当前会话仍可修改。
- `useAppearance()` 保留 `appearance/dark/setAppearance`，增加 `accent/setAccent`；`dark` 为实际渲染色，兼容现有消费者。设置 CSS 变量及 `data-theme=dark|light`，不把 system 直接当成实际主题。
- 偏好入口复用 `/settings?tab=appearance`，旧个人资料、绑定和管理员深链保留。
- 本地偏好不进入请求参数、SDK 环境变量、安装命令或 AI 提问正文。
