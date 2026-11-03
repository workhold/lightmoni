# 验证

- Runtime TypeScript与git diff --check通过。13个相关测试文件368/368通过、无跳过，包括新共享谓词拒绝用例、真实签名作业人工核对后领取新作业、普通控制面不可领取/读取受管作业，以及主机运行模式、更新、安装、卸载、维护、节点身份与恢复守卫回归。
- 原未知agent_jobs/privileged_jobs状态及回执保持不变；普通未知、外部Agent/追踪ID、不同能力、缺少核对时间/操作者/原因和活动任务继续互斥。特权排队作业仍串行，普通排队作业仍阻塞。
- 架构同步完成：docs/system-design.md第86章“受管未知作业的人工核对与主机互斥（SDD089）”；Doca同名原生段落managed089-0/1/2保存seq948并按最新seq回读逐字一致。总览原生图10节点/8边，节点ID/标签与写前outline一致，连线端点有效；写命令不针对图块。证据见evidence/doca-readback.json。
- 固定源码双架构成品检查、PR发布、中心升级与新观测/DNS/HTTPS恢复均完成；最终验收见SDD090/evidence。原未知记录保留，后续签名检查成功。

## 最终线上回读

中心已升级到固定镜像20261103-1bfd49c，健康；切换前无活动或未核对root作业，仅更新中心镜像，16个其他容器与业务计数保持。正常系统DNS解析abc与registry-demo到49.232.14.169，不使用固定IP覆盖；Demo可信HTTPS 200，Registry匿名401/认证200，不可变镜像清单SHA256一致。最终再次确认新签名inspect/apply成功，未核对未知作业为0，原unknown/executor_http_502审计与人工核对时间保留。备份SQLite integrity_check为ok，目录0700、文件0600。完整安全报告见../090-ui-delivery-isolation/evidence。

## 双架构成品

linux/arm64与linux/amd64各43项成品检查通过；两个架构均在镜像内运行真实编译后签名作业与互斥回归10/10，均无失败或跳过，并各通过私网HTTP/TCP健康探测。AMD64为本机Docker仿真。37个本地OCI blob及实测rootfs/config核对一致。固定源码`1bfd49c3479b172181c6526e8ac6b46c08e67749`，镜像`docker.heyphp.com/lightmoni/lightmoni:20261103-1bfd49c`，索引`sha256:0991b9bb0cf29369406971d844435563f9f7b44c10cb531b9edbea7b5b533eb2`。后续提交仅文档和发布元数据，远端发布与线上恢复以[PR #85](https://github.com/workhold/lightmoni/pull/85)发布验证节为准。
