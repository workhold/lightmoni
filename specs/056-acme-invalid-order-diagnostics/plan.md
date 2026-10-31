# 设计

沿用 SDD 053 的后台执行与 CertificateProgress。将订单状态校验放入 get_order 步骤内部：HTTP 200 不等于订单有效；每次读取（包括完成挑战后的回读）均检查 invalid。恢复已缓存订单时用已有步骤封装记录 running 和最终结果。

订单失效先落库，再按既有管理员/版本守卫读取授权诊断。顶层 detail 可用时优先使用，包含 subproblems 时只选取有界的 detail/type/status/预期域名；顶层没有原因时检查失败的 DNS-01/其他挑战，不操作 DNS 或重提挑战。提取前登记所见挑战 token，统一脱敏 TXT 引号值及既有已知秘密。最多展示 5 条原因、复用 1200 字符限制。

诊断读取失败只记辅助步骤错误，最终仍是 acme_order_invalid；没有可用原因时解释 CA 没有返回可用错误、旧订单已失效，需要检查后再明确人工申请。后续人工申请由既有 invalid 过滤创建新订单，本次不新增自动重试。

证书查看：新增 CertificateMaterialDrawer，沿用现有 Drawer/Descriptions/Tabs/只读 PEM 的视觉语言；行内与详情均可打开。默认只读公开材料，不在普通快照返回。通过 GET certificate 取当前不可变版本，下载 POST certificate/download 指定 version 和 format，私钥只响应附件不进入 React state。服务端显式白名单提取 CERTIFICATE 块，返回叶证书/中间链/完整链；下载文件名仅用安全 ID/版本。无链不伪造，过期材料仍可下载并显示有效期。

下载使用 fetch + Blob、当前会话和 AbortController，响应成功后创建临时下载链接并释放；退出/切换清理请求。下载动作无新审批流程，点击下载即管理员明确请求。沿用 Drawer 开合、Tabs 与按钮 loading 的已有动效；局部低风险新增不引入新动效体系。架构同步 §33.5/§33.6，Doca 局部文字更新并回读相关章节与原生图块。

验证：真实 store/SQLite/控制器与受控 ACME 对端，覆盖恢复缓存订单、顶层错误、挑战错误/子问题、多域名、无原因、诊断读取失败/撤权、第二次订单回读 invalid、人工再申请、步骤状态和脱敏。HTTP 回归管理员/成员、版本固定、证书/链/私钥附件与 no-store、缺失和非法输入；浏览器从真实行入口查看并验证实际下载字节，覆盖加载失败/重试、下载失败保留、窄屏和双语。

协议依据：[RFC 8555 §7.1.3](https://www.rfc-editor.org/rfc/rfc8555.html#section-7.1.3)、[§6.7.1](https://www.rfc-editor.org/rfc/rfc8555.html#section-6.7.1)、[§8](https://www.rfc-editor.org/rfc/rfc8555.html#section-8)；实现对照本仓库锁定的 acme-client 5.4.0 源码与类型。

发布沿用 SDD 055 工具：代码经 PR 合入；git archive 固定 main SHA，Docker Desktop 分别构建 amd64/arm64，独立 ClickHouse/中心验收，并补证书公开查看和私钥下载字节/匹配检查。使用 credential helper 进程内认证，固定版本与 latest 并发守卫后发布；独立客户端回读双标签、重新拉取与已验收镜像比较；仅清理本任务验收资源。默认镜像引用和公开证据通过后续同 SDD 发布记录 PR 合入，GitHub release 标签绑定构建源码。
