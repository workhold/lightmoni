# 验收记录（2026-10-31）

## 最终行为

登记、编辑和详情统一使用“SSH 连接地址”，首次仍由用户提供平台可访问的 IP 或域名。用户执行 SSH 安装检查后，在安装 Agent 前即可发现观测主机名和网卡内网 IPv4/IPv6，并在检查结果、主机列表与详情中显示采集来源和时间。发现不修改用户名称、主机 ID 或 SSH 连接配置，也不生成安装/批准动作。

网卡发现与核心安装条件分别处理，安装条件不满足也能显示合法网络快照；工具缺失、非法或超量数据只令发现不可用，保留已有成功记录。合法 SSH 与 Agent 快照按时间更新，各自检查目标代际/主机密钥或 Agent 身份。平台观测来源 IP 保留独立的当前 Agent 与可信代理边界，不推导公网入口或其他连接的出口。

## 后端验证

[机器可读结果](test-summary.json)记录最终源码摘要与命令。10 个相关测试文件共 **111/111** 通过，失败、取消和跳过均为 0，覆盖：

- SSH 严格核心输出与可选紧凑 `ip -j -brief address show` 发现解析，多网卡、桥接/veth、IPv4/IPv6、非法主机名和地址、8 KiB/64 条边界、缺失工具及有效空快照。
- 真实回环 SSH2 协议，密码与私钥认证，同一预检只有一个固定 exec；测试工具提供确定性的 uname/ip/curl 输出。30 KiB 远端网卡输出在 producer 限制后不会挤掉 runner 的核心结果，不把该 fixture 称为真实 Linux 主机安装。
- 无 Agent 主机的 API 级保存、刷新回读和审计结果；核心条件失败仍保存网络，发现失败不覆盖先前成功快照。
- 取消、目标变更和凭据撤销不写入发现结果；SSH 目标代际/主机密钥、Agent 重装、旧字段缺省、乱序时间与来源独立失效。
- 老表迁移保留旧 Agent 归属与原时间；故障注入证明 DDL/归属回填可一起回滚并安全重试；SAVEPOINT 支持外层事务且不提前提交外层，后续来源身份不能被回填为早先网卡归属。
- 既有默认凭据、主机公钥、密码 SSH、终端、登记/部署/卸载、审批计划及 Agent 入场回归。

`npm run typecheck`（runtime、ai-runtime、web）通过；SDK TypeScript、runtime、AI runtime 与生产网页构建均通过。迁移加固后重新完成全部 111 项与 runtime 构建，UI 未再修改。

## 网页验证

使用当前生产 bundle 和全拦截 API fixture，**102 项**检查通过，页面错误与非预期请求均为空：

| 流程 | 通过 | 证据 |
| --- | ---: | --- |
| 首次 SSH 网络发现、来源/时间、Agent 接续、失败/旧结果/空快照、中英与 1440/390px | 32 | [网络界面](evidence/network-ui/ui-report.json) |
| 中央凭据、默认绑定、登记选择、网络摘要与期限 | 16 | [凭据界面](evidence/credentials-ui/ui-report.json) |
| 登记、凭据保存重试、预检/审批、永久凭据、终端、权限和窄屏 | 36 | [登记回归](evidence/onboarding-ui/onboarding-ui-report.json) |
| 预检失败/取消、持久审批计划、删除保护、英文和 AI 结果深链 | 18 | [SSH 回归](evidence/ssh-ui/ui-report.json) |

[视觉记录](evidence/network-ui/visual-review.json)核对 6 张最终截图：中英桌面和中文窄屏的发现弹窗与主机详情。截图遵守仓库约定保存在本地 `artifacts/screenshots/`，网卡表只在容器内横滚，IPv6、来源和时间无页面溢出。

另尝试了旧 `verify-hosts-nodes.mjs`，首个旧文案断言失败，并发现 fixture 未拦截 `/host-labels`。已核对当前 main 本来就使用新文案；旧脚本还保留已过时的任务页签断言（后续步骤未执行）。该脚本未计入通过数，也未修改生产界面迎合它，本轮对其纯标签修改已撤回。新网络 fixture 验证登记/编辑的手填 SSH 地址、只读打开、发现不覆盖 ID/名称/目标及无额外安装写请求。

## 架构同步与边界

架构影响：有。更新 `docs/system-design.md` 13.7 及 13.6/13.7 流程图，并通过 Doca MCP 局部同步。[同步说明](doca-sync.md)与[最新回读](doca-readback.json)确认第 13.7 节 7 段正文和两张目标原生图一致；其余 22 张图、551 个无关原有块及所有原有块顺序保持。受保护 context 和内存凭据 worker 已关闭，不将结构回读称为浏览器渲染验收。

本轮未访问生产平台或 vchive，未执行真实 Agent 安装、daemon 或部署审批，也未制作/发布新镜像。目标缺少 `ip`、`timeout`、`head`、`od`、`tr` 或不支持 JSON brief 时只显示未发现；不自动安装依赖，不调用第三方公网 IP 服务。真实 Linux 发行版/iproute2 版本矩阵、实际 NAT 入站映射和生产 SSH 安装仍不属于本地 fixture 验收。
