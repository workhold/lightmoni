# SDD 025：迁移验收

日期：2026-10-27。

## GitHub 与来源核对

- 公开仓库：<https://github.com/workhold/lightmoni>，默认分支 `main`；GitHub API 和无认证 API 请求均确认 `private=false`。
- Gitea 源主干：`a3992bff5627b8142266b9d50785602a86b4c414`。迁移后再次读取源 heads/tags，确认未发生并发变动；19 个源分支全部与 GitHub 摘要一致，覆盖 117 个提交，源标签数量为 0。逐项结果见 [refs-verification.json](../../docs/evidence/github-migration/refs-verification.json)。准备分支属于迁移后的新改动，不计入 19 个源分支。
- 本地 `origin` 已切换到 GitHub SSH 地址，原来源保留为 `gitea`，默认推送目标为 `origin`。初次 HTTPS 上传超时且未写入分支，随后 SSH 原子上传成功；没有重写历史或强推。
- `main` 已配置必须通过 PR、覆盖管理员、要求解决评审对话，禁止强推与删除；不强制额外评审人数，没有配置不存在的 CI 检查。GitHub 私密漏洞报告已开启并回读确认。

## 内容审核

- 全部分支历史使用 Gitleaks 8.30.1 扫描；官方分发包校验和核对通过。人工检查覆盖 2,660 个唯一 blob（116,843,093 bytes），未发现真实凭据。
- 扫描器退出码为 1，产生 3 项命中：1 项合成 JWT 凭据拒绝用例、2 项不可用 PEM 模拟凭据 fixture，均已核对为误报。详见 [audit-summary.json](../../docs/evidence/github-migration/audit-summary.json)，不提交原始扫描报告。
- 当前 6 个 PNG 与历史媒体的生成/来源已审查；历史有 411 个媒体 blob，未逐帧检查所有录屏，不能宣称覆盖每一帧。
- `.specify/LICENSE` 与 Doca 历史参考代码 NOTICE 按原样保留。用户明确选择 Apache-2.0，根与 SDK 完整许可文本及打包证据见 [license-packaging.json](../../docs/evidence/github-migration/license-packaging.json)。新文件随准备 PR 交付，未合并前默认分支仍是原 Gitea 基线。

## 相关检查

以下检查通过：

```sh
GOPROXY=off GOSUMDB=off go test ./sdk/go ./examples/sdk/go/... ./examples/sdk/precision ./examples/logs/go ./examples/self-monitoring/...
node --test web/src/app/sdkExamples.test.mjs
npm --prefix web run typecheck
PYTHONPATH=sdk/python python3 -m unittest discover -s sdk/python/tests
cargo metadata --offline --no-deps --format-version=1 --manifest-path sdk/rust/Cargo.toml
git diff --check
```

- 网页 SDK 示例测试 4/4、Python 测试 32/32；另外核对动态生成的 Go 安装/示例路径及 npm/Python/Cargo 仓库元数据。
- TypeScript SDK `npm pack --offline`、Python `uv build --offline` 的 sdist/wheel、`scripts/build-go-sdk.sh` 与 `scripts/build-native-sdks.sh` 实际生成的 Go/Python/Rust tarball 均已检查包含正确许可证。npm、Python wheel 和 Cargo 元数据均为 Apache-2.0。
- Python SPDX 元数据使用 `setuptools>=77` 构建，SDK 运行要求仍为 Python 3.9+。
- Rust `cargo package --offline --allow-dirty --no-verify` 和 `--list` 因本机缺少 `hyper` 缓存索引失败；只确认现有 Rust 发布 tarball 及 Cargo 元数据，未声称生成 `.crate` 或向包注册表发布。
- 本次未修改产品运行逻辑，未重跑需要外部模型、ClickHouse 或 Linux/systemd 的完整产品验收。

## 迁移范围与架构记录

- 迁移范围为 Git heads/tags。Gitea 历史 PR、评论、评审、Issue 与平台附件未迁移；源站仍保留这些记录及原验收链接。
- Gitea 尚存开放 PR #12、#17、#23，不自动关闭或合并；其中 #17 的源分支已被删除，其平台 PR 保留在原站，不作为正式 heads 迁移。
- 没有删除/归档 Gitea，没有变更线上服务、生产凭据或已有镜像。`docker.heyphp.com` 预构建镜像的注册表访问要求已在 README 明示，没有创建未经验证的 GHCR 公开镜像。
- 架构同步不适用：仅代码托管、许可、贡献入口和 Go 模块路径变化，不改变组件、存储、部署拓扑、控制/数据路径或凭据边界；不改写仓库系统设计与 Doca 原生图块。

## PR 交付

开源准备改动通过 `chore/github-open-source` 分支提交 GitHub PR；许可证、模块路径和贡献入口在 PR 合入后进入默认分支。本次不自动合并。
