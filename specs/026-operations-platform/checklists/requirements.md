# SDD 026：需求质量检查

日期：2026-10-27。以下检查针对需求与验收定义，不代表最终交付或Doca已完成。

- [x] 覆盖网站/证书、Compose、备份/恢复、固定动作计划、AI与UI五个用户场景和价值。
- [x] 配置登记、方案、管理员批准、持续授权、节点执行和真实回执边界明确。
- [x] 管理员、AI、control凭据、job租约与私有载荷的权限和秘密边界明确。
- [x] 中心revision、节点Compose generation、backup CAS、共享证书与现场验证要求可检验。
- [x] unknown/中断/补偿失败、持久节点写锁、人工核实解锁与禁止克隆身份的约束明确。
- [x] 数据卷不回退、pre_restore不自动清理、归档可能含业务秘密等数据边界明确。
- [x] S3目标与密钥复用、100条输出裁剪、Cron/IANA/UTC去重、AI摘要分页都有可测契约。
- [x] Linux依赖、固定本机Docker context、小型静态站与受限JSON Compose范围明确。
- [x] 单元/协议夹具、真实文件、SQLite/HTTP/Agent、Linux领域与模拟后端UI证据不混用。
- [x] 公网ACME、真实S3厂商、生产并发/大容量和最终Doca/PR待办明确，没有用未验收能力作为完成声明。
- [x] 用户成功标准独立于特定函数/文件；实现映射放在plan/contracts/tasks。

待交付的验证、架构在线同步和PR必须按[tasks.md](../tasks.md)完成，不能凭本检查表勾选替代。
