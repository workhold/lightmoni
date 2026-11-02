# 契约

主机管理员响应新增可选 agent_operation：{id,machine_id,kind:install|uninstall,status,execution_stage,created_at,started_at,finished_at,error,resolved_at} 或 null。数据只来自当前主机持久记录，不含计划、凭据、SSH输出或秘密。优先未结束且未人工结束的 awaiting_approval/running/unknown；否则选择安装/卸载中最新记录。

前端公共组件接收 kind、machineID、record（上述字段或既有完整记录）、submitting?、compact?。安装 planned/awaiting_approval=0、preflight=15、enrollment_issuing/enrollment_issued=30、bootstrap_dispatched=55；卸载运行=50。不根据时间增加百分比；running无细阶段时显示活动阶段。succeeded=100；unknown/failed/cancelled 不显示成功，unknown标记需核对。时间只展示实际开始后的已耗时。

已知记录只 GET /machines/:id/deployments/:recordId 或 /uninstallations/:recordId，绑定 machine_id/id。轮询不创建计划、不apply/reconcile、不修改审批状态；仅在执行/提交期间读，终态停止，失败保留最后进度并显示刷新提示。列表复用已有 GET /machines 的安全摘要，无逐行额外SSH或秘密读取。
