单一公网端点恢复回归

真实Socket丢ACK后，TypeScript选择器在清单版本未变化的认证发现成功后仍抛出no verified center endpoint is reachable；新增回归在修改前4通过/1失败，失败位置是refresh选择入口。修复后发现仅发GET、不重放POST，调用方仍使用原冻结批次重试。

TypeScript、Go、Python、Rust共享相同修复：只在完整认证清单成功后解除已验证source的过去传输冷却。TypeScript最终完整套件25通过，Python35通过，Go完整包通过，Rust通过锁文件/官方rust:1.85镜像执行5通过；runtime类型与构建通过。既有身份不符、内外网切换、改端口及截止时间回归保留。

生产中心cef08e6已于2026/11/6 03:56:14通过1Panel替换容器并健康确认；双架构47项检查各通过，所有25条内置大盘查询均经正式HTTP查询路径和隔离ClickHouse执行。GitHub固定测试发行：https://github.com/workhold/lightmoni/releases/tag/20261106-monitoring-cef08e6 。公网镜像index sha256:ac244df402529444af2e919fdeffb091ecf7661cb9f3f5b7d0275218d88034ca；stable latest保持未变。该镜像尚不包含本次端点恢复修改，需后续固定成品发布。

线上告警验收规则仅查询zz-bj-1，2026/11/6 03:25:39触发（418），03:30:41正常恢复（0）。无告警组和可用通知目标，发送记录为空；已停用验收规则并保留事件。

旧Agent卸载未完成：新版SSH卸载探测拒绝旧managed布局。使用已核验SHA的原版卸载器前在机器root私有目录保留回滚档案；原版卸载器发现未决操作后拒绝移除，旧程序/配置/身份保留，已恢复Agent active。未清除任何围栏。

未知任务555594917880394bbf4af5790a42acfd为OpenResty gateway.inspect。只读SSH核对原worker单元inactive/dead、MainPID0，两处operation锁不存在；3个业务容器持续运行。2026/11/6 05:11:46通过产品页面记录人工核对，保留unknown结果，未改成成功或直接改库。后续卸载重装和三轮持续上报仍待实际回执。
