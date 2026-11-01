# Logo Contract

POST /api/v1/ops/resources: application 可额外提交顶层 logo（归一化 PNG data URL 或 null）；参数不放入 spec。与资源保存同一事务。省略保持旧行为；其他资源提交 logo 拒绝。

PUT /api/v1/ops/resources/:id/logo: 管理员，body {revision: logo_revision, data_url: PNG data URL | null}。版本 0 表示从未设置。成功返回公共 resource；Logo 版本递增，配置 revision 和 jobs 不变。冲突返回 409 application_logo_conflict，非法内容 400 invalid_application_logo，超限 413 application_logo_too_large。失败保留旧图片。

GET /api/v1/ops/resources/:id/logo?v=sha256: 同现有管理员读权限；应用不存在/无上传/摘要不符返回 404。固定 image/png，nosniff，CSP sandbox/default-src none，private,no-cache，内容 ETag；认证检查后可 304。没有任意文件路径或远端 URL。

删除应用登记后清理图片记录。Logo 写入需当前管理员，不产生运维执行任务；普通应用修改端点不接受 Logo 作为部署配置。

UI: 新建自定义应用可选上传；已有应用独立 Logo 入口预览/替换/移除/取消。保存失败不关闭窗口或清空文件，冲突显示重载动作；不静默重试覆盖。
