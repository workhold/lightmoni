# 网站访问日志身份

生产 Gitea 恢复部署 9a793410637f94cb67db8f2884874501 于 2026-11-06T21:40:19Z 成功。运行卡片恢复正常，原“资源不足”提示消失，首页和 /api/healthz 均经生产中心正常 DNS/TLS 返回 200。

执行端观测 state=ok，队列 0、中心积压 0；ClickHouse 能读到新 OpenResty 容器日志，但 website_id 为空。核对记录正文只取安全字段，发现 body.website_id=4d108de3c8cc58c2df240a485ac1f082，中心标为 unregistered_website_id。该值是 siteBundle 对真实网站 ID 与分组序号生成的片段摘要。日志采集与传输正常，错误发生在网关日志身份编译阶段。

修正方案在规格/设计/契约/T027 先落盘：新增显式原网站 website_id，目录与证书继续使用片段 id。中心所有权校验保持；旧日志不回写。平台真实 HTTP 多绑定生成、Nginx 渲染、旧载荷兼容、非法 ID 和既有归属回归共 91 项通过、0 跳过；runtime typecheck/build 通过。生产新日志验证待固定发行和 Agent 更新后完成。

架构影响为受管网关载荷内的网站身份与观测契约纠正，已更新 docs/system-design.md 的受管观测段；按用户要求只维护仓库本地设计，无 Doca 写入。
