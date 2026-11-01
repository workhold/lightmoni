# 主机网络分类界面验收

## 隔离与构建

所有浏览器验证使用本工作区最后一次 `npm --prefix web run build` 的生产 bundle 副本，HTTP 与 WebSocket 全部在 fixture 内拦截。不连接真实主机、SSH、vchive 或生产平台，不启动/停止已有平台服务；每个脚本退出时关闭浏览器上下文并清理临时 bundle。

类型检查、Web 构建与 `git diff --check` 通过。最后 bundle：

- Entry：`/assets/index-Cc1XsCg2.js`
- Entry SHA256：`67fa2afa8e59fbfa91b795aca5350d55be01815bf7c7ebb908eb8d48e1923a41`
- Index SHA256：`9d7b98f466bf6975acef2629069416d8e6366e229846eca86a2cbdd82252114a`

六组浏览器脚本均在此构建后并行执行，运行期间没有再次构建；全部正常退出（exit 0），共 **129 项通过**，无页面错误或未拦截请求。分类、发现和身份报告独立记录了相同 bundle hash；凭据报告使用 `page_errors/unexpected_requests`，其他报告使用 `errors/unexpected`，均为空数组。

| 验证器 | 项数 | 报告 |
| --- | ---: | --- |
| `verify-host-network-categories.mjs` | 14 | `evidence/ui/ui-report.json` |
| `verify-ssh-network-discovery.mjs` | 32 | `evidence/discovery/ui-report.json` |
| `verify-connection-credentials.mjs` | 16 | `evidence/credentials/ui-report.json` |
| `verify-host-identity-requests.mjs` | 13 | `evidence/identity/ui-report.json` |
| `verify-machine-ssh.mjs` | 18 | `evidence/ssh/ui-report.json` |
| `verify-host-registration-onboarding.mjs` | 36 | `evidence/onboarding/onboarding-ui-report.json` |

## 先失败后实现

新增分类脚本先对原主干生产 bundle 运行：1 项通过、13 项失败，`errors=[]`、`unexpected=[]`，报告 `evidence/baseline/ui-report.json`。旧界面会把 Docker 网桥混入主机私有 IP、把私有平台对端放入摘要、缺少入口类型及 VPN 分类，还会读取旧聚合数组生成地址。

原基线样本的 bridge 名为非标准七位十六进制；固定实现前已改成实际 Docker 命名 `br-abcdef000001` 至 `br-abcdef000005`（12 位），没有扩大接口名称分类规则来迁就测试。第一次修复后还修正了 fixture 的单元格精确定位：接口角色文字加入同一 cell 后改用精确接口文本定位，仍严格要求对应原始接口可见。截图等待 Modal 动画结束并滚到网络区域，避免过渡期间的空白截图。

## 行为验收

- 中文/英文和 1440px/390px 均覆盖 `eth0=10.41.0.2`、Docker bridge `172.18..23.0.1`、平台 TCP 对端 `172.24.0.1`。主机摘要保留主机地址，Docker/回环/链路本地/文档保留范围只在详情折叠表可见，私有平台对端只在详情显示。
- 普通 `br0`、`bond0.12` 不被当作容器接口隐藏；`wg0=10.8.0.2` 单列 VPN/隧道。共享地址按范围单列“共享地址 IP”。接口角色声明仅按命名推测，未把未知接口称作物理网卡。
- SSH 入口类型根据已登记的原目标分类，验证私有地址、域名、公网范围 IPv6 和 CGNAT；不解析 DNS、不改目标。地址与复制按钮成组，类型标签可自然换行，复制按钮不会单独掉到一行。
- 公网来源只称“到平台的公网来源”，与公网范围网卡地址分列；来源时间和可信代理/TCP 对端语义在详情保留。公网服务入口（NAT/映射）和公网/内网出口显示待确认，不由单条连接或地址范围推断。
- 原始接口列表始终保留在可展开详情；SSH 发现与主机列表、详情复用同一投影。SSH 安装前提失败不阻止展示有效网络观测；不可用与成功空快照仍可区分。
- 空 `addresses` 时不读取旧 `private_ips/public_ips` 补造主机地址，不重复刷四个缺失 IP 行。成员保留网络摘要，不能看到登记 SSH 目标、入口分类或管理员 SSH 操作。
- 既有默认凭据、登记、SSH 检查、保存计划、确认执行和异步主机选择回归通过，未改变控制路径或凭据边界。

## 目视证据

最终已查看中文主机摘要（1440px/390px）、英文主机摘要（390px）及中文/英文390px网络详情：主机地址与VPN清楚、Docker不占摘要、私有来源在详情、折叠标题换行、地址复制图标保持同组，页面没有横向溢出。截图存 ignored `artifacts/screenshots/`，例如：

- `artifacts/screenshots/specs/054-host-network-address-categories/evidence/ui/host-row-zh-CN-1440.png`
- `artifacts/screenshots/specs/054-host-network-address-categories/evidence/ui/host-row-zh-CN-390.png`
- `artifacts/screenshots/specs/054-host-network-address-categories/evidence/ui/host-row-en-US-390.png`
- `artifacts/screenshots/specs/054-host-network-address-categories/evidence/ui/host-details-zh-CN-390.png`
- `artifacts/screenshots/specs/054-host-network-address-categories/evidence/ui/host-details-en-US-390.png`

## 边界

浏览器证据验证显示投影及原协议交互，不证明任何目标公网可达或实际出口。未改动服务端采集、心跳、持久化字段、可信代理边界或身份。纯分类算法的范围、映射IPv6及异常格式由同SDD的单测证据覆盖。没有执行真实网络探测或SSH。
