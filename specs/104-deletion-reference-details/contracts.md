# 契约

DELETE /api/v1/ops/resources/:id：请求仍为 {revision}；409 响应的 error 保持 platform_resource_in_use，并新增 references 数组。每项为 {id,kind,name,domains,sources}，sources 为 {type:'saved'|'published',revision:number} 数组。域名只取实际包含引用的配置快照。

所有元数据仅向经过原管理员鉴权的请求返回。其他失败码、成功响应、引用规则及执行保护不变。失败不得提交资源删除、网站撤下或配置更新。

前端接受无 references 的旧错误响应；新清单中的跳转仅使用本地已知资源类型对应的站内路由和 ID，不接受服务端提供的任意 URL。

查看资源使用既有列表路由加 resource 查询参数打开详情；关闭详情清除参数，刷新可恢复同一资源。
