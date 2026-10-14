# Python SDK 远程上报控制验收

**日期**：2026-10-14

**分支**：`004-python-sdk-reporting`

**结果**：三条用户旅程及 18 项任务完成。规格、设计、契约与任务在应用代码修改前建立，随后按失败测试、实现、回归和独立审阅执行。

## 验证环境

macOS，Python 3.9.6，项目本地 Go 1.27.2；Python 运行时没有新增第三方依赖。所有接收器、SQLite 中心和 Agent 均使用隔离实例；未修改用户正在运行的服务或浏览器。原有 `web/tsconfig.tsbuildinfo` 生成文件改动保留在工作区，不属于此功能提交。

## 需求与可执行证据

| 场景 / 成功标准 | 验证与结果 |
| --- | --- |
| US1 / SC-001：UID 排除优先，QA/VIP 取最高比例，未匹配日志忽略 | Python 实际 HTTP 载荷测试与中心/Agent 集成通过；受控忽略不增加交付损失计数。 |
| US1 / SC-002：稳定用户组及跨语言一致 | 10,000 个 UID 各重复两次，10% 规则保留组落在 7%～13%，每个入选 UID 两次均接收；Python/Go 直接比较 69 个固定向量通过。Python 契约还固定了 17 个 TypeScript 标量向量及 50 个缺失键事件向量。 |
| US1 / SC-005：日志选择不影响指标、链路 | 空日志策略和 UID 排除下，指标/Span 仍提交；自监控绕过业务日志规则。 |
| US2 / SC-003：停报清理、取消、恢复只收新数据 | 根/子表全信号缓冲和队列清理，受控响应等待与认证退避在一秒内取消；旧 ACK 不改变恢复后的队列，旧 Span 不补交。 |
| US3 / SC-004：快照失败回退、独立轮询恢复 | 非法、重复字段、超大、认证失败、慢响应与重定向保留最后有效版本；关闭自监控、命中停报后仍拉取并恢复。 |
| US3 / SC-005：策略更新不改变冻结重试 | 同一批次 ID、创建时间和正文在失败重试及策略更新后保持一致。 |
| FR-008 / FR-009：生命周期、传输与凭证边界 | 并发刷新总预算、关闭时迟到配置、共享 shutdown、Key 轮换、代理隔离均通过；配置错误不含 URL、Key 或响应正文。 |
| FR-010：真实平台与 Agent 边界 | 真实 SQLite 中心配置及认证、Key 表过滤、Agent 配置转发和 SQLite spool 接收通过。 |

跨语言证据覆盖上述明确向量，不声称各语言对所有超出安全精度的数字都有相同表达；长 UID 应使用字符串。

## 执行记录

以下命令在仓库根目录执行。

```sh
PYTHONPATH=sdk/python python3 -m unittest discover -s sdk/python/tests -v
python3 scripts/test-sdks.py --languages python
.local-dev/go/bin/go test -race ./sdk/go ./internal/server \
  -run 'TestPythonSamplingMatchesGo|TestPythonReportingCenterAndAgent' -count=1
.local-dev/go/bin/go test -race ./sdk/go ./internal/agent ./internal/server
npm --prefix web run build
git diff --check
```

- 最终源码 **25 项测试全部通过，4.499 秒**；真实 TLS 测试未跳过，覆盖 HTTPS 直连、HTTP CONNECT 隧道及 HTTP 目标经 HTTPS 代理。证书/私钥仅在临时目录生成并清理。
- Python 既有 **12 项契约回归全部通过**：fixture、trace_scope、demo、overflow、retry、rate、auth、invalid_ack、ack_loss、permanent、partial、capacity。
- 最终跨语言与平台集成 race 回归通过：`sdk/go` 1.784 秒，`internal/server` 6.643 秒。
- 完整相关 Go race 套件通过：`sdk/go` 31.874 秒、`internal/agent` 缓存通过、`internal/server` 9.131 秒。首次运行中既有 `TestRuntimeIdleTimerProducesHeartbeat` 出现定时等待失败；隔离重跑通过，随后完整套件通过，未修改该测试或其实现。
- 前端 TypeScript/Vite 生产构建通过；现有依赖的 `use client` 和 chunk-size 提示不影响结果。
- 新 API 尚未实现时，Python 测试因 `unknown SDK limit` 失败；隔离旧 HEAD SDK 的中心和 Agent 两条集成路径也因同一缺失失败，证明验收测试能够识别未实现的功能。

## 安装包验证

本机旧构建工具曾生成错误的 `UNKNOWN-0.0.0` 空 wheel，已拒绝作为成果。使用仅位于 `.local-dev/python-reporting-venv` 的独立环境和 `setuptools==75.8.2`、`wheel==0.45.1` 构建正确包，未修改全局 Python 环境。

```sh
.local-dev/python-reporting-venv/bin/python -m pip --isolated wheel \
  --no-deps --no-build-isolation \
  --wheel-dir .local-dev/python-reporting-package-v2 ./sdk/python
.local-dev/python-reporting-venv/bin/python -m pip --isolated install \
  --no-deps --force-reinstall \
  .local-dev/python-reporting-package-v2/lightmoni_sdk-0.1.0-py3-none-any.whl
env -u PYTHONPATH .local-dev/python-reporting-venv/bin/python \
  -m unittest discover -s sdk/python/tests -v
sh scripts/build-native-sdks.sh 0.1.0 .local-dev/python-reporting-release
```

安装后的最终 wheel **25 项测试全部通过，4.408 秒**；确认导入来自 venv 的 `site-packages`，元数据为 `lightmoni-sdk 0.1.0`，没有运行时依赖。wheel 与 Python 源码归档中的 `__init__.py`、`sampling.py`、`transport.py` 逐字节匹配最终源码，包内 README 也与最终文档一致。

| 本地成果 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `.local-dev/python-reporting-package-v2/lightmoni_sdk-0.1.0-py3-none-any.whl` | 17093 | `101c1f1cf9d9411e95615362ff492c39d8ecc8be5ac7391d57d2924917ca1b0c` |
| `.local-dev/python-reporting-release/lightmoni-python-sdk_0.1.0.tar.gz` | 29261 | `841141d1fcf3c8f39efb5423edd9a9979c130b1bb96c4a46d57d055e81b3ec65` |

这些是本地验证成果，尚未发布到包仓库。

## 审阅与使用边界

独立审阅发现的三个问题均已修复并增加回归，最终只读复核确认修复有效、无新增明确缺陷：超时取消导致响应 EOF 被误当有效正文、环境代理支持丢失、根/子表并发 shutdown 取消最终 flush。传输在 EOF 后再次检查终态，配置解析后检查截止时间；保留代理与 no_proxy；shutdown 由一个调用拥有最终 flush，其他调用等待相同完成结果。SDD 一致性审阅核对测试数、任务数及包校验值，并修正了 None 回退语义和共享关闭事件的描述。

- 默认首次自动拉取发生在 30 秒后；需要第一条数据就执行平台规则时，业务启动前调用 `refresh_config()` 并确认成功。
- 已经在接收端提交的数据无法撤回；DNS/系统连接阶段不保证即时中止，阻塞 DNS 解析可能超过五秒墙钟时间，连接后发送前仍检查取消。
- HTTPS 目标经 HTTPS 代理需要双层 TLS，当前标准库传输明确拒绝；直接 HTTPS、HTTP 代理 CONNECT 和 HTTP 目标经 TLS 代理已验证。
- 平台集成直连 OTLP 接收器为受控 fixture，Agent 的 SQLite spool 为真实存储。本次未新增真实 ClickHouse 或生产部署验收，也未发布 SDK。
