# 实现设计

1. 在 CloudClient 的 DNSPod 写入边界统一转换默认线路别名，覆盖 CreateRecord/ModifyRecord。保留显式线路 ID、非默认名称与阿里云分支。
2. 用严格协议夹具拒绝英文 `default`，返回截图中的真实错误码；先在未修复代码上复现，再修复并验收。
3. 通过真实 SQLite 的 ensureDnsRecords 验证无权重默认 CNAME 的新增、厂商回读、TTL 更新、重复协调幂等和已确定失败日志恢复。夹具不支持能力查询，从而约束普通路径不会增加该依赖。
4. 运行 DNS/网站/集群相关回归及 runtime 类型检查，记录结果和真实环境未验证的边界。

参考：[DNSPod CreateRecord](https://cloud.tencent.com/document/api/1427/56180)、[DNSPod ModifyRecord](https://cloud.tencent.com/document/api/1427/56157)。RecordLine 为线路名称；RecordLineId 同时提供时优先。
