# PHP SDK

64 位 PHP 8.1+、JSON，需启用 HTTP/HTTPS stream wrapper，无第三方依赖。

~~~php
require '/path/to/sdk/php/src/Client.php';
$mon = new \LightMoni\Client('order-api', 'business');
$mon->counter('orders_created')->add(1, ['region'=>'cn']);
$span = $mon->startSpan('create_order');
$mon->log('info', 'order created', ['order_id'=>'123'], $span->context);
$span->end();
$mon->shutdown(5);
~~~

Composer 可配置本地 path repository 指向 sdk/php，再执行 composer require lightmoni/sdk:0.1.0。样例 php examples/sdk/php/main.php。

withTable 共享状态；Counter 接受 int，Gauge / Histogram 接受 int/float；histogram(name,[5,10,50]) 自定义桶。TraceContext::extract / context->inject 处理 W3C header；显式 end span。构造函数第三/四参数为 endpoint/key，第五参数为 snake_case 限制数组。flush / shutdown 的 timeout 为秒，阻塞且有截止时间，适用请求结束或 worker 批量边界，不能跨线程共享。updateKey / stats 支持诊断。完整边界见 [SDK 契约](../README.md)。

## SDK 自监控

默认随 Flush/Shutdown 上报实例心跳和内部诊断；请求结束请 Flush，长驻 worker 每 30 秒调用一次 Flush。中心自动归入系统 SDK 表，使用原业务 table 的权限；WithTable 共享生命周期。可通过 `['self_telemetry'=>false]` 关闭。退出前仍需 Shutdown；完整语义见 [SDK 契约](../README.md#内部监控)。
