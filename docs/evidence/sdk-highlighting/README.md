# SDK 示例代码高亮

本目录的截图、参考图和录屏仅保存在本机 [`artifacts/screenshots/docs/evidence/sdk-highlighting/`](../../../artifacts/screenshots/docs/evidence/sdk-highlighting/)，由 Git 忽略；下文未带路径的图片和录像文件名均相对此目录。文字报告继续保留在仓库中。

SDK 接入页的业务示例按 TypeScript、Go、Python、Java、C#、PHP、Ruby、Rust 的语法着色，安装命令按 Bash 语法显示。使用 highlight.js 11.12.0，仅注册这九种语言，代码与样式随应用打包。配色沿用现有 SQL 编辑器的深色/浅色色系。

保持原有代码块尺寸、换行和复制动作。业务示例的文字及复制结果与原始样例逐字一致；C# 使用 csharp 语法，未识别的语言退回纯文本。主 Agent 自检，局部低风险修改，未安排独立评审。

现有 verify-sdks.mjs 连续三次通过，报告分别在 run-1/ui-report.json、run-2/ui-report.json、run-3/ui-report.json。每次检查八种语言的实际彩色 token、完整代码、剪贴板、八个 SDK 下载、深浅主题及 1280/750/390px 布局；没有页面 JavaScript 错误。类型检查和生产构建通过。

基线位于 before/，最终截图为 run-3/sdk-desktop.png、run-3/sdk-light.png、run-3/sdk-390.png。此改动没有新增流程或动效，也没有增删说明文字。已更新本地 Docker 实例 http://localhost:18380/data；健康检查及 22 个前端文件的字节校验通过。部署校验见 deployment.json，运行实例的额外浏览器验证见 deployed/ui-report.json。
