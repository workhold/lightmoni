# Python SDK

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

构造函数支持 endpoint/key 和 queue_bytes、queue_batches、buffer_bytes、max_batch_bytes、cardinality_limit、max_instruments。flush(timeout=10) 同步且有截止时间，应用自行调度；update_key 修复凭证，stats 返回快照。fork 后重新初始化。完整边界见 [SDK 契约](../README.md)。

## SDK 自监控

默认每 30 秒上报实例心跳和内部诊断，空闲进程也会发送；原生运行时的后台线程同时 Flush 当前业务窗口。中心自动归入系统 SDK 表，使用原业务 table 的权限；WithTable 共享生命周期。可通过 `self_telemetry=False` 关闭。退出前仍需 Shutdown；完整语义见 [SDK 契约](../README.md#内部监控)。
