# SDD 188 验收记录

## 自动化

| 检查 | 结果 |
| --- | --- |
| Runtime `tsc --noEmit`、AI Runtime `tsc --noEmit`、Web `tsc --noEmit` | 通过 |
| AI Runtime `npm run build`、Web `tsc -b && vite build` | 通过 |
| AI Runtime 全量测试 | 89/89 通过；四种模型协议的图片输入均覆盖 |
| Runtime assistant 测试 | 23/23 通过；覆盖加密附件、元数据响应、状态和非法输入 |
| Web assistant 单元测试 | 10/10 通过 |
| `verify-conversation-ui.mjs` | 通过；双击仅创建一会话、队列顺序为 first → third → second、优先发送及独立停止各取消一次、SSH 工具/Markdown、图片和 PDF 输入、会话状态、自动折叠、桌面与 375px 深色布局 |
| `verify-language-state.mjs` | 通过；抽屉及整页的输入草稿、分析范围和代码工作区在中英切换后保留 |
| `git diff --check` | 通过 |

浏览器原始结果：[browser.json](evidence/browser.json)。截图：[桌面欢迎页](evidence/desktop-welcome.png)、[桌面范围弹层](evidence/desktop-scope.png)、[桌面对话](evidence/desktop-light.png)、[移动深色对话](evidence/mobile-dark.png)、[移动深色范围弹层](evidence/mobile-scope-dark.png)。

既有全站导航脚本的助手入口断言已随顶栏移除更新并通过；该脚本后续在未改动的“应用”页旧标题断言处失败。此项与助手变更无关，不作为本次验收门槛。需要运行本地服务的 `verify-retention-context.mjs` 未作为本次测试门槛。

## 兼容及边界

- 纯文本请求和旧事件保持原契约；新附件和会话状态字段可选。
- 旧会话仍可读取；附件正文不经 Session、列表或 SSE 公开，只在所属用户的模型轮次中解密。
- 队列只在浏览器当前页面内存中；刷新后未提交项不会执行。PDF 仅分析可复制文本，扫描件需要 OCR；图片分析取决于已配置模型的视觉能力。
- 架构影响：新增附件存储和模型输入路径、会话状态投影及页面内队列；已更新 `docs/system-design.md` 第 7.4 节。工具、审批、凭据与部署权限边界未变。
