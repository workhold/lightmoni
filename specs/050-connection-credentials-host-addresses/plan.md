# 实施设计

1. 在现有 SQLite、平台加密与管理员鉴权边界内新增中央 connection_credentials；machine_credentials 保留绑定 ID 并引用中央项，主机记录保存默认绑定。SSH 所有入口从相同解析器取得有效材料，中央秘密不进入 API、AI 或日志。
2. 新增连接凭据 CRUD/撤销及主机默认选择契约，迁移旧密文而不改变旧操作历史。既有安装检查和批准计划继续核对确定的绑定，禁止默认更换绕过复核。
3. Agent 使用 Node networkInterfaces 上报有界网卡地址；节点 register/heartbeat 认证和主机绑定验证通过后，在同一事务记录 machine_network_observations。网络校验失败不得部分刷新心跳或主机绑定。
4. 独立 host-network 查询模块向主机 summary 提供 network。可信代理配置显式注入服务端，来源 IP 不能从 Agent 请求正文取得。
5. 增加运维导航凭据页，登记表单提供已有/新增，SSH 弹窗预选默认；主机栏和详情以原有资产 ID 组织网络信息，限制长地址撑破布局。
6. 运行针对性后端/SSH回归、类型检查、构建及真实浏览器交互验证，修复审查结果；同步 system-design、README 和 Doca，记录回读证据；同步远端 main 后提交功能分支和 GitHub PR。
