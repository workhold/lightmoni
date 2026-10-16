# 管理后台与个人设置验收

本目录的截图、参考图和录屏仅保存在本机 [`artifacts/screenshots/docs/evidence/account-settings/`](../../../artifacts/screenshots/docs/evidence/account-settings/)，由 Git 忽略；下文未带路径的图片和录像文件名均相对此目录。文字报告继续保留在仓库中。

2026-10-16。沿用 LightMoni 的深色外壳、AntD 组件、蓝色主操作与既有导航密度，将实例管理移至 `/admin`，`/settings` 默认展示个人资料。昵称独立于登录用户名；手机号与告警联系方式共用记录；头像保存为有类型、大小和尺寸限制的 PNG/JPEG 图片。

## 已完成

- 管理员导航与路由：用户列表、第三方登录、大模型接入、上报地址、通知接入、目录与值班同步、数据保留和告警入口。
- 个人资料保存并同步侧栏，告警联系方式、外观和账号绑定各自分栏；绑定页读取真实绑定状态。
- AI 助手的模型配置入口跳转至管理后台；切换页面关闭助手抽屉。接入和告警中的全局配置链接同步更新。
- 旧 `/settings?tab=users/login/models/reporting/notifications/directory/retention/alerts` 链接按角色跳转；普通成员没有管理入口，直接访问 `/admin` 回到个人设置，管理写接口仍执行后端权限校验。
- 新增用户的启用开关真实写入状态。昵称/头像存储迁移自动创建新表，资料更新不改变登录用户名、角色或会话。

## 自动验证

- `npm --prefix web run typecheck`：通过。项目未配置 lint 脚本。
- `go test ./internal/auth ./internal/assistant ./internal/shared`：通过。
- `go test ./internal/auth ./internal/server -run 'TestPersonalProfile|TestScopedKeyAndUserLifecycle|TestReporting|TestRetention'`：通过。
- `go test ./internal/auth -run TestPersonalProfile -count=3`：三次通过。覆盖非法昵称/号码/图片拒绝、账号隔离、角色不能自提权、手机号共享及其他联系方式保留、重新登录读回、写入失败时整个事务回滚。
- 独立本机 SQLite + ClickHouse 26.8 实例运行 `scripts/verify-account-settings.py`，连续三次通过，结果为 [api-1.json](api-1.json)、[api-2.json](api-2.json)、[api-3.json](api-3.json)。验证真实模型配置、登录供应商和接入地址保存、密钥不回传、成员权限与禁用用户状态。

## 浏览器验证

使用 CUA 从导航走查。实际检查了昵称/号码保存与刷新读回，头像上传/保存/刷新/移除，模型弹窗保存，成员导航隐藏与后台路由跳转。通过在独立测试数据库注入写入失败验证失败提示、输入保留及恢复后重试，随后移除了故障触发器。

- [个人设置桌面](../../../artifacts/screenshots/docs/evidence/account-settings/personal-desktop.jpg)、[390px 个人设置](../../../artifacts/screenshots/docs/evidence/account-settings/personal-narrow.jpg)。
- [用户列表整页](../../../artifacts/screenshots/docs/evidence/account-settings/admin-users.jpg)、[1280px 首屏](../../../artifacts/screenshots/docs/evidence/account-settings/admin-users-viewport.jpg)、[390px 后台](../../../artifacts/screenshots/docs/evidence/account-settings/admin-narrow.jpg)。
- [模型接入](../../../artifacts/screenshots/docs/evidence/account-settings/admin-models.jpg)、[保存失败保留输入](../../../artifacts/screenshots/docs/evidence/account-settings/personal-save-failure.jpg)、[成员个人设置](../../../artifacts/screenshots/docs/evidence/account-settings/member-settings.jpg)。
- 390px 个人设置和后台均确认 `document.documentElement.scrollWidth === innerWidth`，表格在内部横向滚动。

## 独立静态评审与边界

按 oil-ui 存量页面扩展标准完成一轮独立静态审阅，不打分。根据意见将登录用户名改成正常可读的只读输入，用户表行操作改为小号文字按钮，删除个人资料与模型卡片内重复标题，并限定用户名列宽、使用省略展示。保留图片格式/大小、昵称回退规则、号码格式和撤销会话说明，因为这些影响操作。

主操作沿用按钮按压、保存 loading 与成功/失败提示；状态切换沿用 AntD Tabs 指示与内容轻显现；首次进入沿用 `lm-entry`。保留减少动态效果规则。尚未取得完整录屏/起中止三帧，三项动效未独立验收。浏览器缩放快捷键未改变页面视口，未声称完成 200% 缩放验收。

第三方 OAuth 跳转使用真实接口，但没有第三方应用凭证，未执行外部授权；模型配置使用本机测试地址，没有调用付费模型。第一轮使用独立状态目录验收；原运行服务在随后复查时更新，详见下节。


## 当前 5173 服务的 404 修复

用户实际访问 `http://127.0.0.1:5173/settings?tab=profile` 时，Vite 仍连接旧 Docker 后端，新增 `/api/v1/auth/profile` 未注册。已完成前端生产构建和 Linux arm64 后端编译，将当前本地 `lightmoni:acceptance` 镜像更新并重建后端容器。对比更新前后的运行配置，环境变量、数据卷、端口和网络均一致；现有管理员会话继续有效。

已在用户原 Chrome 页签验证加载、使用现有值保存成功、刷新后重新读取。证据：[修复前](../../../artifacts/screenshots/docs/evidence/account-settings/live-profile-before.jpg)、[修复后](../../../artifacts/screenshots/docs/evidence/account-settings/live-profile-fixed.jpg)、[配置与验证记录](live-service-fix.json)。此轮未修改用户现有昵称、手机号或头像的值。

运行配置与状态备份保存在被 Git 忽略的 `.local-dev/account-settings-deploy/`，目录与包含环境变量的文件限制为当前用户访问。可回退镜像为 `lightmoni:account-settings-base-20261016`。

## 个人资料合并告警联系方式

按用户追加要求，将手机号、收件邮箱、飞书 open_id、钉钉及企业微信用户 ID 放入个人资料表单，共用“保存个人资料”操作，删除独立的告警联系方式页签。桌面采用两列字段，窄屏为单列。旧 `tab=contacts` 链接跳转至个人资料，告警组中的联系方式入口也已更新。

`/auth/profile` 统一读取资料和通知字段，并在同一事务内保存；兼容旧客户端未提交额外联系方式的请求，保留通知时区及其他元数据。邮箱、号码或平台账号校验失败不会部分修改资料，存储失败会回滚所有字段。

本轮类型检查、前端构建及 `go test ./internal/auth -run 'TestPersonalProfile|TestNotificationProfiles' -count=3` 通过。运行中的本地服务已更新，在用户原 5173 页签验证统一保存、刷新读回及旧链接跳转；可见页签仅剩个人资料、外观、账号绑定。[合并后的界面](../../../artifacts/screenshots/docs/evidence/account-settings/profile-with-alert-contacts.jpg)。
