# 呈现与交互契约

- 所有资源仍由现有页面请求和状态 helper 提供；不新增后端接口或缓存。列表状态、计数、部署模式和服务来源均来自现有资源字段，不伪造监控数据。
- onEdit/onMonitor/onProgress/onAction/onDelete 仍传递同一个完整 Resource 对象。未知实例仍仅允许核对，停止/卸载的禁用规则不放宽，删除必须保留原确认文字与回调错误处理。
- WebsiteFields 的 Form 字段路径、serializeSpec 和命名端口/服务引用保持原样。分区目录只滚动到所属节，不隐藏或卸载表单项，不触发提交。
- 不迁移 localStorage；既有 appearance/accent/nav 键含义不变，仅缺省外观由深色改浅色。
- UI fixture 仅监听127.0.0.1，内存数据可重置，不连接 SSH、Docker 或真实 DNS，不加载生产凭据。测试保存错误不得清空表单或错误冒充成功。
