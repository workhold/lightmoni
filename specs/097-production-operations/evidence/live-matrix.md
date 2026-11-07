# 线上验收矩阵

机器写操作仅限 zz-bj-1；vchive 未执行写操作。中心通过既有 1Panel 更新，原 `lightmoni_lightmoni-state-v2-20261103:/data` 保持。线上结论依据真实 UI、签名回执和 ClickHouse 新数据；隔离测试单独记录。

| 项目 | 实际证据 | 状态 |
| --- | --- | --- |
| 旧 root Agent 卸载与独立状态修正 | 原卸载器核验后返回 0，业务容器/数据保留；恢复 c77eb5182fe88c80a625a399c4df79fd 成功，10 条旧记录进入审计、2 个旧凭据撤销，unknown 原结论保持 | 已通过 |
| Agent 安装/升级/卸载/重装 | 安装 7624c4ab8daf7c6eaff036d4e17bb3d2、升级 b9312a102a57a8f9169c8fce4c9cc987、标准卸载 701745a7447c07f69f66b21a42ed6f7a、重装 f44bf6f4da78aea21e005ec0a181109e 均成功；最新同身份更新 be85cf8c70108787ec4052714e8a6277 至 573b644885c0 | 已通过 |
| 重装后的旧业务绑定恢复 | 0e241a8184641ecfede9c3623d66e92f 成功；Registry/OpenResty/DBX 实例和数据目录保留；两条明确 removed 的旧空记录仅退役中心记录，remote_writes=false | 已通过 |
| DBX 停止/启动及卷巡检 | stop 855d687daf4f224c0d6544ac3327960f、apply cbefd32c2e45e095b797e466f673acd9 成功；命名卷修复后连续12次健康/配置一致、同一容器；最终运行 | 已通过 |
| ABC 部署/停止/启动/升级/卸载 | 部署 b7fc4a06c07f70d6520d410ac34516a2；新 Agent 启动 96edab0aa06ced41989beac5db140a89 后5次稳定巡检；v4 apply f94ce26dbf259aefa56fc97482d7d079、恢复 SDK 镜像 v5 apply e51310853f447c4c47e97aed93c6f170 成功；remove a61eff2de7ac06dd16c8f532ecaed699 成功，保留数据/登记，最终 removed | 已通过 |
| Gitea 部署/停止/恢复 | SSH 2222→22 后部署成功、连续8次稳定；临时停止释放 ABC 配额；最终 apply 9a793410637f94cb67db8f2884874501 于21:40:19Z成功，卡片运行中、旧容量错误清除，首页及健康 HTTPS200 | 已通过 |
| SDK 环境一次性探针 | apply 5d0e63b6dd0d0613de8f968d7035bdc6 成功；log_sdd091live 13:14:34Z新日志证明显式 host 和注入身份；remove 91ca7f4698479c36ee285f3b2a49aabb 成功，最终 removed、health_failures=0 | 已通过 |
| SDK 连续业务数据 | ABC 三轮查询15:56Z、20:15Z、21:24Z；最后21:21:00–21:24:03Z有9 gauge、18 logs，最新21:23:54/57Z，service=abc-demo、host=zz-bj-1、machine=9473f8974462e85d | 已通过 |
| 中心/Agent/主机/容器遥测 | 三轮新数据见相关证据；18:13Z中心心跳/堆各17、zz Agent心跳6、主机192、四服务容器各81；21:07Z中心心跳/堆各18继续更新 | 已通过 |
| 未知作业可审计结束 | SDK inspect b1bd9172630489d9b3a94732af866db2 在中心替换时未知；只读核对 journal、unit inactive/dead、PID=0、无子进程/锁后，正常 UI 人工核对结束。21:00:52Z记录管理员/原因，原 unknown 保持，ABC随后自动升级完成 | 已通过 |
| 网站 HTTPS 与日志归属 | 默认TLS校验；23:59Z、00:19Z、00:26Z三轮Gitea/DBX200、Registry401均带真实网站ID、zz-bj-1来源入库；Gitea网站页QPS/耗时及三轮访问日志可见、采集正常，见 website-identity.md | 已通过 |
| PR108 合并验证 | 中心配置权威、手动成员/解析保留、托管最低可用预算纳入所有后续发行；双架构各95项编译后的自动部署/网站回归全部通过，生产手动成员按原位置/地址恢复 | 已通过 |
| 告警触发/恢复 | zz-bj-1规则实际触发与恢复，无外部通知，测试规则停用保留记录 | 已通过 |
| 自定义大盘保存/读取 | SDD097 - Center verification，ID c4e18a54-0438-47a3-88d9-9f761b82c970，13面板另存并刷新同ID/标题，真实日志及新运行指标可查 | 已通过 |

固定发行 `20261107-website-identity-573b644`，源代码573b644885c0db9846648e51fb0726141040c1e9，OCI index `sha256:f24403c80ba37af7bed013b2b56da63f0cede1fb8ad2e78baefc1b83ccad1e57`。1Panel于07:09:34 CST就绪，实际镜像摘要和关键编译文件指纹一致、healthy。1Panel保留的容器自定义旧revision label不作为源码证据；镜像本身revision和关键文件均核实为本次产物。

每架构50项成品smoke无错误，自动部署/网站编译回归各95项全部通过；其余编译回归174项中173通过、1项原有可选真实Docker证书环境检查跳过。成品Linux普通身份核验、实时中心SDK→ClickHouse→认证HTTP与精确回拉通过。stable latest保持原值。

原始失败、回滚和未知历史保留。ABC与一次性SDK验收容器已卸载但数据/登记保留，原DBX、Registry、OpenResty及Gitea最终运行。设计仅维护本地仓库，本轮无Doca写入。

最终只读回查时间为2026-11-07T00:43:13.283Z（08:43:13 CST）：未结束unknown作业0，执行端观测state=ok、error为空，最近成功00:42:50.394Z，queue_batches=0、queue_bytes=0，中心待处理观测批次0。Gitea、DBX、Registry、OpenResty均为running/desired=running；ABC和SDK探针均为removed/desired=removed；上述六实例health_failures均为0。
