# Validation: SDK 双路径上报

日期：2026-10-19。先提交规格、设计、契约和任务（`757c725`），再修改应用代码。功能分支 `feat/sdk-reporting-modes` 原基于 PR #11；本次按用户要求缩减 SDK 发布范围，已合并远端 main（`ac63f24`），保留 PR #14/#15 的功能。

## 验收结果

| 检查 | 结果及证据边界 |
| --- | --- |
| TypeScript SDK `npm --prefix sdk/typescript test` | 25 项通过，0 失败；同时重建发布用 dist |
| Python `PYTHONPATH=sdk/python python3 -m unittest discover -s sdk/python/tests -v` | 原 30 项通过；工具链复验修复后最终 32 项全部通过，新增真实 close-delimited/chunked ACK、规则拉取及截断响应回归 |
| Ruby `ruby sdk/ruby/test/reporting_test.rb` | 11 项、78 个断言通过，源码与测试语法检查通过 |
| Runtime `npm --prefix runtime run typecheck` | 通过 |
| Runtime `npm --prefix runtime test` | 同步 main 后总计 185 项，182 通过，3 项外部环境检查跳过，0 失败 |
| 最终 SDK 重建后 `cd runtime && node --import tsx --test test/sdk-reporting-modes.test.ts test/agent.test.ts` | 13 项通过，0 失败 |
| `node --test web/src/app/sdkExamples.test.mjs` | 7 项通过，包括真实 shell 环境遗留变量及双向切换 |
| `npm --prefix web run build` | 通过；仅既有依赖指令与分包体积警告，未提交构建缓存 |
| `node web/src/app/verify-sdk-reporting-choice.mjs` | 真实生产 bundle；3 种当前发布语言 × 2 路径 × 1280/390 宽度，共 12 项通过；Go/Rust 显示为后续支持，PHP 不展示；详情见 [ui-report.json](ui-report.json) |
| `cd runtime && node --import tsx --test test/sdk-release-scope.test.ts` | 通过；真实 HTTP 验证目录中残留的 PHP/Go/Rust 包也返回 404，当前三个 SDK 可下载 |
| `npm run release:sdk` | 通过；无需 Go/PHP/Rust 工具链，复用下载目录只保留当前三个 SDK 包及校验条目 |
| Go 1.27.2 `LIGHTMONI_TRACE_TEST=1 LIGHTMONI_NATIVE_SDK_TEST=1 go test -race -count=1 -json ./sdk/go` | 25 个顶层测试及 9 个子测试全部通过，无跳过；包含 Go→Node→Go 链路和 Python/Ruby→真实 Agent 持久队列检查 |
| 最终 Python 完整性修复后 `LIGHTMONI_NATIVE_SDK_TEST=1 go test -race -count=1 -run '^TestNativeSDKsDurablyAcceptedByActualAgent$' -v ./sdk/go` | 再次通过，真实 Agent 成功接收两语言业务三信号和 SDK 自监控 |
| Rust/Cargo 1.99.1 `cargo test --locked --manifest-path sdk/rust/Cargo.toml` | 8 项单元测试通过，无忽略；锁文件未变 |
| Rust `cargo build --locked --manifest-path sdk/rust/Cargo.toml --example demo` 后 `python3 scripts/test-sdks.py --languages rust --skip-build` | 12 项 HTTP 场景通过：fixture、trace_scope、demo、overflow、retry、rate、auth、invalid_ack、ack_loss、permanent、partial、capacity |
| `git diff --check` | 通过 |

## 原生工具链补验与 Python 修复

本机 macOS arm64 使用 Homebrew 安装 Go 1.27.2、rustup 1.29.1，Rust stable 为 1.99.1，保留 cargo/rustc/rust-std 最小组件。新登录终端已验证命令可用。下载与 Cargo 测试使用临时镜像参数，没有写入仓库或用户的永久镜像配置；Rust 测试复用 `.lightmoni/sdk-test/rust` 构建目录。

启用此前因工具链缺失未执行的 Go 集成测试后，发现 Python SDK 在 `Connection: close` 响应读到 EOF 后对已关闭 socket 设置 timeout，导致 Agent 的成功 ACK 被当作网络失败。修复只跳过关闭描述符的 timeout 设置，保留截止时间、取消和响应大小限制；新增真实 HTTP/1.1 无 Content-Length 与 chunked 两种响应回归，既有慢响应、取消和超大 ACK 检查继续通过。

独立复查补充验证响应完整性：Content-Length 未读满的提前 EOF 会抛传输错误，分块响应沿用标准库完整性检查。真实截断 ACK 不确认批次，重试保留相同 Batch-ID 和正文；截断规则响应保留旧 revision，接收端恢复后正常交付。HEAD 与 204 的合法空响应已通过单独真实 HTTP 检查。

同一集成检查的旧断言把 SDK 自监控批次也计入 6 个业务批次，本轮改为单独核对业务数据，并累积多批次结果；两种语言各 20 个指标计数、20 条业务日志、20 条跨度及日志/链路关联校验均保留。

## 实际验证的行为

- TypeScript/Python/Ruby 使用本地真实 HTTP 接收端验证所选路由、凭据、失败重试与批次稳定性，未选接收端没有收到请求。
- 显式模式忽略另一条路径的秘密文件、冲突凭据和无效地址；所选来源的冲突、文件校验与无效 mode 仍拒绝。auto 保持旧行为。
- TypeScript/Python 的标准 HTTP Agent 规则路径均改为 Agent/local token，已通过 HTTP 检查；Ruby 沿用既有行为，Go/Rust 暂不作为当前发布 SDK，PHP 已移除。TypeScript 自定义 exporter 的显式规则地址与凭据保持兼容，并通过 fromEnv 入口的 HTTP 回归检查。
- TypeScript 无 token 的 Agent 初始化接受解析后的 localhost、IPv4 loopback 和 IPv6 loopback，拒绝相似远程域名及 userinfo 伪装。
- 新增 runtime 集成检查使用真实 SDK、HTTP、Auth、Ingest 和 Agent SQLite 队列：direct 三信号直接到平台；平台不可用时 Agent 持久化 ACK，重启后保留身份/批次，失败不丢队列，恢复后按原 ID 转发，验证凭据、节点标识与日志/链路关联。
- 页面检查覆盖默认 direct、独立地址保持、语言切换、剪贴板环境块/代码、容器提示、Key 标签往返、非法地址禁用复制；已检查桌面和窄屏布局。PHP 不在语言选项中，Go/Rust 只展示后续支持状态。

## 限制

- Go/Rust 当前仍仅保留源码、后续支持；以上原生与 HTTP 源码测试不等同于恢复发布或完成 direct/agent/auto 全部故障矩阵。PHP SDK 已删除。
- Runtime 集成测试将 ClickHouse 写入替换为收据 sink，不代表实库验证；页面使用只读 API fixtures，不代表在线后台端到端验证，未修改真实平台配置。旧 `verify-reporting-addresses.mjs`/`verify-sdks.mjs` 仅同步相关选择器，未执行其整套旧流程。
- 不宣称 SDK 进程内缓存或 Agent 有界磁盘队列可以保证零丢失，不增加跨 SDK 合批、压缩、自动改投或节点模型能力。

## 交付

[PR #13](https://gitea.heyphp.com/lightmoni/lightmoni/pulls/13) 已由用户合入 main（`fb3086f`）。本轮工具链补验和 Python 短连接响应修复基于该主干，使用独立修复分支 `fix/sdk-agent-connection-close` 提交 PR，未自动合并。
