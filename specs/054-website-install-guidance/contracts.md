# 前端契约

- `GET /ops/overview`：沿用管理员资源快照。仅成功快照中不存在 `kind=application, spec.role=openresty` 才显示安装引导；请求失败展示重试。
- `/applications?install=openresty`：前端安装深链接，加载既有 catalog 并自动选中 OpenResty；不发起安装写入，直到用户提交现有确认安装表单。关闭移除 install 参数，成功后回到网站列表。已安装单例不提供重复安装。
- `GET /ops/catalog`、`POST /ops/catalog/:id/install`：保持既有版本、部署集群、参数、确认与错误契约，无后端变更。
- `/clusters`：保留原有管理员管理路由；从集群字段以新窗口链接进入，父表单继续保留，资源通过页面恢复焦点和现有轮询回读更新；应用及网站表单不再内嵌快捷新建集群。
- `/operations` 与旧本地集群首页偏好：转到 `/applications`。`/clusters` 仍可直接访问并保留登录后的目标地址。
