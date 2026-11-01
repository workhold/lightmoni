# 设计

1. 在现有主机网络 schema 旁增加 `machine_service_address_settings`，以 machine_id 为主键保存 revision、内外网 mode/address、SSH target_generation、updated_by/updated_at。不存在行时自动模式且 revision=0；不改写观测快照。
2. 服务地址解析复用现有身份校验网卡快照，剔除容器桥/回环/隧道候选；网卡自动选择保持 IPv4 优先。SSH 字面地址及平台公网来源仅附加待确认候选，域名和代理内网不参与。人工 mode/值独立覆盖；旧无快照数字地址兼容保留。
3. 新增管理员专用 GET/PUT `/api/v1/machines/:id/service-addresses`，读取候选与有效配置；PUT 原子校验 revision 与 target_generation，错误代码映射具体字段。主机网络摘要增加同一配置投影，ops 仍通过 machineServiceAddresses 获取，不在集群复制地址。
4. 新增主机“内外网服务地址”短表单，分别设置自动/手动、查看来源并采用候选；编辑独立快照，不被后台心跳刷新重置，失败和冲突保留输入。主机摘要区分网卡发现与服务实际使用。
5. 集群入口缺公网地址时给出明确的主机配置指引，和 SDD077 的发布/DNS状态整理接合；私网就绪端点明确标注用途。
6. 更新仓库与 Doca 设计并最新回读，执行定向 API/网络/网站路由测试与相关类型检查。界面复用 SDD077 的主题与动效约束，使用隔离浏览器验收，不变更线上。
