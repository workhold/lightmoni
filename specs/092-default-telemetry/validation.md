# 验收记录

## 现场诊断（2026-11-04）

主机指标仍持续写入metric_host_*，近10分钟分别1700条gauge、2352条sum。共享应用日志为0，应用指标未建表；root采集队列中有自11月3日起的日志与指标各1批。使用现有受保护凭据和已固定SSH主机身份，对实际采集器进行探针调用，中心返回observations/batches 403 website_observation_ownership_required。队首为已删除网站的旧入口访问日志，现有网站ID均不同。未删除队列、改写游标或更改生产状态来绕过错误。

SDK只有SDD091一次性验收日志，ABC示例代码此前只向stdout写日志。应用监控仅查容器共享表，没有业务SDK表入口；网站页面缺少独立监控入口。此事实纠正上轮只以单条SDK入库证明整体采集的不足。

## 代码与本地验证

- 28条既有/新增观测与签名执行回归通过，新增日志容量隔离后6条专项回归通过。
- TypeScript runtime/web检查通过，生产Web构建通过；ABC真实SDK请求指标和日志2项测试通过，确认不包含请求头或查询串秘密。
- 独立ClickHouse + HTTP Auth/Ingest +真实SDK +正式Query链路通过：gauge/sum/histogram均入库并可查询，三个周期日志可见，其他应用及错误实例的数据排除。站点范围查询使用明确标注的测试访问记录，不冒充线上真实OpenResty采集。见evidence/integration.json。
- 全量runtime首次1361项：1326通过、33跳过，两项因新工作树缺少AI构建产物失败；补齐AI产物后在runtime工作目录重跑两个完整测试文件26项全部通过。未将初次失败隐去。后续仅增加中心状态诊断测试断言，相关10项全部通过。
- ARM64/AMD64镜像各44项成品检查通过；各自镜像内编译后的新增6项遥测回归通过。注册表按固定候选标签发布，并按不可变摘要拉回，rootfs/config与测试镜像逐项相同，latest保持原值。
- ABC实际AMD64非root镜像经过真实HTTP→SDK→中心→ClickHouse→查询，在三轮18秒间隔连续出现新请求测量、process.uptime及heartbeat日志，见abc-image-smoke.json。
- 本地真实浏览器验证应用SDK指标与日志，以及网站监控页面；本地网站访问行仅为查询测试夹具。线上回读尚待完成。

## 架构同步

适用：签名采集状态与应用/网站遥测读取路径扩展。仓库第92章与[Doca系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)完成保存及最新回读；新图9节点9连线与预期相同，原图10节点8连线完整数据未变，原文档标题保留。见evidence/doca-readback.json（seq1717）。

## 待现场补齐

首次852a316候选已在生产备份后切换，中心健康，其他16个容器和业务清单不变，原私有ABC镜像摘要保留。实际页面暴露observation_export_failed，不能视为采集恢复。只读核对中心147条待写入记录：归属绑定通过，ClickHouse INSERT异常27；source_seq旧包装类型和20条窗口阻塞需修复重发。未删除中心/Agent队列、重置游标或把未知执行改为成功。新增精确序号、旧包装恢复和21条失败批次后的正常批次回归。

修正版afd06a6：12项签名观测/精确序号/旧包装/窗口轮转回归全部通过；ARM64和AMD64各44项成品验收通过，包含真实ClickHouse对9007199254740993日志序号的精确入库。固定标签20261104-afd06a6已发布，两平台按不可变摘要拉回后的rootfs/config与测试镜像一致，latest保持原值。见evidence/final-candidate。仓库默认Compose同步固定标签；未合并PR，不更新主干。

生产ABC v3的实际apply已完成（曾遇到自动inspect占用，仅inspect成功并未切换镜像，随后正常停止/启动完成）。浏览器已读到连续三分钟process.uptime及持续heartbeat/http_request SDK日志，身份属于同一应用部署。中心修正版的备份、拉取、切换命令已派发；Mac再次锁屏，最终中心回执、积压恢复、容器/站点三轮采样及截图待解锁回读。健康接口返回ok不等价于本轮采集验收通过。

生产镜像、既有积压恢复、各应用容器实时采样、四网站真实请求与访问日志、ABC持续SDK信号，以及用户页面截图均以本节后续实际回执为准；当前不声称已上线。


## 继续任务的生产回读（2026-11-04 22:27–22:32，中国标准时间）

上次1Panel终端保留的实际切换回执证实20261104-afd06a6已拉取、切换和健康检查通过，16个其他容器未重建。但本轮只读docker inspect显示生产当前已是20261104-host-ui-790cca58456a（主机UI发行），不是该遥测修正版；实际executor-observation模块也没有restoreObservationRows导出。不能沿用上次切换成功回执声称当前版本仍包含修复。

三轮35秒采样：四个HTTPS地址均为预期200/401，SDK每轮都有http.server.requests、http.server.duration、process.uptime及heartbeat/http_request日志；容器指标与网站访问日志每轮仍为0，中心固定4批旧积压（3批日志序号仍为对象、1批指标），ClickHouse记录异常27。真实executor心跳仍在线。没有删除批次、重置游标或把未知执行改为成功。详见evidence/production-followup-20261104.json。

后续需协调并行发行：保留主机UI改动，将本PR遥测修复纳入同一固定版本后，再补容器/网站/积压恢复验收。容器、网站的T007/T008继续保持未完成；阻塞已从Mac锁屏变为生产发行基线不一致。新增应用升级及容器SSH入口在独立SDD094-app-upgrades-terminal中实施。
