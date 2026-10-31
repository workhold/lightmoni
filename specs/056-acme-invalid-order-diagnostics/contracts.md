# 契约

- 既有 `issue/renew` 和后台回执、管理员 GET run/events 保持兼容，不增加自动申请或生产请求。
- `acme_order_invalid` 仍为稳定错误码，phase 保留实际订单读取步骤；message 改为可用的订单/挑战 problem detail 或明确的无原因解释。可用时携带既有 `domain/error_type/http_status` 白名单字段。
- invalid 订单在诊断网络读取前落库，下一次明确人工申请不会复用；unknown 订单行为不变。
- get_order 对一次实际读取只产生 running→succeeded 或 running→failed；返回 invalid 使用 failed。辅助授权读取和清理有独立步骤，不能改写主失败。
- 不保存完整 CA 响应、原始 challenge/authorization、挑战值或新增凭据；只将有界脱敏诊断进入既有事件/回执/状态。

## 管理员证书材料

- `GET /api/v1/ops/resources/:id/certificate`：返回 `{certificate}`，含 certificate_version、domains、not_before、expires_at、fingerprint_sha256、subject、issuer、chain_length、certificate_pem（叶）、chain_pem（中间链或空）、fullchain_pem。只从已保存版本白名单组装，绝不含 private_key_pem。
- `POST /api/v1/ops/resources/:id/certificate/download`，JSON `{version,format}`；format 只允许 cert/chain/fullchain/private_key，精确限定 certificate_id+version；返回附件 cert.pem/chain.pem/fullchain.pem/privkey.pem（前缀安全资源与版本 ID），Content-Type application/x-pem-file、Cache-Control no-store、X-Content-Type-Options nosniff。私钥不支持 GET 和 URL 参数导出。
- 全部复用 requireAdmin 和正常会话/同源保护。未签发 409 certificate_not_issued；版本不属于证书或缺失 409 certificate_version_missing；无链 409 certificate_chain_unavailable；非法版本/类型 400。材料响应及处理器内的拒绝响应均 no-store，未登录/同源校验复用 Router 的现有前置拒绝；通用资源、日志、工具契约不变。

## 发布

镜像为 docker.heyphp.com/lightmoni/lightmoni，固定标签 YYYYMMDD-主干短 SHA 与 latest，linux/amd64、linux/arm64。固定标签不覆盖不同内容；latest 更新前验证未并发变化。旧标签保留；源码 GitHub PR/main 与镜像 revision 一致。配置引用提交可晚于构建源码，只维护版本、文档与证据。
