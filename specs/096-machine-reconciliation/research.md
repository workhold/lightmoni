# Research

- Decision: 独立注册调度核心，provider 复用现有业务权威源与执行路径。Rationale: 保留 placement/rolling、machine fencing 和签名权限。Alternatives: 重写全部调度会破坏已上线可用性保障；只重试历史任务无法修复漂移。
- Decision: 重新实际检查而非缓存成功状态。Rationale: Agent 同版本内容可变；证书历史成功不等于当前文件。Alternatives: 版本号相同直接跳过不能对账。
- Decision: 证书同版本损坏创建新的物理修复目录再原子切换，保留逻辑版本。Rationale: 避免在当前目录部分更新造成证书/私钥不成对，同时尊重版本不可变。Alternatives: 原地覆盖存在发布窗口；盲目覆盖最终外部文件破坏归属。
- Decision: 不增加新传输/凭据。Rationale: 变更即时入已有持久作业队列，Agent/config 使用现有轮询与控制身份；定期快照弥补漏通知。
- Evidence: origin/main nodes-model.ts compile/effective、agent.ts applyRemote/controlOnce、cluster-workloads.ts reconcile/inspect、certificate-cluster-delivery.ts latest/sync、platform.ts installCertificate/inspectCertificate。
