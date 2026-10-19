# SDK 连接模式验证 Quickstart

本文是规格验收入口；本次发布的 TypeScript/JavaScript、Python、Ruby 已提供三种 mode 的基线构造和路由选择，完整跨语言故障矩阵仍需按 validation 记录执行。

## 1. 直连中心

生产环境优先用 Secret 文件；以下仅展示变量名称和行为，真实 key 不应提交到 shell history。

~~~sh
export LIGHTMONI_MODE=direct
export LIGHTMONI_ENDPOINT=https://monitor.example.com
export LIGHTMONI_DATA_KEY_FILE=/run/secrets/lightmoni-data-key
~~~

预期：SDK 使用 data key 发送 /v1/metrics、/v1/logs、/v1/traces；table 越权返回 403 并可在 stats 查看；不会请求 Agent 或管理员 API。

## 2. 本机 Agent

~~~sh
export LIGHTMONI_MODE=agent
export LIGHTMONI_AGENT_ENDPOINT=http://127.0.0.1:4318
export LIGHTMONI_LOCAL_TOKEN_FILE=/run/secrets/lightmoni-local-token
~~~

预期：SDK 只连接 Agent；中心地址和 data key 即使存在也不会被使用。Agent 未运行、token 错误或持久化背压时，SDK 保留有限批次并报告错误，不改投中心。

## 3. 自动选择

~~~sh
export LIGHTMONI_MODE=auto
export LIGHTMONI_AGENT_ENDPOINT=http://127.0.0.1:4318
export LIGHTMONI_ENDPOINT=https://monitor.example.com
export LIGHTMONI_DATA_KEY_FILE=/run/secrets/lightmoni-data-key
~~~

预期：

1. 首先只探测显式 Agent endpoint，未配置时只探测 127.0.0.1:4318。
2. Agent 健康则锁定 Agent route。
3. 在未建立 Agent 连接且未发送业务 body 的情况下探测失败，才选择 direct。
4. Agent 认证/TLS/协议错误、已发送 body 后的未知响应和中心凭据缺失不会触发静默回退。

## 4. 自定义打点最小检查

每种当前发布语言的示例都应创建一个 root client 和两个 table 子 client，并记录：

- 一个 Counter、Gauge、Histogram；
- 一条结构化日志和带属性的 Span；
- 一个 W3C traceparent 注入/提取；
- flush/shutdown 和 stats；
- Agent 与 direct route 下相同的 table、resource、trace 和 batch headers。

记录调用不应同步发网络请求；route 探测只能在初始化或显式 route refresh。

## 5. 推荐验证命令

实现后从仓库根目录运行对应命令：

~~~sh
npm --prefix sdk/typescript test
PYTHONPATH=sdk/python python3 -m unittest discover -s sdk/python/tests -v
ruby -I sdk/ruby/lib sdk/ruby/test/reporting_test.rb
~~~

命令需按仓库实际测试脚本调整；验证证据必须额外包含本地 Agent、隔离中心、故障注入和凭据泄露扫描，不能只用单元测试替代真实 HTTP。

PHP 原生 SDK 已下线。Go/Rust 仅保留源码、不提供本次发布包与接入页安装选项；原生工具链和完整连接模式验收列为后续任务，不纳本次发布验收。
