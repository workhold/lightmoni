# 多语言 SDK 验收

> 历史验收记录（2026-10-11）。Java/Kotlin JVM、C#/.NET 与 PHP SDK 已下线；Go/Rust 仅保留源码、后续支持，未纳本次发布验收。以下原始结果仅用于追溯，当前发布 TypeScript/JavaScript、Python、Ruby，支持矩阵以 [SDK 总览](../../../sdk/README.md) 为准。

本目录的截图、参考图和录屏仅保存在本机 [`artifacts/screenshots/docs/evidence/multilang-sdk/`](../../../artifacts/screenshots/docs/evidence/multilang-sdk/)，由 Git 忽略；下文未带路径的图片和录像文件名均相对此目录。文字报告继续保留在仓库中。

2026-10-11 历史范围：Go、JavaScript/TypeScript/浏览器、Python、Java/Kotlin JVM、C#/.NET、PHP、Ruby、Rust。Java 库供 Kotlin/JVM 复用，不包含 Android/Multiplatform；没有 C/C++、Swift、Dart/Flutter 专用包或自动框架埋点。

| 验收 | 结果 |
| --- | --- |
| 六个新 SDK 的共享 HTTP 夹具 | 60 项通过：完整维度、类型区分、调用方修改、Int64 精度、连续 Delta、Gauge 不补零、Histogram 边界、traceparent、跨 table、overflow；503、429/Retry-After、401/Key 修复、损坏 ACK、连接断开丢 ACK、永久拒绝、partialSuccess、容量损失 |
| 真实 Agent HTTP → SQLite → 关闭重开 | 六种语言、18 个批次；每语言 Counter=20、日志=20、span=20，trace/span ID 关联一致；Go race 通过 |
| 历史八种 SDK → Agent → 主服务 → 隔离 ClickHouse 26.8 | 每语言 Counter=20、关联日志/span=20、Histogram count=20、Gauge=3，全部使用同一 table-scoped Key；结果 [e2e-report.json](e2e-report.json) |
| 历史数据接入页 | 八种语言选择、安装命令和业务样例对应正确，八个真实安装包均能下载，1280/750/390 宽度无页面横向溢出；[ui-report.json](ui-report.json) |
| 历史发布 | npm 包、七个源码包、八个 SHA256 校验；Python pip 安装和 .NET NuGet pack 成功；Java 编译和实际运行成功；Rust 1.85 使用 Cargo.lock 构建成功 |
| 回归 | Go 全仓 race、TypeScript SDK 5 项测试、前端 typecheck 与生产 build 通过 |

运行：

~~~sh
python3 scripts/test-sdks.py --docker
LIGHTMONI_NATIVE_SDK_TEST=1 go test -race ./sdk/go -run TestNativeSDKsDurablyAcceptedByActualAgent -count=1
sh scripts/build-sdk-release.sh 0.1.0 internal/server/agent-dist
~~~

完整 ClickHouse 测试使用独立容器、测试服务和独立 SQLite 数据目录。主服务测试端口 19380、ClickHouse 19223；先构建 .lightmoni/sdk-test/lightmoni-agent，再运行 scripts/sdk-smoke.py。测试程序生成 table-scoped Key、带 local_token 的临时 Agent，结束时关闭 Agent，不输出明文 Key。它会在指定测试实例创建测试管理员及 Key，不应指向正式实例。

这里验证的是手工埋点与 LightMoni 原生 OTLP 封装。新 SDK 使用显式 flush，应用负责定时调度；没有磁盘队列。没有把普通 exporter 的至少一次路径、自动框架埋点、性能基准或移动端专用支持算作已验收。Kotlin 复用已编译运行的 JVM 库，Kotlin 示例未单独编译。Ruby 夹具运行于本机 2.6.10，声明支持 2.7+；Java/.NET/PHP/Rust 在隔离容器执行。

截图：[桌面](../../../artifacts/screenshots/docs/evidence/multilang-sdk/sdk-desktop.png)、[750](../../../artifacts/screenshots/docs/evidence/multilang-sdk/sdk-750.png)、[390](../../../artifacts/screenshots/docs/evidence/multilang-sdk/sdk-390.png)。移动截图在收起已有导航后拍摄。
