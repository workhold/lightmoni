# Catalog HTTP/UI Contract

## GET /api/v1/ops/catalog

沿用管理员读取权限。返回 templates[31] 与 categories[6]。稳定分类 database/middleware/devops/ai/tools/web；工具仅 dbx。新元数据见 data-model，包含可选 architectures；列表不访问上游。不返回构建函数、真实秘密或安装后生成值。

## POST /api/v1/ops/catalog/:id/install

沿用 name/service_name/deployment_mode/deployments/version/parameters/host_ports/listen_ip/confirmed。新模板应用参数默认值并检查必填、类型、长度、数字范围/枚举/URL，错误使用固定码 invalid_catalog_parameter 或 catalog_parameter_required；不反射输入。版本不在白名单返回 unsupported_template_version。非法部署模式、依赖稳定端口的 0 映射在资源创建前拒绝。

秘密只写入 environment（包含 URI 时密码编码），回读沿用环境脱敏。多服务依赖只通过项目内部 DNS/网络连接，宿主只发布声明端口。所有 named volumes 无显式全局名称。

新增模板默认 manual；deployment_modes 可限制为 manual。UI 显示 notes、官方文档、必填参数、默认资源与端口；高级设置包含可选参数和资源。服务器不信任 UI 限制。

## Runtime readiness

只将有 oneshot 标签且成功退出的服务视为完成；仍需清单中全部服务存在、全部常驻服务运行且健康。后续 inspect 从已授权的受管清单核对初始化标签；只有实际容器标签与清单一致且退出 0、未 OOM 时才完成。依赖初始化的任务要求 operations.platform.oneshot.v1 能力，避免旧 Agent 领取。有限启动等待覆盖重型服务；失败恢复、unknown 和部分成功语义沿用现有链路。
