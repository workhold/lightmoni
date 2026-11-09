# 验收与发行

日期：2026-11-09。独立工作树 codex/116-deployment-cache-recovery；原工作目录的未提交 Compose 和历史证据未改动。用户明确授权完成后合并、发布 Docker、部署生产并重跑应用。

## 现场判断与最终行为

目标 zz-bj-1 的 Web 应用新版本通过公网 Registry 认证成功，但约374 MiB层读取触及300秒超时。已登记的同机内网仓库可快速读取，认证分支却跳过它。新路径先复用验证后的本机镜像，再读已登记内网仓库，允许回源时才临时领取原仓库凭据。相同 RepoDigest/config 的别名无需下载层或重复导入；可变标签升级重新解析当前清单。现场新版本 config 不在 Docker 本地，因此该次需要内网读取与导入。Registry 与 Docker 不共用底层目录。

唯一未释放 unknown 为 workload.inspect，实际应用容器仍运行。原签名 helper 核对原身份、租约、冻结摘要与原父任务的动作/目标一致后，只对明确 inspect 白名单自动标记已核对；保留三类任务存储的 unknown 历史、原回执与固定审计。由新观察恢复实际健康。未知变更、脚本及归属不匹配仍阻塞，本机操作锁的精确 operation_id、文件身份和进程检查不变。

## 检查

- Runtime 类型检查及编译、Web 类型检查通过；Web YAML 往返3/3通过。
- 执行器及签名协议相关120/120通过，覆盖新自动核对、中心对象重建后恢复、重复请求、原父任务归属、错误摘要/租约、未知变更仍阻塞、原脚本/容器/本机 fence 边界。
- 镜像认证/缓存相关19/19通过，使用真实 HTTP 仓库夹具验证本机、摘要别名、config 命中、只在缺失时导入、可变标签刷新、内网优先、禁回源、损坏内容、回源临时认证与清理。Docker 命令使用可控夹具，此项不冒充真实 Docker 部署。
- 合入网站端口修复 PR157 后，网站/集群/镜像策略/认证联合回归133/133通过。
- 全量 Runtime 首轮1659项：1622通过、34项按平台/外部环境跳过、3项失败。两项 AI worker 因独立工作树缺少 AI 构建产物，另一项监控因共享 node_modules 指向原工作区旧 SDK；补齐 AI 构建、建立工作树独立依赖链接并编译本分支 SDK 后，三份失败文件27/27复测通过。均无需修改产品代码；没有把首轮失败隐藏或声称单次全绿。
- git diff --check 通过。详细相关日志随 evidence 保存，完整临时日志在 /tmp/lightmoni-116-*.log。

## 架构同步

适用：认证镜像获取控制路径和未知只读观察自动核对路径变化。仓库 docs/system-design.md 第111章及新增116章与 Doca 同步。按本会话用户提供的 AGENTS.md 执行在线同步；主干 AGENTS.md 的本地文档要求同时满足。

[Doca 基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)保存成功，最新 seq1769 回读第111章目标段落、原生图及116章三段文字/原生图，正文与预期一致。原图保留全部8个节点ID和8条连线ID，增加本机/集群分支后10节点12连线；新图7节点6连线，端点有效。未对无关块发出修改；没有重建全文或把图块替换为图片/Markdown。见 evidence/doca-readback.json。

## 交付进度

本会话先前网站端口修复已通过 PR157 合入 main，合并提交 befd822e5a81da23b1d98b3431a229746536012c，本分支已同步。部署恢复修复通过 PR158 合入 main，合并提交40916db5a49c1408d1a8317730724744f113fa0c。双架构发行和生产中心/目标Agent更新已完成；Web v6重跑已成功，脱敏成品和生产证据随本规格保存。

## 双架构 Docker 发行

固定镜像 docker.heyphp.com/lightmoni/lightmoni:20261109-deployment-recovery-v1，OCI索引 sha256:2efa6a870abd06ced159a7d5aadc50132623085f2c13dd4acf2bbd55c6abdd7c，源码40916db5a49c1408d1a8317730724744f113fa0c，包含PR157/158。构建上下文仅为合并主干的 git archive，不含工作区未提交文件。两架构各58项成品检查通过，errors为空：隔离真实ClickHouse/SQLite启动、登录/持久会话、SDK与Agent下载校验，以及编译后的新集群优先/本地内容复用/禁回源/认证隔离和签名中断观察恢复回归。amd64为本机Docker仿真、arm64原生；此项不冒充生产部署。

37份唯一OCI blob本地SHA256核对，成品config/rootfs与已测试镜像一致；发布后逐blob HEAD、平台manifest/config GET、固定索引GET通过，并独立用docker buildx imagetools inspect回读摘要和两平台。latest发布前后保持sha256:1435938eacd969554e581b1cce0b996ff36ac6e1b886c9fc42e5b21e231a5a51。发布凭据仅经Docker credential helper运行时读取；隔离测试中心、ClickHouse、网络、卷及临时凭据已清理。

线上目标amd64 Agent包构建0.1.0-40916db5a49c-046e31657d85，SHA256为5694bd907a1a791996d5cadbb4a3defdc9dcd6589fbc7d5b5309579ed58a48d7，需通过既有维护入口更新管理组件。

## 生产中心切换

通过既有已登录1Panel终端执行；生产仅备份中心SQLite、主密钥及原Compose/环境/容器配置，备份保留在主机root私有目录，不下载到工作区。快照499191页×4096字节=2044686336字节，quick_check=ok；目录0700、文件0600。ClickHouse及应用数据原地保留，未声称完整遥测备份。

新镜像在生产主机预拉取并验证amd64、源码和OCI索引；等待已有签名queued/running任务空闲后只原子替换Compose中心镜像。09:30:25启动，09:30:51确认healthy；数据卷、全部环境键值、启动配置、端口/网络、安全选项、主密钥与另外16个容器ID均与备份基线一致。公网healthz返回ok。没有执行程序回退或数据恢复。

原阻塞观察2e04234d8fc5e2b814bb3b85c6b2ea2c于09:30:56由原helper签名reconcile自动核对，原因read_only_observation_interrupted；状态仍unknown，未人工修改任务数据库或隐藏错误。后续已有多条新的成功观察回执，Agent维护首次预检遇正在执行任务而正常拒绝，等待空闲边界重试。后续健康与应用部署验收另记。见evidence/production-center.json。

## 目标 Agent 与线上重跑

通过既有Agent维护入口创建计划84096cd6b4f358c582c96005130640f7，审阅并执行同账户升级；09:45:45开始、09:47:03确认成功。此前旧helper自动恢复任务仍沿公网读取并300秒超时，等待其已知失败结束后再规划，没有取消未知写任务或绕过维护门禁。升级回执确认service/helper active、身份与发行一致；另从签名helper observation回读源码40916db、包摘要5694bd907a1a…58a48d7、构建0.1.0-40916db5a49c-046e31657d85及原lightmoni-agent账户(uid994/gid991/权限代次1)。见evidence/production-agent.json。

Web“小猪绘本”v6于09:47:38手动重跑，平台执行15736fa79a93f7f1e35a017afac75d07、签名任务06965c8339d013647ae854f81fb82658，09:47:59开始、09:48:51成功，退出码0。执行回执明确source=cluster-registry，config/image ID 41a262c114ee…3bf6df5，下载391948746字节；来源准备09:48:03–09:48:29约26秒，整次执行51.8秒。新config先前不在Docker本机，该次按设计从已登记同机内网仓库读取并导入；没有把Registry存储目录冒充Docker镜像。见evidence/production-web.json。

同一v6再次部署，平台执行befec42123e76a8402fae2205e0b2255、签名任务b478b2c223b805a739faac7e1f0d717b，09:51:28–09:51:38成功（9.8秒），退出码0，source=local且同一config/image ID。因可变标签刷新读取1572字节清单，复用Docker已有内容，无镜像层下载和重复导入；没有声称完全零网络。首次尝试同版本重跑碰到实例正在inspect而没有新执行，先核对旧记录、等该检查结束后才实际创建第二轮，没有重复投递已运行写任务。

中心只读投影显示四应用均running、healthy=1，desired_generation与observed_generation相等：仓库7、OpenResty集群固定版本4、PostgreSQL3、Web6；观察时间09:51:14–09:52:12，均为升级后新回执。目标主机未核对unknown签名任务为0。原“服务地址已保留，按中心配置恢复”提示已从四应用消失。公网中心healthz与Web站点均HTTPS校验通过、HTTP200。见evidence/production-applications.json和production-http.json。仅程序与所授权应用部署发生变更，没有手改任务状态、数据迁移或删除数据。

发行验收证据补充PR仅更新本SDD的任务/验收与脱敏JSON，不影响架构；不适用再次架构同步，代码路径与已回读seq1769一致。Docker源码仍为40916db，不把后续纯文档提交冒充构建来源。
