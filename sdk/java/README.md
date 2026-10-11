# Java / Kotlin JVM SDK

JDK 17+，Gson 2.11.0。下载源码后安装到本地 Maven 仓库：

~~~sh
mvn -f sdk/java/pom.xml install
~~~

业务依赖 io.lightmoni:lightmoni-sdk:0.1.0；Gradle 使用 mavenLocal() 和 implementation("io.lightmoni:lightmoni-sdk:0.1.0")。

~~~java
import io.lightmoni.Client;
import java.time.Duration;
import java.util.Map;
var mon = new Client("order-api", "business");
mon.counter("orders_created").add(1, Map.of("region", "cn"));
try (var span = mon.startSpan("create_order")) {
    mon.log("info", "order created", Map.of("order_id", "123"), span.context);
}
mon.shutdown(Duration.ofSeconds(5));
~~~

Kotlin/JVM 直接使用同一 API：

~~~kotlin
val mon = io.lightmoni.Client("order-api", "business")
mon.counter("orders_created").add(1L, mapOf("region" to "cn"))
mon.startSpan("create_order").use { span ->
    mon.log("info", "order created", emptyMap<String, Any>(), span.context)
}
mon.shutdown(java.time.Duration.ofSeconds(5))
~~~

withTable 共享生命周期；Counter 接受 long，Gauge / Histogram 接受 double，histogram(name,List<Double>) 自定义桶。metric 可设置单位。Client.TraceContext.extract / context.inject 支持 W3C header，异步请求显式传 context。四参数构造函数配置 endpoint/key，五参数增加 Client.Limits。flush(Duration) 同步，应用自行调度；updateKey 和 stats 支持诊断。不包括 Android/Kotlin Multiplatform。样例 examples/sdk/java/Main.java；完整边界见 [SDK 契约](../README.md)。
