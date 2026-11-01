> 后续 SDD080 已承接本记录中待迁移的业务 profile、应用 Docker 观测与离线数据接管，见 [SDD080 验收](../080-executor-managed-operations/validation.md)。本文件保留 #64 原始切片证据；最终发行须同时包含 SDD080。

# SDD060 验证记录

日期：2026-11-02（Asia/Shanghai）。实施 [PR #64](https://github.com/workhold/lightmoni/pull/64) 在功能分支交付，已合并 main `fd3685e5011c7762ef491cd8fca0ec493b8c555e`；未合入、未发布镜像、未部署生产。设计 PR #47 已合入，其设计检查不替代本轮实现验收。

## 最终交付范围

同一源码与发行包提供普通 Agent 和独立 root 执行器两个固定入口。普通 Agent/脚本继续以 `lightmoni-agent` 运行；明确批准的提权任务由操作系统 root 账户（UID/GID 0）运行。独立 Ed25519 身份、签名计划、单步短期在线许可、防重、持久 journal/unknown fence、敏感输出隔离与一次性人类审批已实现。

中心与普通 Agent 双侧固定只读 capability/action 配对白名单。旧排队写任务取消，曾领取任务置 unknown 并同步业务记录、保留审计与互斥；普通 operations 私有正文与 release artifact 入口固定410，不解密或发送秘密。未迁移业务profile创建前明确拒绝，不写入死队列、不自动升级旧任务的运行身份。旧 Docker 清单只保留历史展示，主机环境读取独立执行器的签名观测；普通Agent不读取原始daemon。网站/证书/完整Compose/systemd/备份等旧主机执行链路均不继续可用，中心/云操作保留。

维护沿用唯一 executor-maintenance 计划/审批/历史/取消/核对入口，支持 upgrade、精确 rollback、可证明的 repair、uninstall。程序切换不回退配置、私钥、输出密钥、journal、防重、grants、清单或策略水位；严格检查完整journal。成功需持久started回执与本次activation的精确签名心跳。unknown不自动回切或重放，显式只读核对仅接受可证明的中断状态，不清真实执行fence。

普通Agent安装/更新/回退仅精确清理本平台旧Docker drop-in；未知drop-in、外部组/ACL保留并拒绝。候选主unit须匹配当前安全SHA，旧高权限previous不能回退，也不能在失败恢复中启动；保留已验证安全unit、停服disable及证据和锁。Docker补装只安装Engine/Compose依赖，不授权或重启普通Agent。

Web补齐统一维护及最小七动作容器表单（list/pull/create/start/stop/restart/remove），共享结果、取消、人工核对和敏感输出显式读取；旧业务入口显示实际阻塞原因。此边界与先行规格 [completion.md](completion.md) 一致。

## 最终自动化验证

冻结最终代码后执行 `npm run build && npm test`：1537项，1518通过、0失败、0取消、19跳过，exit0，约465秒。跳过项需要Linux、真实ClickHouse/Docker或Go工具链等外部条件，逐项记录在JSON；本机隔离Linux的补充验收另列，不能将跳过项冒称已执行。

- runtime类型检查与构建、web类型检查与生产构建通过；Web构建中的antd/use-client提示不影响exit0。
- 浏览器5套共115/115：维护23、容器23、共享提权结果39、Docker依赖文案12、旧业务门禁18。验证中英文、深色/窄屏、精确计划审阅、篡改拒绝、丢确认恢复、迟到响应、取消与人工核对。此为生产组件配合API fixture，不是真实SSH或Docker输出。
- 独立边界复核生命周期83/83、普通Agent维护49/49，未发现未解决阻塞；普通权限/安装更新/主机管理联合166/166及Linux复制权限回归28/28通过。
- 旧通道13套169/169、运维门禁14套177/177通过；最新最终全量结果以本节及 [completion-validation.json](completion-validation.json) 为准，不把中间失败记录称为全绿。
- Shell/Node语法与git diff检查通过。此前完整回归的依赖夹具及旧通道断言已修正并由最终运行重新覆盖。

## 真实 Linux 验收

本机隔离 Colima Linux arm64/systemd252.39/Node24.15.0，用全新容器验证同包首装与注册、真实签名UID0脚本、1秒超时、普通主体及敏感正文隔离、签名策略关闭、离线卸载及中心精确撤权。测试CA显式受信，未关闭TLS验证。

最终新增运行使用生产维护shell和root监督器、真实SHA fixture archive，验证升级、精确previous回退、实际stop→writer竞争后的unknown、只读状态不改journal、新请求显式repair、身份及完整逻辑journal保持。修复实际Linux umask077复制目录mode改变问题；回归可复现旧实现失败，新实现与新容器通过。

固定生产unit不继承QA测试CA，因此本次生命周期实测证明程序、锁和状态边界；中心receipt+本次activation签名心跳的联合确认由HTTP/SQLite真实签名集成fixture验证，未宣称真实中心端到端升级。本轮未挂Docker socket；此前真实list/create/remove属于旧独立运行，只保留其历史报告，不冒称本次全七动作实机验收。

步骤与精确边界见 [linux-validation.md](linux-validation.md)，本轮报告 [linux-completion-report.json](linux-completion-report.json)，此前Docker报告 [linux-validation-report.json](linux-validation-report.json)。首次安装源码版本/摘要为synthetic fixture，维护archive摘要真实，均不是正式发行。失败容器保留现场，不清unknown重跑。QA结束后已停止本轮容器，恢复本机测试VM原先停止状态。

## 后续功能与未验范围

基础权限架构与维护闭环已完成。网站、证书、完整Compose/受管systemd/备份的新profile，定时root持续授权、身份轮换/灾难恢复、发行灰度和完整多架构矩阵属独立后续功能。真实amd64、root/sudo完整组合、Docker pull/start/stop/restart及仓库鉴权尚未实机验收。任意获批root脚本可控制整台主机，不是沙箱；不能保证恶意root脚本执行后的主机可信。

本轮未SSH访问用户主机、未修改生产权限、未构建或发布正式平台镜像。

## Doca 架构同步

仓库系统设计第57、60、69、71章及文首当前执行契约，与 [Doca系统设计](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 同步。最新完成记录见 [doca-sync.json](doca-sync.json)。

924→925更新23块、删除6个相关过时段、插入4块；705个无关块保持，37张原生图均保留，其中3张相关图更新。925→926回读3段恢复与旧权限边界。926→927插入文首现行契约并按最新版本回读，明确旧章节的Agent写协议/历史验收不能当作当前能力，未改原生图。

每轮按最新seq保存并回读目标文字/节点/边，保留无关内容与原顺序；结构回读不冒称浏览器视觉验收。凭据只在受保护运行时使用，不写入仓库、日志或PR。早期902—924同步记录保留在JSON用于追溯，其“当时未实现”说明不代表本轮最终状态。
