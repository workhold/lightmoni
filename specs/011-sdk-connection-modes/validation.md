# SDK 连接模式验收记录

日期：2026-10-18
状态：以下 2026-10-18 检查记录保留原始语言范围。2026-10-19 发布范围调整为 TypeScript/JavaScript、Python、Ruby；PHP 原生 SDK 下线，Go/Rust 仅保留源码、后续支持，不纳本次发布验收。当前范围调整的检查记录见 [012 验收](../012-sdk-reporting-choice/validation.md)。

## 已实现基线

- 六种保留语言（Go、TypeScript/JavaScript、Python、PHP、Ruby、Rust）增加 `agent` / `direct` / `auto` 连接模式和等价环境构造入口。
- `LIGHTMONI_MODE`、`LIGHTMONI_ENDPOINT`、`LIGHTMONI_DATA_KEY(_FILE)`、`LIGHTMONI_AGENT_ENDPOINT`、`LIGHTMONI_LOCAL_TOKEN(_FILE)` 已接入；`LIGHTMONI_KEY` 保留为 data key 兼容别名。
- Secret 文件、显式参数和环境变量发生冲突时拒绝启动；诊断只记录来源类别和 route 状态，不记录秘密。
- Agent 模式只向本机/显式 Agent 发送 local token；direct 模式使用 table-scoped data key；auto 仅在启动探测未建立连接且未发送业务 body 时回退。
- Java/C# 原生源码、包构建和发布入口已移除；历史验收文档保留并明确为历史记录，中心继续接受标准 OTLP exporter。

## 实际执行的检查

在当前工作树执行：

```sh
npm --prefix runtime run typecheck
npm --prefix runtime test
python3 -m py_compile scripts/*.py
sh -n scripts/build-*.sh
npm --prefix sdk/typescript run build
npm --prefix sdk/typescript test
ruby -c sdk/ruby/lib/lightmoni.rb
```

结果：runtime typecheck 通过；runtime 测试 `155 passed, 3 skipped, 0 failed`；Python、shell、TypeScript 构建/测试和 Ruby 语法检查通过。runtime 新增 enrollment/activate、同 nonce 恢复、不同 nonce 重放拒绝、control/data audience 隔离和 Agent 配置兼容测试均包含在测试集中。

Java/C# 源码、构建入口和当前发布清单扫描未发现残留；历史验收材料中的 Java/C# 记录已标注为历史，不属于当前支持矩阵。

## 尚未验证或保留的限制

| 范围 | 状态 |
| --- | --- |
| Go SDK | 源码保留、后续支持；原生工具链和完整模式矩阵未纳本次发布验收，不生成本次发布包 |
| PHP SDK | 已决定下线，历史代码基线与测试记录不代表当前发布支持 |
| Rust SDK | 源码保留、后续支持；原生工具链和完整模式矩阵未纳本次发布验收，不生成本次发布包 |
| 历史六语言 shared fixture | 各语言已有实现和局部测试，统一 direct/agent/auto fixture、401/403、TLS、丢响应和批次未知结果仍待完成 |
| auto 语义 | 当前发布语言的完整跨语言错误矩阵仍需按实际检查记录验收；Go/Rust 验收延后，PHP 不再纳入 |
| Java/C# 迁移 | 原生包已下线；标准 OTLP 迁移示例和外部 exporter 端到端验证仍需补充 |
| Agent enrollment | 由 [010 规格](../010-agent-deployment/validation.md)负责；SDK 不签发 enrollment/control/data credential |
| 凭据泄露审计 | argv、环境诊断、trace、容器层和浏览器 bundle 的完整审计仍待执行 |

## 待取得的验收证据

1. 当前三语言 direct 和 Agent 集成测试：table 授权、local token、断网补传、401/403、429/5xx、key rotation。
2. auto 测试：Agent 成功、未监听回退、鉴权/TLS/协议错误不回退、body 已发送后未知结果不改投。
3. 同一 OTLP fixture 的 metric/log/trace/table/headers 与自定义打点语义一致。
4. 凭据在 argv、环境诊断、日志、trace attributes、URL、异常、batch payload、容器层和浏览器 bundle 中均无泄露。

## 验收结论

以上连接配置、凭据读取及原六语言代码基线是历史检查结论，未声明完整跨语言生产验收通过。本次发布仅包含 TypeScript/JavaScript、Python、Ruby；PHP 下线，Go/Rust 源码保留但未纳本次发布验收，后续必须另行完成工具链、统一 fixture 与完整故障矩阵。
