# 私有镜像管理首版界面

沿用docs/ui-design.md及现有网站/集群模块的Ant Design 6、导航、颜色变量、间距和弹窗，不更换视觉语言。空状态提供“安装Docker Registry”；安装后以集群部署表展示机器、私网端点、缓存开关和期望/实际部署状态；独立区域展示唯一对外入口及关联网站。

安装表单必须明确集群、固定机器和私网IP；资源有默认值，可信内网确认与提交同屏。对外表单包含载体、域名、证书、账号及只写密码，已保存密码留空保留；必要网关安装显式勾选。版本冲突保留输入，刷新私有镜像状态后可重试，不重复创建系统应用。

网站表单全站Basic与各路径inherit/off/basic复用同一AuthFields组件；集群编辑缓存开关复用同一后端配置源。保留现有Modal、Switch、按钮loading/wave反馈；页面主区域仅首次短入场，prefers-reduced-motion取消入场动画。后台工具不做滚动叙事或持续装饰动画。

浏览器验收脚本web/src/app/ops/verify-registry-ui.mjs运行三轮，桌面1440×1000、200%视图和390×844窄屏；截图/录屏按仓库规则保存在artifacts/screenshots/，文字报告在evidence/ui。独立视觉评审另见evidence/ui/visual-review.md。
