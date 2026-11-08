# 验收记录

日期：2026-11-08（Asia/Shanghai）。基于 GitHub `origin/main` 的 `80cd4e6d163332012587917cd876d13500df4013`，独立分支 `codex/112-dnspod-default-line`；原工作目录的未提交内容未修改。

## 根因与修复

网站控制器为 CNAME 产生内部默认线路 `default`，单目标权重 1 被正确省略后，ensureDnsRecords 不再查询线路能力。这条普通路径未将内部线路翻译为 DNSPod 的名称，导致 CreateRecord 发送 `RecordLine: default`。腾讯云 [新增](https://cloud.tencent.com/document/api/1427/56180) 与 [修改](https://cloud.tencent.com/document/api/1427/56157) 接口要求线路名称，默认线路示例为“默认”；非法线路对应 `InvalidParameter.RecordLineInvalid`。

CloudClient 写入 DNSPod 时统一转换默认线路别名，CreateRecord/ModifyRecord 共用。保留非默认名称和显式 RecordLineId，不恢复已去掉的单目标权重或能力查询。

## 验证证据

- 修复前：`node --import tsx --test --test-name-pattern='DNSPod (serializes|unweighted)' test/platform-website-routing.test.ts`，2 项失败。参数测试显示默认别名未转换；严格 DNSPod 夹具在普通 CNAME 重试时抛出与截图相同的 `InvalidParameter.RecordLineInvalid`。
- 修复后：`node --import tsx --test --test-name-pattern='DNSPod' test/platform-website-routing.test.ts`，3/3 通过。
- 相关完整回归：`node --import tsx --test --test-concurrency=1 test/platform-website-routing.test.ts test/platform-clusters.test.ts test/platform-cloud-certificates.test.ts`，146/146 通过，0 跳过。覆盖阿里云/DNSPod CRUD、64 位 Record ID、单/多目标、默认/细分线路、加权、未知写入隔离、外部修改、延迟索引、快速安装和网站 DNS 协调。
- `npm run typecheck`（runtime）通过；`git diff --check` 通过。

新增参数用例验证 9 种线路/ID 输入的创建和修改请求；SQLite 集成用例验证已确定失败日志恢复、厂商原生 `Line: 默认, LineId: 0` 回读、TTL 修改及重复协调只产生一个成功记录，外部 TTL 修改仍被保护。严格夹具仅允许 DescribeRecordList/CreateRecord/ModifyRecord，确认没有新增线路能力或权重请求。

## 架构与交付边界

架构同步不适用：修正现有供应商协议的参数序列化，未引入新协议、接口、存储或数据/凭据边界，仓库系统设计与 Doca 在线设计文档无需更新。

以上为本地协议夹具及真实 SQLite 验收，未对生产环境执行 DNS 写入、部署或公网传播验证。生产需在包含此修复的中心版本部署后，由现有 DNS 协调重试并以厂商回读确认。

## 联合Docker发行

按用户指定与私有仓库凭据功能一并发行：PR149已合入，成品源码为main合并提交`9d22fd55dc94a47f7469e567eecaf0d30ed129af`（包含PR149、PR150）。固定镜像`docker.heyphp.com/lightmoni/lightmoni:20261108-registry-credentials-v1`，支持Linux amd64/arm64，OCI索引摘要`sha256:bae80e1bb452b955d4528773f3a2672cfe6e9e7b470edce7da625c7c7242a5d3`。两架构各57项成品检查通过；成品编译模块的凭据与DNSPod路由联合回归各32/32通过、0跳过。发布清单、摘要回读与latest保留证据见[SDD111验收记录](../111-registry-pull-credentials/validation.md)。未进行生产中心部署或真实DNS写入。
