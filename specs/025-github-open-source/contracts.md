# SDD 025：迁移契约

- 目标：`https://github.com/workhold/lightmoni`，默认分支 `main`。
- 来源：`ssh://git@gitea.heyphp.com:222/lightmoni/lightmoni.git`。
- 保留 Git 提交 ID/作者/历史，来源远端命名 `gitea`，目标远端命名 `origin`；只有核对成功后才调整当前开发仓库远端。
- 只迁移来源实际 heads/tags，不将本机未推送分支和内部 `refs/pull/*` 写入 GitHub 保留命名空间。
- 后续业务代码变更仍通过 PR；迁移已有基线的首次 GitHub 导入不等同于新增业务代码直推主干。
- GitHub `main` 保护要求 PR、解决评审对话，禁止强推与删除且覆盖管理员；不强制额外评审人数，不配置不存在的 CI 检查。启用私密漏洞报告，与 SECURITY.md 的入口保持一致。
- Go 模块新路径：`github.com/workhold/lightmoni`；SDK 路径：`github.com/workhold/lightmoni/sdk/go`。
- 历史证据、线上域名、Docker 注册表与 Doca 文档地址保持原义；不导出认证 token、SSH 凭据、本机配置或数据库。
- 用户已选择项目自有代码使用 Apache-2.0；根 LICENSE 为完整标准文本，TypeScript/Python/Rust 独立包及 Go SDK 发布归档均附带同一文本，npm/Cargo/Python 提供许可元数据。第三方已有许可证、版权和 NOTICE 保留其来源及适用范围，不受项目根许可替换。
