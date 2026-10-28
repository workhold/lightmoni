# Python SDK

推荐新的五参数 Record/record 业务接口：初始化 service/env，可选版本/实例，SDK 自动聚合发送。完整语义、count总值规则、SQL字段与新样例见 [统一打点](../README.md#通用业务打点go--nodejs--python--rust)。下面原接口继续兼容。

新record按表选择一个上报聚合周期，默认30秒，支持10秒、30秒、1分钟、5分钟、10分钟、30分钟、1小时。中心配置通过refresh_config/后台轮询下发；独立后台线程每10秒检查并发送已结束的固定窗口，不受self_telemetry开关影响。


Python 3.9+，标准库，无运行时第三方依赖。

~~~sh
python3 -m pip install ./sdk/python
python3 examples/sdk/python/main.py
~~~

~~~python
from lightmoni import Client
mon = Client(service="order-api", table="business")
mon.counter("orders_created").add(1, {"region": "cn"})
with mon.start_span("create_order"):
    mon.log("info", "order created", {"order_id": "123"})
mon.shutdown(timeout=5)
~~~

with_table 共享生命周期。Counter.add 接受 int，Gauge / Histogram.record 接受有限数值；boundaries 参数设置桶。span context manager 通过 contextvars 关联日志，异常时设置 error 并结束 span；TraceContext.extract(headers) / context.inject() 处理 W3C header。

构造函数支持 endpoint/key 和 queue_bytes、queue_batches、buffer_bytes、max_batch_bytes、cardinality_limit、max_instruments。flush(timeout=10) 同步且有截止时间，可发送当前record窗口增量；独立后台线程自动发送已结束窗口。update_key 修复凭证，stats 返回快照。asyncio 中显式 flush/shutdown 应放到工作线程。fork 后重新初始化。完整边界见 [SDK 契约](../README.md)。

HTTP/消息入口提取一次 `parent = TraceContext.extract(headers)`，用 `with mon.start_span("request", parent=parent):` 包住处理过程，普通日志自动加 trace；嵌套和异常后恢复外层。`from lightmoni import with_trace` 可用 `with with_trace(context):` 激活已有上下文，contextvars 隔离并发 asyncio task。出站使用 `TraceContext.inject_current()` 返回当前 W3C header，合并到业务 HTTP 请求或消息 metadata；`TraceContext.current()` 可捕获上下文供新线程入口使用。无作用域日志保持 trace 为空。

## 主机归属声明

初始化时读取 `LIGHTMONI_MACHINE_ID`、`LIGHTMONI_MACHINE_NAME`，补充资源属性 `lightmoni.machine.id/name`。在主机管理登记后复制实际 ID 和用户设置的名称；显式 `resource` 对应属性优先。它们只是公开遥测标签，不是认证凭据或控制权限，不替代主机身份核验，也不覆盖 Agent 的 `host.id`、service 或实例身份。

必须将变量注入**业务进程**的启动环境并重启业务；登记主机或安装 Agent 不会自动改变现有进程的环境。SDK 不自动读取配置文件。systemd 可在业务 unit 的 `[Service]` 中配置：

```ini
Environment="LIGHTMONI_MACHINE_ID=平台生成的主机ID"
Environment="LIGHTMONI_MACHINE_NAME=支付主机"
```

Docker Compose 在业务服务下配置 `environment: { LIGHTMONI_MACHINE_ID: "实际主机ID", LIGHTMONI_MACHINE_NAME: "支付主机" }` 后重新创建容器。名称变更也需要更新启动配置并重启。空值、纯空白、控制字符和超长变量会被忽略（ID 最多 64 UTF-8 字节，名称 128 字节）；无变量保持原行为。

## SDK 自监控

默认每 30 秒上报实例心跳和内部诊断，空闲进程也会发送；业务record窗口按表配置独立封窗。中心统一归入 lightmoni_log/lightmoni_metric_*，component=sdk；无密钥不产生自身遥测；WithTable 共享生命周期。可通过 `self_telemetry=False` 关闭自身遥测。退出前仍需 Shutdown；完整语义见 [SDK 契约](../README.md#内部监控)。

## 远程停报与日志采样

默认独立线程每 30 秒从中心或 Agent 的 `/v1/sdk-config` 拉取规则，使用当前 key 认证。平台“SDK 停报规则”和业务日志表的“上报规则”可直接控制 Python SDK，无需重新部署业务代码。关闭自监控或命中停报后，配置拉取仍继续。

```python
from lightmoni import Client

mon = Client("order-api", "business", endpoint="http://127.0.0.1:4318",
             resource={"deployment.environment": "production"})
# 要求首条数据就执行平台规则时，启动业务之前等待刷新成功。
mon.refresh_config(timeout=5)
mon.log("info", "checkout clicked", {"user_id": "qa-1", "event": "click"})
mon.shutdown(timeout=5)
```

- 排除规则优先于 QA/VIP/错误日志；多条保留规则命中取最高比例，未匹配日志不上报，`rules=[]` 忽略全部业务日志。没有表策略时保持全量。错误日志需显式配置保留规则。
- `key="attr:user_id"` 或 `attr:session_id` 稳定选取用户/会话，缺失或空键时按事件选取；长 UID 请用字符串。布尔、数字和字符串分别匹配。
- 日志采样不影响指标、Span 和 SDK 内部自监控。保留日志带 `lightmoni.sampling.rate/weight/rule`；权重只能用于估算，不能还原丢弃日志。
- 整体停报清空所有子表的缓冲和未确认队列，取消等待响应或退避的发送。恢复只接收新数据，旧 Span 不补交。已在网络中提交的数据不可撤回；系统 DNS/连接阶段无法保证即时中止，但连接后发送前会检查取消。

可选参数：`log_sampling={"business": policy}` 设置初始本地策略，`disabled=True` 初始本地停报，`remote_config=False` 关闭配置拉取；`config_endpoint` 指定配置基础地址，`config_key` 指定独立配置凭证，`config_interval` 为秒（默认 30，最小 1）。地址和凭证仅在 `None` 时回退到 endpoint/当前 key，空配置凭证表示不认证。`resource` 支持标量资源属性，`instance_id` 可指定实例身份；不要在 resource 中覆盖 service.name/service.instance.id。

运行时接口：`update_log_sampling(policies)`、`set_reporting_enabled(False/True)`、`refresh_config(timeout=5)`。远程表规则优先于本地规则，本地与远程任一停报开关开启都继续停报。非法/失败配置保留最后有效版本；首次自动拉取前沿用本地规则，未配置则全量。刷新采用最多五秒超时预算，阻塞的系统 DNS 解析可能超出预算。

传输遵循 `http_proxy` / `https_proxy` / `no_proxy`，支持 HTTP 代理及 HTTPS CONNECT；HTTPS 目标经 HTTPS 代理所需的双层 TLS 不受标准库传输支持，会在发送凭证前拒绝。根客户端和子表同时 shutdown 会等待同一轮最终发送，后续调用超时不会取消首个退出过程。

`stats()` 包含 `config_revision`、`config_error`、`reporting_disabled`、`excluded_logs`、`unmatched_logs`、`sampled_out_logs`、`disabled_records`。主动忽略与 `dropped_records` 交付损失分别记录；只有日志策略变化时，已缓冲和冻结重试批次不会重新采样。

```sh
PYTHONPATH=sdk/python python3 -m unittest discover -s sdk/python/tests -v
python3 scripts/test-sdks.py --languages python
```
