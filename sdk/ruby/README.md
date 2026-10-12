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
span = mon.start_span('create_order')
mon.log('info', 'order created', {}, context: span.context)
span.finish
mon.shutdown(timeout: 5)
~~~

with_table 共享生命周期；Counter 接受 Int64 范围的 Integer，Gauge / Histogram 接受有限数值；boundaries 自定义桶。TraceContext.extract / context.inject 处理 W3C header；span/log 显式传 context。初始化支持 endpoint/key/容量限制。flush 同步且有截止时间，应用自行调度；update_key / stats 支持诊断。fork 后重新创建客户端。样例 ruby examples/sdk/ruby/main.rb；完整边界见 [SDK 契约](../README.md)。

## SDK 自监控

默认每 30 秒上报实例心跳和内部诊断，空闲进程也会发送；原生运行时的后台线程同时 Flush 当前业务窗口。中心自动归入系统 SDK 表，使用原业务 table 的权限；WithTable 共享生命周期。可通过 `self_telemetry: false` 关闭。退出前仍需 Shutdown；完整语义见 [SDK 契约](../README.md#内部监控)。
