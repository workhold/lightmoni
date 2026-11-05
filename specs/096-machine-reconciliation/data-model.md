# Data Model

reconciliation_resources：id（provider+machine+agent+key 的 SHA256）、provider、category、machine_id、agent_id、resource_key、owner_id、actor、generation、desired_hash、desired_cipher、summary_json、dependencies_json、deleted、state、code、job_id、failures、next_attempt_at、observed_at、observed_generation、updated_at。

(provider,machine,agent,key) 唯一。binding 变动形成旧目标 tombstone 与新目标；desired/actor/deleted 改变时 generation 单调增加、观测失效。状态 pending/in_sync/drifted/blocked；in_sync 必须 observed_generation=generation，且到期重查。tombstone 保留直至 provider 核验清理，仍保留审计。不存在的 provider 不清理。不存正文到 summary、错误或路由回复。

Provider 注册唯一 kind 和 deployment/file/agent/custom 类别；collect 必须全量成功；reconcile 输入只从中心已保存的解密期望生成，不接受客户端资源正文。generation CAS 忽略迟到结果。依赖由同机、当前代次一致的资源 ID 表示。
