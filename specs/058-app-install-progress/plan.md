# 实现设计

1. CatalogDrawer 使用专用紧凑安装字段。基本模式使用模板推荐部署方式与默认资源；高级设置以现有 Ant Design Collapse 展开，支持 serviceName、模式、资源、可选参数和追加集群。提交读取保留字段，校验失败自动展开高级设置。唯一集群及唯一在线机器仅在未选择目标时填充。
2. ApplicationInstallDrawer 读取资源详情和按 resource_id 过滤的 runs，聚合部署/实例状态。逐机选择执行历史，增量读取 events 并去重。请求代际隔离、轮询不重入、分页拉全、卸载停止。旧记录无阶段显示真实 run 状态与可读码说明。
3. OperationsPlatformStore.queue 写入 queued 步骤；onJob 将受 lease/sequence 约束的现有 job 状态和白名单 progress 投影至阶段表。保持最终 result 权威，心跳同阶段不重复记录。
4. executeOperation 注入可选 progress；platform 执行器在准备、Compose/OpenResty 启动与验证时发结构化阶段。命令失败仅根据 stderr 识别有限故障码，不暴露原始输出；失败/补偿阶段保留分类原因，未知语义不变。
5. 错误展示区包含实际错误码、具体分类原因及建议；关闭日志不隐式重试，既有执行入口继续提供显式操作。

## 界面设计

品类：运维工具；主动作：选应用后开始安装。沿用现有字号、颜色和抽屉。移除重复部署警告和确认提示，基本参数优先，高级参数按需展开。进度以状态摘要、逐机记录、阶段列表呈现。按钮 loading 即时反馈；Collapse 提供展开过渡；进度抽屉沿用原生入场。减少动效时直接到位。截图、动效证据及自检记录放 evidence/；本次局部流程调整由主 Agent 自检。

## 验证

定向 runtime 测试覆盖事件顺序/重启、心跳去重、旧 Agent、错误分类/秘密不落盘及补偿语义；web/runtime 类型检查。独立 loopback QA 用真实路由和 SQLite、受控 Agent job 回执验证保存失败、阶段、终态、历史读回和网络恢复；浏览器连续三轮。外部 Docker/网络仅在可用时验收，未执行必须明确记录。
