# 贡献 LightMoni

代码、问题和新的 Pull Request 使用 [workhold/lightmoni](https://github.com/workhold/lightmoni)。历史 Gitea PR 链接继续作为验收来源保留。

## 开发流程

1. 阅读 [AGENTS.md](AGENTS.md)、[系统设计基线](docs/system-design.md) 与关联的 `specs/`。
2. 从最新 `main` 创建功能分支。先记录 SDD 规格、方案、契约和任务，再修改应用；验收记录应区分自动 fixture、真实服务验证和未覆盖范围。
3. 架构变更同时更新 `docs/system-design.md` 和 Doca 在线基线，保留原生图块，并记录成功写入与回读证据。没有架构影响时说明“不适用”及理由。
4. 运行与变更有关的检查，在 PR 中说明问题、最终行为、兼容影响和验证结果。不要直接向主干推送或自动合并未获授权的 PR。

## 本地开发

中心、Agent、AI worker 与网页使用 Node.js/TypeScript。根开发环境需要 Node.js 22.19 或更新版本；Go SDK 开发使用 `go.mod` 指定的 Go 版本，Python/Rust SDK 按各自清单准备环境。

```sh
npm run setup
npm run build
npm run typecheck
```

按修改范围选择检查：

```sh
npm --prefix runtime test
npm --prefix ai-runtime test
npm --prefix sdk/typescript test
go test ./sdk/go
PYTHONPATH=sdk/python python3 -m unittest discover -s sdk/python/tests
cargo test --manifest-path sdk/rust/Cargo.toml
```

集成测试中需要 ClickHouse、Linux systemd 或外部模型的用例，应准备隔离环境，并准确记录实际执行与跳过项。不要将测试中心接入生产 ClickHouse，也不要以模拟响应代替真实供应商验收。

## 提交内容

- 不提交 `.env`、真实密钥、SSH 私钥、数据库、生产日志、会话、录屏中的秘密或本机配置。示例使用明显的占位值，凭据通过受保护的运行时机制提供。
- 保留已有第三方版权、LICENSE 和 NOTICE；参考当前 Doca 源码时遵守其实际许可证，不把当前 AGPL 代码作为历史 MIT 代码复制。
- 更新相应文档；发布镜像和安装包时，保留可核对的源码 revision、内容摘要及真实验证边界。

安全问题请按 [SECURITY.md](SECURITY.md) 私下反馈，不在公开 Issue 或 PR 中披露可利用细节和凭据。
