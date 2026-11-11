# 生产复查与验证证据

日期：2026-11-11；以下事件时间均为北京时间。生产取证窗口约 22:32–22:40；本地验证记录于 23:15。

## 生产只读取证

通过现有受保护凭据、主机公钥校验的 SSH 和中心 SQLite 只读查询交叉核对；仅记录白名单事实，不保留密钥、令牌、完整原始日志或数据库副本。

| 主机 | 确认事实 | 判断与限制 |
| --- | --- | --- |
| zsw-hk8c16g-doca-1 | 10:53:46 enrollment 激活；helper 10:53:58、Agent 10:53:59 启动。Agent 上报至 13:59:11，最后成功通信约 13:59:32。13:59:40 人工结束未知安装，control/data 凭据同刻撤销。取证时两个服务均 active/running、NRestarts=0，版本 7011d507e1db；安装记录 unknown，仅有 bootstrap_dispatched、通用错误和人工结束记录。 | 不是“远端程序一直没装好”。平台单次即时就绪检查有竞态，但旧错误已丢失，不能证明该竞态是当次唯一异常。凭据撤销已证实；另有中心连接超时，不能把所有网络错误都归于撤销。不能通过刷新或重启复活授权。 |
| zsw-bj-1 | 取证时 /opt/lightmoni-agent 与 launcher 缺失，systemd Agent/helper 单元不存在；配置、身份保留。旧 Agent 最后上报为 14:46:13。 | 当前属于程序缺失；尚无证据确定移除来源，不能归于同一安装确认竞态。 |
| vchive | 取证时程序目录、launcher 与 systemd 单元缺失，配置和身份保留。13:06 创建维护任务，平台 unknown；13:08 的旧回执 waiting_confirmation 曾显示本地 Agent 运行。 | 旧回执不能代表当前健康；需按实际远端状态恢复。尚无证据确定程序移除来源。 |
| zz-bj-1 | 16:55:27 更新成功，取证时新鲜心跳、运行身份与版本正常。 | 当前未复现。 |

生产运行的仍是上一版 7011d507e1db74082c674a78f8ff3c921faf8f91（agent-install-recovery-v1 镜像）。本次未改生产数据库、未恢复已撤销凭据、未再次安装 Agent，也未将新代码部署到生产。

## 代码缺口与最终行为

原 apply 在 SSH 成功后只读一次激活、runtime 心跳与 root 签名通道；未就绪立即 unknown。post-dispatch catch 对没有 SSH remoteFailure 的异常仅保留通用错误，丢失阶段。

本次在同一请求、同一安装内有界只读等待，默认 60 秒、1 秒间隔，使用单调时钟和可取消计时器。不会重放 SSH 或重签身份。迟到激活、身份心跳和签名通道可完成原安装；超时/取消留下固定原因与已完成阶段。安装进入恢复、被明确结束或 enrollment 被替换时旧请求停止确认，不覆盖已保存恢复结果。人工结束确认提示明确告知现有凭据撤销和离线后果。

## 验证

- 测试先行：新 helper 回归最初因缺少模块失败，随后实现并通过。
- 8 个关联测试文件，共 **196 项通过、0 失败**：agent-install-readiness、managed-machines、unified-agent-installation、machine-installation-recovery、machine-installation-recovery-races、machine-agent-runtime、machine-ssh、assistant-host-installation。
- 覆盖：激活/心跳迟到、错误 mode/permission_generation/过旧心跳拒绝、root 通道迟到、各阶段超时、单次 bootstrap、HTTP 断开取消和 busy 释放、人工恢复竞争、固定 SSH 原因、非白名单异常脱敏、身份和 SSH 凭据保留。
- runtime `npm run typecheck` 与 `npm run build` 通过；web `npm run typecheck` 通过；`git diff --check` 通过。
- 本地 Node v26.0.0；使用隔离内存数据库与模拟 SSH，未将回归测试连接到生产。
- 提交前 `git fetch origin main`，基线 7011d507e1db，当前 main 与分支起点一致，无冲突。

## 架构与上线状态

架构同步：不适用。现有同步确认流程增加有界等待，复用已有状态、error/stages 字段及原健康条件；组件、存储、协议结构、凭据权限与部署拓扑不变。无需修改仓库 system-design 或 Doca 基线，未声称在线同步或生产升级完成。新代码需通过 GitHub PR 合入后发版。
