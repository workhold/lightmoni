# UI 兼容契约

- automatic_placement 默认值及 automatic_placement=false 时的 spec.deployments 保持原有含义。
- host_ports、listen_ip 的字段名、默认值、校验、显式编辑标记和提交格式保持不变；自动位置与显式端口可组合使用。
- OpenResty 的 host 网络与固定 80/443 约束保持不变。
- 只移动现有 Form.Item 与 ApplicationPortFields；高级资源 portal、可选参数、部署模式和原有校验展开行为保留。
- 不新增后台接口、状态或数据库字段，不触发真实主机安装或生产写入作为 UI 验收。
