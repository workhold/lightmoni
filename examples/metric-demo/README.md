# 指标窗口 Demo

此示例通过两个 SDK 实例持续记录数据库耗时、请求次数和已有消费汇总，演示窗口聚合、P95/P995、按实例统计及本地告警回调。请使用测试实例；`setup` 会创建或更新 SDK Key、大盘、通知通道、告警组和告警规则。

在仓库根目录先构建 SDK：

```sh
npm --prefix sdk/typescript ci
npm --prefix sdk/typescript run build
```

通过受保护的运行环境提供 `LIGHTMONI_ADMIN_NAME` 和 `LIGHTMONI_ADMIN_PASSWORD`，并显式设置要连接的中心，然后运行：

```sh
export LIGHTMONI_ENDPOINT=http://localhost:8080
npm --prefix examples/metric-demo run setup
npm --prefix examples/metric-demo start
```

`setup.mjs` 的默认中心地址为 `http://localhost:18380`；部署端口不同时应覆盖 `LIGHTMONI_ENDPOINT`。示例默认监听 `127.0.0.1:18481`，可通过 `LIGHTMONI_DEMO_HOST`、`LIGHTMONI_DEMO_PORT` 调整。接口如下：

```sh
curl http://localhost:18481/status
curl -X POST http://localhost:18481/mode -H 'Content-Type: application/json' -d '{"mode":"slow"}'
curl -X POST http://localhost:18481/mode -H 'Content-Type: application/json' -d '{"mode":"normal"}'
```

`GET /healthz` 返回状态，`POST /hook` 接收通知回调。`LIGHTMONI_DEMO_WEBHOOK_URL` 默认是 `http://host.docker.internal:18481/hook`，需要按中心实际可访问的地址设置；调整监听地址不会自动修改回调 URL。上述端口为此示例自身端口，与中心的 `LIGHTMONI_PORT` 分开配置。

`LIGHTMONI_DEMO_TABLE` 默认 `metric_demo`。资源 ID、中心地址和 SDK Key 保存到 `.local-dev/metric-demo/state.json`，文件权限为 0600，不输出 Key；回调记录保存到同目录的 `state.json.receipts.json`。可通过 `LIGHTMONI_DEMO_STATE` 指定另一受保护的状态路径。连接不同中心或使用不同表时选择不同状态文件，避免复用资源 ID。

按 `Ctrl+C` 或发送 SIGTERM 停止，脚本会尝试 flush SDK。停止示例不会删除已创建的中心资源，测试完成后在中心管理界面清理示例 Key、大盘、通道、告警组和规则。

```sh
npm --prefix examples/metric-demo run verify
```

`verify` 仅做三个脚本的 Node 语法检查，不连接中心，不代表已完成真实上报或告警验收。
