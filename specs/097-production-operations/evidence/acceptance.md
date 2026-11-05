# SDD097 阶段验收

## 已实现

维护判定允许经私有载荷证明、从未领取的 node/workload/gateway.inspect 等待维护，用户脚本、写操作、已领取/有尝试/有lease/未知执行仍阻塞。准备阶段用 SQLite 随机token预约覆盖 SSH 只读检查，随后由原有待审批维护状态接管；完成或失败释放自己的准备记录。主机按钮能力与更新/卸载后端复用同一判定。

Agent 使用当前认证心跳返回的注册机器名，为新批次补 host.name 和 lightmoni.machine_id。中心受管观测以可信归属补机器名和服务名并写入资源信息；原内部ID保留。同ID/同 input_hash 已接受批次依据持久回执重复确认，机器改名后不重写已冻结字节；不同内容仍拒绝。

## 检查

- runtime typecheck/build：通过。
- web typecheck：通过。
- machine-maintenance、agent、application-observability、machine-agent-updates、managed-machines、managed-executor-jobs、agent-job-fence、reconciliation：209 项全部通过，0失败、0跳过。
- default-telemetry、telemetry-agent-credentials、ingest-delivery：9 项全部通过。
- git diff --check：通过。

详细本地日志 /tmp/lightmoni-097-verified-tests.log 和 /tmp/lightmoni-097-telemetry-tests.log 未提交仓库。测试含持久队列、实际临时文件/本地HTTP和合成SSH/执行器；不作为生产机器验收通过的证明。

## 架构同步

架构影响：是，新增短期持久维护规划预约和共享控制门禁，补齐上报名称契约及原批次回执语义。仓库 docs/system-design.md 第97节与 [Doca 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 原生 SDD097 章节/流程图已同步。

最新 seq1746 回读：原922块内容、顺序与所有原生图保持一致；新标题和6段正文核对，10节点/8连线匹配，文档标题仍为“LightMoni 系统设计基线”。证据 doca-sync.json。修正了工具将数字前缀自动转为列表引起的临时定位，最终全量比较通过，无关内容未改写。

## 发布与生产

前阶段配置对账已通过 PR102/103 合入main，固定镜像20261105-reconciliation-c332d2a和GitHub测试版已发布，1Panel中心healthy，实际镜像revision与摘要匹配、/data保留。1Panel旧容器标签不等同实际镜像标签，已分别核对。

本阶段修复尚需 PR 合入、重新打包发行和更新中心/Agent。线上全流程验收继续，只操作zz-bj-1；应用生命周期、Agent卸载重装、连续遥测、告警/大盘未在本阶段标记通过。GitHub独立80MB Agent附件遇到HTTP408和上传超时，完整包已经包含于Docker及中心下载服务；发布说明已如实注明。
