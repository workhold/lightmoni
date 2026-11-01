# 设计

1. 在网页运维模块添加无副作用的 URL 判定与原因函数，与 `runtime/src/operations/nginx.ts` 的现有 upstream origin 接受范围一致。分别提示缺少/错误协议、账号密码、路径、查询/片段和主机/端口格式错误；保留服务器作为权威校验，不修正协议、不截断路径、不静默丢弃空行。
2. `ClusterUpstreams` 为手动后端 URL 增加必填、格式说明和自定义验证，为 Form.List 增加至少一项的验证及 Form.ErrorList。应用命名端口分支不挂载这些验证器。
3. 资源编辑表单开启首错滚动/聚焦；保存错误沿用原 Alert 和输入保留机制，对 INVALID_WEBSITE_UPSTREAM、WEBSITE_UPSTREAM_REQUIRED 和 MIXED_UPSTREAM_PROTOCOLS 提供双语解释。
4. 使用已有可抛弃平台 API fixture 验证网页提交次数、定位、输入保留、修改后回读、多集群与后端类型切换。补充真实 API 保存边界回归，运行相关类型检查、网页构建与 Nginx/网站路由测试。

架构同步：不适用，理由见 spec.md。
