# Research

## 规则兼容
**Decision**: 复用 sdk/go/sampling.go 与 sdk/typescript/src/sampling.ts 的规则内 AND、规则间最大比例、排除优先和 FNV-1a 32 位 + avalanche 算法。
**Rationale**: 同一 UID/表/键得到同一保留决定。数字 token 用十进制无指数形式，bool/string/number 分开；不借用 Python bool==1 或进程随机 hash。
**Alternatives**: random 每事件或 Python hash 会破坏稳定用户组；客户端另造规则协议会增加维护成本。

## 快照与首次配置
**Decision**: 默认 30 秒独立轮询，显式 refresh_config(timeout=5) 可用于业务启动前；失败保留旧快照。JSON 拒绝未知字段、重复键、NaN/Infinity、超限结构。
**Rationale**: 与已有 SDK 首次本地回退一致，不让规则执行依赖自监控；深复制避免调用方修改策略。
**Alternatives**: 首次同步联网阻塞构造函数或失败清空旧配置会影响业务与数据选择。

## 停报与传输
**Decision**: 标准库 http.client 实现共享可取消请求句柄，停报触发事件与活动 socket shutdown/close；flush 捕获 generation，每次提交与回包都检查 generation 和队列身份。连接过程结束后先检查取消，再发送。
**Rationale**: urllib 无法取消未返回的响应；只清 queue 会导致旧回包删除新批次。退避使用 Event.wait，DNS/connect 仍受运行时/系统解析行为约束，文档不承诺已发送数据可撤回。
**Alternatives**: 添加 requests/httpx 违反零依赖目标；只设置布尔开关无法防止恢复后旧回包与旧 Span 污染。

审阅补充：保留 urllib 的环境代理与 no_proxy 行为；HTTP 使用 absolute-form，HTTPS 通过 HTTP 代理 CONNECT，HTTP 目标支持 TLS 代理。stdlib 不支持 TLS-in-TLS 时明确拒绝，避免将 HTTPS 代理凭证降级为明文。根/子客户端的并发 shutdown 共用一个完成事件，后续调用不能取消首个最终 flush。

## 根生命周期与资源
**Decision**: with_table 共享锁、轮询和开关；增加 resource 和 instance_id 参数用于平台已有资源/实例选择器。资源禁止覆盖 service.name/service.instance.id。
**Rationale**: 资源规则需要公开输入，默认实例身份保持随机；新增参数兼容既有位置参数。

## 验证边界
**Decision**: 验证真实 HTTP 请求内容、时间界限、取消和冻结重试；Go 测试启动隔离中心 SQLite 和 Agent，Python 从真实平台 API 获取配置并提交。
**Rationale**: 仅断言 helper 返回值不能证明远程平台规则执行。隔离中心接收端可使用受控存储边界，不把该项声明为新 ClickHouse 端到端证明。
