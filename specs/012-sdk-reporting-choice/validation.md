# Validation: SDK 双路径上报

日期：2026-10-19。先提交规格、设计、契约和任务（`757c725`），再修改应用代码。功能分支 `feat/sdk-reporting-modes` 基于已合并 PR #11 的 `origin/main`（`fd42510`）；提交前再次 fetch，远端 main 未变化。

## 验收结果

| 检查 | 结果及证据边界 |
| --- | --- |
| TypeScript SDK `npm --prefix sdk/typescript test` | 25 项通过，0 失败；同时重建发布用 dist |
| Python `PYTHONPATH=sdk/python python3 -m unittest discover -s sdk/python/tests -v` | 30 项通过，包含 5 项新增双路径检查 |
| Ruby `ruby sdk/ruby/test/reporting_test.rb` | 11 项、78 个断言通过，源码与测试语法检查通过 |
| Runtime `npm --prefix runtime run typecheck` | 通过 |
| Runtime `npm --prefix runtime test` | 总计 160 项，157 通过，3 项外部环境检查跳过，0 失败 |
| 最终 SDK 重建后 `cd runtime && node --import tsx --test test/sdk-reporting-modes.test.ts test/agent.test.ts` | 13 项通过，0 失败 |
| `node --test web/src/app/sdkExamples.test.mjs` | 7 项通过，包括真实 shell 环境遗留变量及双向切换 |
| `npm --prefix web run build` | 通过；仅既有依赖指令与分包体积警告，未提交构建缓存 |
| `node web/src/app/verify-sdk-reporting-choice.mjs` | 真实生产 bundle；6 语言 × 2 路径 × 1280/390 宽度，共 24 项通过；详情见 [ui-report.json](ui-report.json) |
| `git diff --check` | 通过 |

## 实际验证的行为

- TypeScript/Python/Ruby 使用本地真实 HTTP 接收端验证所选路由、凭据、失败重试与批次稳定性，未选接收端没有收到请求。
- 显式模式忽略另一条路径的秘密文件、冲突凭据和无效地址；所选来源的冲突、文件校验与无效 mode 仍拒绝。auto 保持旧行为。
- TypeScript/Go/Python 的标准 HTTP Agent 规则路径均改为 Agent/local token，其中 TypeScript/Python 已通过 HTTP 检查，Go 仅完成审查；未新增 PHP/Ruby/Rust 的规则获取 API。TypeScript 自定义 exporter 的显式规则地址与凭据保持兼容，并通过 fromEnv 入口的 HTTP 回归检查。
- TypeScript 无 token 的 Agent 初始化接受解析后的 localhost、IPv4 loopback 和 IPv6 loopback，拒绝相似远程域名及 userinfo 伪装。
- 新增 runtime 集成检查使用真实 SDK、HTTP、Auth、Ingest 和 Agent SQLite 队列：direct 三信号直接到平台；平台不可用时 Agent 持久化 ACK，重启后保留身份/批次，失败不丢队列，恢复后按原 ID 转发，验证凭据、节点标识与日志/链路关联。
- 页面检查覆盖默认 direct、独立地址保持、语言切换、剪贴板环境块/代码、容器提示、Key 标签往返、非法地址禁用复制；已检查桌面和窄屏截图。

## 限制

- 当前环境没有 Go/gofmt、PHP、Cargo/rustc。Go/PHP/Rust 的新增配置测试仅完成代码审查，**未执行原生编译和测试**；PHP/Rust 各新增 8 项。可用工具链环境需运行 `go test ./sdk/go`、`php sdk/php/tests/reporting_test.php`、`cargo test --manifest-path sdk/rust/Cargo.toml`。
- Runtime 集成测试将 ClickHouse 写入替换为收据 sink，不代表实库验证；页面使用只读 API fixtures，不代表在线后台端到端验证，未修改真实平台配置。旧 `verify-reporting-addresses.mjs`/`verify-sdks.mjs` 仅同步相关选择器，未执行其整套旧流程。
- 不宣称 SDK 进程内缓存或 Agent 有界磁盘队列可以保证零丢失，不增加跨 SDK 合批、压缩、自动改投或节点模型能力。

## 交付

[PR #13](https://gitea.heyphp.com/lightmoni/lightmoni/pulls/13) 指向 main，已创建完整标题与说明，等待用户审核；未合并。
