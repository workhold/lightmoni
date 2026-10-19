# PHP SDK

64 位 PHP 8.1+、JSON，需启用 HTTP/HTTPS stream wrapper，无第三方依赖。

~~~php
require '/path/to/sdk/php/src/Client.php';
$mon = \LightMoni\Client::fromEnv('order-api', 'business');
$mon->counter('orders_created')->add(1, ['region'=>'cn']);
$mon->withSpan('create_order', function() use ($mon) {
    $mon->log('info', 'order created', ['order_id'=>'123']);
});
$mon->shutdown(5);
~~~

Composer 可配置本地 path repository 指向 sdk/php，再执行 composer require lightmoni/sdk:0.1.0。样例 php examples/sdk/php/main.php。

withTable 共享状态；Counter 接受 int，Gauge / Histogram 接受 int/float；histogram(name,[5,10,50]) 自定义桶。TraceContext::extract / context->inject 处理 W3C header；显式 end span。构造函数第三/四参数为 endpoint/key，第五参数为 snake_case 限制数组。flush / shutdown 的 timeout 为秒，阻塞且有截止时间，适用请求结束或 worker 批量边界，不能跨线程共享。updateKey / stats 支持诊断。完整边界见 [SDK 契约](../README.md)。

## 上报路径

`Client::fromEnv` 默认 direct，服务器、容器与 Serverless 均可使用，不依赖节点助手。两种显式模式只读取自己路径的凭据；失败后沿原路重试。保留 `auto` 兼容旧配置。

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

运行配置隔离测试：`php sdk/php/tests/reporting_test.php`。

`withSpan(name, action, attributes, parent)` 自动激活/结束 span，普通日志自动关联，嵌套/异常后恢复外层。`TraceContext::current()` / `context->run(action)` 捕获和激活已有上下文，主执行流与每个 Fiber 的上下文隔离。新 Fiber 需在入口激活捕获的 context。HTTP/消息入口把 `TraceContext::extract(headers)` 结果作为 parent；出站将 `TraceContext::injectCurrent()` 合并到业务 header / 消息 metadata。

## SDK 自监控

默认随 Flush/Shutdown 上报实例心跳和内部诊断；请求结束请 Flush，长驻 worker 每 30 秒调用一次 Flush。中心自动归入系统 SDK 表，使用原业务 table 的权限；WithTable 共享生命周期。可通过 `['self_telemetry'=>false]` 关闭。退出前仍需 Shutdown；完整语义见 [SDK 契约](../README.md#内部监控)。
