# Ruby SDK

Ruby 2.7+，标准库，生成本地 gem：

~~~sh
cd sdk/ruby
gem build lightmoni.gemspec
gem install ./lightmoni-sdk-0.1.0.gem
~~~

~~~ruby
require 'lightmoni'
mon = LightMoni.from_env(service: 'order-api', table: 'business')
mon.counter('orders_created').add(1, 'region' => 'cn')
mon.with_span('create_order') do
  mon.log('info', 'order created', 'order_id' => '123')
end
mon.shutdown(timeout: 5)
~~~

with_table 共享生命周期；Counter 接受 Int64 范围的 Integer，Gauge / Histogram 接受有限数值；boundaries 自定义桶。TraceContext.extract / context.inject 处理 W3C header；span/log 支持可选 context。初始化支持 endpoint/key/容量限制。flush 同步且有截止时间，应用自行调度；update_key / stats 支持诊断。fork 后重新创建客户端。样例 ruby examples/sdk/ruby/main.rb；完整边界见 [SDK 契约](../README.md)。

## 上报路径

`LightMoni.from_env` 默认 direct，服务器、容器与 Serverless 均可使用，不依赖节点助手。两种显式模式只读取自己路径的凭据；失败后沿原路重试。保留 `auto` 兼容旧配置。

直连平台：

~~~sh
unset LIGHTMONI_AGENT_ENDPOINT LIGHTMONI_LOCAL_TOKEN LIGHTMONI_LOCAL_TOKEN_FILE LIGHTMONI_DATA_KEY_FILE LIGHTMONI_KEY
export LIGHTMONI_MODE=direct
export LIGHTMONI_ENDPOINT='https://lightmoni.example.com'
export LIGHTMONI_DATA_KEY='<业务 data key>'
~~~

通过 LightMoni Agent：

~~~sh
unset LIGHTMONI_ENDPOINT LIGHTMONI_DATA_KEY LIGHTMONI_DATA_KEY_FILE LIGHTMONI_KEY LIGHTMONI_LOCAL_TOKEN LIGHTMONI_LOCAL_TOKEN_FILE
export LIGHTMONI_MODE=agent
export LIGHTMONI_AGENT_ENDPOINT='http://127.0.0.1:4318'
# 仅在 Agent 启用本地鉴权时注入 LIGHTMONI_LOCAL_TOKEN 或 LIGHTMONI_LOCAL_TOKEN_FILE。
~~~

容器中的 `127.0.0.1` 指向当前容器，地址应填写业务实际可达的 Agent。Agent 成功确认代表本地持久队列接收，最终上传受队列容量和重放期限限制；direct 使用进程内有限缓冲。节点采集和诊断职责独立于 SDK 路由。所选凭据仍校验来源冲突和 Secret 文件；未选路径的凭据和文件不读取。

运行配置隔离和本地 HTTP 路由测试：`ruby sdk/ruby/test/reporting_test.rb`。

`with_span(name, attributes, parent: ...)` 自动激活/结束 span，普通日志自动关联，嵌套/异常后恢复外层。`LightMoni.current_trace` / `LightMoni.with_trace(context) { ... }` 可捕获和激活已有上下文；Fiber 局部存储隔离并发，新 Fiber/线程需在入口显式激活捕获的 context。HTTP/消息入口用提取的 W3C 上下文作为 parent，出站把 `LightMoni.trace_headers` 合并到业务 header / 消息 metadata。

## SDK 自监控

默认每 30 秒上报实例心跳和内部诊断，空闲进程也会发送；原生运行时的后台线程同时 Flush 当前业务窗口。中心自动归入系统 SDK 表，使用原业务 table 的权限；WithTable 共享生命周期。可通过 `self_telemetry: false` 关闭。退出前仍需 Shutdown；完整语义见 [SDK 契约](../README.md#内部监控)。
