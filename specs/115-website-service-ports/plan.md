# 实现设计

1. 在现有 website-upstreams 工具中集中生成端口选项与双语提示，供 WebsiteFields 与 ClusterUpstreams 使用。兼容端口保留原标签，不兼容端口保留可见的名称、端口和协议并禁选；未选服务和空声明使用明确提示。继续由服务器验证 HTTP/HTTPS，不根据端口号猜测协议。
2. 单容器 containerYAML 生成端口长格式时保留非空 app_protocol，containerForm 识别长格式显式 app_protocol，未填写时回退原值。运行时 prepareApplicationYAML 采用相同显式值优先规则，保留端口名称、服务归属与自动宿主映射逻辑。
3. 定向回归验证已有空值/TCP 标记修正、显式 HTTP/HTTPS、缺省保留、表单/YAML 往返；浏览器使用现有隔离 SQLite/API fixture，覆盖手动 Web 服务从无可用端口到可关联、两种网站绑定保存、非 HTTP 禁选以及语言/窄屏。
4. 类型检查、相关应用 YAML / 网站 API 回归和浏览器验收后记录证据；同步 origin/main，通过功能分支创建面向 main 的 GitHub PR，不合入或部署。

架构同步不适用，理由见 spec.md。
