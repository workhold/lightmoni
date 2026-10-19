# Validation

已验证：

- `npm --prefix runtime run typecheck`
- `npm --prefix web run typecheck`
- `npm --prefix web run build`
- `npm --prefix runtime test -- --test-name-pattern='managed machines|deployment plan|password credentials|manual script'`（主机管理相关测试通过）
- `npm --prefix runtime test`（完整运行时测试）
- `git diff --check`

测试覆盖主机输入校验、凭据加密隔离、密码短 TTL、撤销、手动脚本与自动 SSH 边界、主机指纹阻断、管理员确认、token/私钥/主机输出脱敏和 AI 回执边界。真实外部主机、SSH 网络、Vault/KMS、云 SSM、生产 Agent 发布和私网 Relay 不以 fixture 代替；生产发行包还应补签名元数据校验。

## PR 交付

[PR #15](https://gitea.heyphp.com/lightmoni/lightmoni/pulls/15) 已创建，目标为 `main`，当前等待审核，未合并。页面、接口、部署计划和 AI 系统提示均提醒 SSH 密码只建议一次性使用，不要长期保存；长期运维优先使用每台主机独立的 SSH 私钥、Vault/SSM 或手动 enrollment 脚本。
