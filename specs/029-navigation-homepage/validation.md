# 验收记录（2026-10-28）

## 交付行为与兼容影响

左侧分类独立展开，切换分类或页面不会收起其他已展开分类；整体收起导航后再展开仍保留本次状态。首次加载只展开当前页面分类，刷新不持久化多个分类的展开状态。

默认入口为 AI 助手。“默认首页”位于个人设置→界面偏好，右上账户菜单可直达，选择后立即保存在当前浏览器的账号专属键中。品牌入口、根路径、登录入口和未知路径使用该设置；明确页面深链及查询条件保持有效。原来作为概览的 `/` 现在是默认入口，概览固定为 `/overview`。偏好不跨浏览器或设备同步。

主机列表地址复制修正为实际显示的 `address:port`；中英文凭据提示明确“到期失效”与“删除存储密文”的区别，继续建议避免长期保存、用后撤销。本次没有改变后台凭据的存储和清理行为。

## 验证

| 检查 | 结果与证据 |
| --- | --- |
| 类型检查与生产构建 | `npm --prefix web run typecheck`、`npm --prefix web run build` 通过；既有依赖 `use client` 与较大 chunk 警告保留 |
| 首页规则边界 | 精确导航白名单、管理员/成员、账号隔离与降权、外部路径拒绝、登录深链和查询条件、存储异常均通过；生产 bundle 的 12/12 组浏览器交互通过，错误和意外请求均为空，见 [UI 报告](ui-report.json) |
| 主机后端与真实本地 SSH/终端 | 25/25，通过且无跳过；包含临时 loopback sshd 的真实握手、私钥认证、指纹、PTY、UTF-8、Ctrl+C、resize、流控、断开、撤销、过期、登出、总时限和互斥释放。见[本地报告](machine-local-report.json) |
| 主机生产 bundle 交互 | 14/14，浏览器错误与意外请求均为空；包含实际剪贴板读取、双语有效期提示、预检/计划状态、成员权限。API 和安装结果使用隔离 fixture，见[本地报告](machine-local-report.json) |
| 线上主机 API 与页面 | 15/15 API 检查及人工页面检查通过。覆盖匿名拒绝、登录/列表、登记和输入校验、详情、缺少指纹/预检时的执行拦截、临时记录修改和清理；见[线上报告](machine-live-report.json) |

线上仅创建不含秘密的 `.invalid` 测试主机，未保存连接凭据、确认主机指纹、执行 SSH 或批准安装；测试后已删除本次记录，恢复原始主机集合，并注销脚本自己的登录 session。浏览器刷新确认仍为原空列表。

可复验命令：

```sh
npm --prefix web run typecheck
npm --prefix web run build
node web/src/app/verify-navigation-homepage.mjs
node web/src/app/verify-machine-ssh.mjs
(cd runtime && node --import tsx --test --test-concurrency=1 test/managed-machines.test.ts test/machine-ssh.test.ts test/machine-terminal.test.ts test/machine-ssh-live.test.ts)
```

浏览器回归使用隔离 API fixture。线上验证报告由独立的临时脚本生成；账号凭据仅存在其内存中，脚本不随仓库交付，不提供默认凭据。

## 测试边界与后续缺口

- 线上测试开始时没有已登记主机，不能据此宣称生产 SSH 连通、反向代理 WSS、远端运行依赖或真实 Agent 安装已验证。
- 本地 SSH 是真实的临时本机服务；Agent 安装成功/失败流程由模拟 SSH runner 和 enrollment receipt 验证，不代表真实安装成功。
- 主机前端目前没有编辑/删除入口，后台已有对应 API；登记时漏填指纹后，页面不能直接补录。已记录为后续改进，本次不扩展主机管理能力。
- 凭据到期或撤销不会自动删除已保存密文，本次只更正提示。私钥自动 SSH 仍要求直接连接、已确认指纹及可用的无口令私钥；密码不支持自动执行。
- 本次通过 PR 交付，未构建/发布新镜像，未升级线上平台，未更新或重启任何远端 Agent。

## 交付

已同步远端主干并完成独立代码审查，未发现阻塞问题；通过 [GitHub PR #10](https://github.com/workhold/lightmoni/pull/10) 交付，等待审核合入。`git diff --check`、证据 JSON、相对链接及凭据标记检查通过。

## 架构同步判断

不适用。仅调整现有前端导航、路由、同一浏览器保管边界内的界面偏好与展示提示，不改变后台 API、组件职责、凭据边界、存储系统、数据/控制路径或部署拓扑。依据仓库 AGENTS.md，不为此重复改写系统设计或 Doca。
