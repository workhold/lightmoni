# 实现设计

- OperationsPage将application专用工作区交给InstalledApplications，其他资源不变。URL view=store保留商店位置，CatalogDrawer复用嵌入式商店与安装抽屉，避免两套安装实现。
- 共享ApplicationPortFields展示命名端口、宿主输入、固定容器端口及协议。商店host_ports覆盖模板全部命名端口，listen_ip限0.0.0.0/127.0.0.1；兼容旧parameters.port。系统仓库使用相同映射字段，监听IP继续来自固定私网地址。
- deployments[].host_ports仅覆盖已有命名端口的宿主端口。cluster-workloads验证并在project中合成有效ports，再进入原reserve/effective/Compose和健康发现路径。旧记录省略字段时保留旧默认；更新系统仓库省略host_ports时继承先前配置。
- 卡片展示实际实例端口和逐集群状态，不把期望映射当成运行状态。常用操作明确映射既有deploy/stop/remove/inspect，系统仓库配置仍转专用管理页；unknown先核对，不隐式重试。
- 沿用Ant Design控件、主题变量、短促入场、选项卡指示/抽屉过渡和提交loading反馈；减少动效直接到位。无新增视觉方向或装饰动画。删除重复说明，保留对象、目标、端口和操作后果。
- 定向runtime测试验证端口参数/多集群投影/兼容/冲突和秘密不回显；浏览器三轮验收商店、安装、失败保留、刷新回读及卡片动作，保存桌面/窄屏/200%证据。初版稳定后独立视觉评审。
