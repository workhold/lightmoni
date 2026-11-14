# 162 · 服务主体与固定只读自动化授权

状态：实现与验证完成，等待评审与合并授权。继承 SDD 046/047/134～161 与全平台能力开放 Goal，开始 Slice 5。基线为 `main@5076f64`，不依赖未合入 PR。

## 需求与范围

1. 增加独立服务主体，不复用或伪造个人用户 ID；服务主体具有独立 `service` 标记、Owner、凭据、授权、审计主体、限流主体和调用预算。
2. 管理员通过现有 Web 会话下的 MCP 接入管理 API 创建、查看和撤销服务主体；明文凭据仅在创建响应出现一次，数据库和管理摘要不得返回明文或 token hash。
3. 每个服务主体固定绑定一组稳定 capability_id、工具名称与 major version、允许的输入约束、Scope、Host 范围、总调用次数和到期时间。本切片仅允许描述符中 `effect=read`、`operationKind=center_read`、`risk=R0/R1` 且对 MCP/HTTP 曝光的能力。
4. 输入约束采用递归固定子集：规则中出现的字段和值必须完全一致，未列字段仍须通过能力 JSON Schema、Scope、Host 和通用输入限制；数组和标量必须整体等值。不得把约束解释为 SQL、脚本或任意模板。
5. 工具发现、OpenAPI 和实际调用均只暴露授权规则内的 capability/version。实际执行前再次校验服务、Owner、grant、token、规则、输入和 Host，并以条件更新原子消耗一次总调用预算。
6. 预算在实际领域执行前消耗；消耗后即使领域调用失败、取消或进程中断也不退回。发现、鉴权/Schema/规则拒绝和预算耗尽不消耗预算。禁止通过并发请求超过预算。
7. Owner 必须保持有效管理员；Owner 停用或降权、服务/grant/token 撤销、授权到期、能力版本漂移、规则或 Host 不匹配均失败关闭。
8. 保持个人 PAT、OAuth、Web、内部助手、现有 54 个工具及其请求/响应兼容。普通服务调用继续经过 Capability Dispatcher，不模拟 MCP，也不新增业务状态机。
9. 修复能力 HTTP 在真实 Router 中仍强制要求 Web Cookie 的接线缺口：Bearer 无 Cookie 可独立调用；Web 会话继续执行原 Origin 检查，未认证请求失败关闭。

## 非目标与安全边界

- 不开放 `propose`、直接 `execute`、远程探测、任意 SQL/Shell、凭据管理 MCP 工具、自动批准或通用 apply/approve/execute。
- 本切片不提供服务主体写提案持续授权；后续写授权必须独立 SDD，复验提交、审批、领取和启动，并绑定原生提案与稳定 grant。
- 不实现服务主体轮换、策略编辑、OAuth client credentials、外部身份联邦或跨安装授权；需要变更时撤销并新建。
- 不操作生产主机、不发布镜像，不宣称真实 Codex/Claude 或生产 E2E 已验证。

## 验收

1. 服务主体的 Principal、调用审计和限流使用独立服务 ID，不出现在 `users`，不能作为浏览器个人会话登录；个人凭据行为不变。
2. 授权内只读能力可通过 MCP Bearer 与普通 HTTP 发现/调用，未授权能力、版本、输入和 Host 被拒绝且不出现在 OpenAPI。
3. 总调用预算在并发下不超支，消耗后失败不退款；撤销、过期和 Owner 权限变化立即生效。
4. 管理 API 仅 Owner 管理员可操作，秘密只返回一次，自动化反例、相关回归、类型检查和构建有真实记录。
