# Ruby SDK

Ruby 2.7+，标准库，生成本地 gem：

~~~sh
cd sdk/ruby
gem build lightmoni.gemspec
gem install ./lightmoni-sdk-0.1.0.gem
~~~

~~~ruby
require 'lightmoni'
mon = LightMoni::Client.new(service: 'order-api', table: 'business')
mon.counter('orders_created').add(1, 'region' => 'cn')
mon.with_span('create_order') do
  mon.log('info', 'order created', 'order_id' => '123')
end
mon.shutdown(timeout: 5)
~~~

with_table 共享生命周期；Counter 接受 Int64 范围的 Integer，Gauge / Histogram 接受有限数值；boundaries 自定义桶。TraceContext.extract / context.inject 处理 W3C header；span/log 支持可选 context。初始化支持 endpoint/key/容量限制。flush 同步且有截止时间，应用自行调度；update_key / stats 支持诊断。fork 后重新创建客户端。样例 ruby examples/sdk/ruby/main.rb；完整边界见 [SDK 契约](../README.md)。

`with_span(name, attributes, parent: ...)` 自动激活/结束 span，普通日志自动关联，嵌套/异常后恢复外层。`LightMoni.current_trace` / `LightMoni.with_trace(context) { ... }` 可捕获和激活已有上下文；Fiber 局部存储隔离并发，新 Fiber/线程需在入口显式激活捕获的 context。HTTP/消息入口用提取的 W3C 上下文作为 parent，出站把 `LightMoni.trace_headers` 合并到业务 header / 消息 metadata。

## SDK 自监控

默认每 30 秒上报实例心跳和内部诊断，空闲进程也会发送；原生运行时的后台线程同时 Flush 当前业务窗口。中心自动归入系统 SDK 表，使用原业务 table 的权限；WithTable 共享生命周期。可通过 `self_telemetry: false` 关闭。退出前仍需 Shutdown；完整语义见 [SDK 契约](../README.md#内部监控)。
