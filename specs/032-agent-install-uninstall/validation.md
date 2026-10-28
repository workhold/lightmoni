# 验收记录（2026-10-28）

## 线上主机管理与 vchive

目标为 `https://moni.heyphp.com/machines` 及用户授权的 vchive 开发机。通过平台 HTTPS API 和直接 SSH 交叉核对，既有 Agent 的独立 systemd 服务为 active/running，运行用户是 `lightmoni-agent`，版本 0.1.0、Linux amd64，重启次数为 0。CPU、内存、系统、文件系统、磁盘和网络采集均正常；队列和隔离区为空。真实查询中心 `metric_host_gauge` 表，在近五分钟找到该节点 342 条指标，不能仅以页面在线标记代替数据送达验收。

使用本次专用、15 分钟到期且 forced-command/restrict 限制为固定只读预检的 SSH key，通过平台新增临时凭据、验证动作恢复可用并完成平台到 vchive 的真实 SSH 检查。之后已撤销并清空平台测试秘密、移除远端本次授权与脚本、关闭登录会话。没有执行线上安装或卸载，没有替换 Agent 身份、配置或节点凭据。

最终工作树的九字段只读生命周期探测确认：程序完整、服务运行、标准受管 unit、两个持久目录保留，无任务标记或生命周期锁。该项验证的是本次代码生成的只读命令，不代表线上平台已更新。

真实发现与限制：

- vchive 的主机记录 `agent_id` 为空，但独立节点心跳与指标正常。因此主机管理显示“未接入”并不等于机器上 Agent 没有运行。本期不自动认领或绑定历史手动安装节点。
- 当前线上自动安装首先无鉴权下载 `install.sh`，该请求实际返回 401。本次改为通过 stdin 提供 enrollment token，以远端 0600 临时 curl 配置完成鉴权下载，秘密不进入 argv/env；真实 shell 夹具验证鉴权头、文件权限与清理。
- vchive 已安装 Agent，不能为首装测试覆盖现有身份。本次新增首装防覆盖，也没有执行生产卸载。线上完整 enrollment、非 root 启动和入库的先前验收见 [SDD 024](../024-agent-install-startup-fix/validation.md)。

脱敏证据：[live-report.json](live-report.json)。

## 本机 Linux/systemd 真实安装与卸载

使用本电脑的隔离 Colima Linux arm64 VM，测试前确认没有 Agent 文件、服务用户或组；系统为 Ubuntu/systemd 255。发行包取自此前已校验的 0.1.0 arm64 发布产物，安装器和固定生命周期命令使用本轮代码。

8/8 检查通过：实际首装创建专用用户并启动 active/running 服务，真实 OTLP 测试日志进入持久 SQLite 队列；固定卸载停止服务并移除程序、launcher、unit，随后 systemd 为 not-found。配置和身份文件 SHA 完全不变，已 ACK 的一批 pending 数据仍在，服务用户保留，独立只读回查确认结果一致。测试后仅清理本次 fixture 文件/用户，并停止本次启动的 VM。

这是使用随机合成凭据和 loopback:9 目标的离线安装/保留数据卸载，不连接生产，不覆盖中心 enrollment 或撤销链路；中心撤销与权限保护由后端集成测试覆盖。不能据此声称 Linux 双架构全场景、升级/回滚均验收通过。

证据：[systemd-report.json](systemd-report.json)。

## 自动化与界面

- Runtime 全量：426 项，409 通过、17 跳过、0 失败。跳过项包括需 Linux/root 的发布执行、真实 ClickHouse/Nginx/发行包等环境集成，不计为通过；本轮变更的主机管理、固定 shell、任务守卫和撤销认证回归均执行。
- 后端针对集：68/68；最终脚本与任务通道回归：28/28。覆盖管理员限制、计划过期/撤销、身份和指纹变化、同主机与跨主机互斥、停止/systemd 查询失败、未知结果恢复、数据保留、精确撤销安装会话凭据和撤销后禁止 legacy Key 降级。
- Runtime 类型检查、构建及 shell 语法检查通过。
- Web 类型检查、生产构建通过；真实生产 bundle 的 Playwright 请求拦截验收共 50 项：卸载 14 项、原主机管理 18 项、凭据策略中英文 18 项。页面错误与意外网络请求均为 0。界面测试使用受控请求响应，未执行远程 SSH。

界面证据：[卸载 14 项](agent-uninstall-ui-report.json)、[主机管理 18 项](machine-management-ui-report.json)、[凭据保留 18 项](credential-retention-ui-report.json)。

## 架构同步

本次改变 Agent 生命周期控制路径及凭据撤销边界，已更新仓库 `docs/system-design.md` 第 13 节和部署说明。Doca 第 13 节 seq 769→771：最终七段逐段 SHA 回读一致，五个原生图块完整 JSON、节点、连线及样式保持一致；无关内容保留。

证据：[doca-sync.json](doca-sync.json)；[Doca 系统设计](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)。本轮功能须经 PR 合入、构建发布并部署后才在线上生效；本次没有发布镜像或变更生产 Agent。

## 提交状态

已同步最新 `origin/main`（7872b17），无新增主干提交或冲突；最终只读审查未发现阻塞问题。[GitHub PR #13](https://github.com/workhold/lightmoni/pull/13) 已创建等待审核，未合并。
