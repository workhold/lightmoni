# Agent 部署实现验收记录

日期：2026-10-18
状态：enrollment/activate 和每节点 control/data credential 基线已实现；凭据轮换、签名发行和真实 Linux 双架构验收仍未完成。

## 已实现基线

- 管理员可以通过 `POST /api/v1/agent-enrollments` 创建短期一次性 enrollment，会话响应只返回一次完整 token；`GET /api/v1/agent-enrollments` 返回脱敏状态。
- 安装脚本支持 `--enrollment-token-stdin`。网页生成的命令不包含 token；在线下载使用临时 curl 配置文件，token 不进入 URL 或 argv。
- `POST /api/v1/agents/enroll` 按 token、版本、架构和 `install_nonce` 原子兑换 pending agent/bootstrap credential；相同 nonce 返回同一 pending agent 元数据，第二个 nonce 被拒绝。为避免重复返回 bootstrap secret，丢失首次响应后的安装器自动恢复仍待补充。
- Agent 完成最小健康检查后调用 `POST /api/v1/agents/:id/activate`，中心签发独立的 `control_credential` 和 `data_credential`，中心只保存摘要。
- Agent 配置支持 control/data credential，无 legacy key 时也能分别使用控制和数据 audience；旧 `config.key` 仍保留兼容路径。
- 管理员可以按节点或 audience 调用 revoke；撤销会阻止后续 credential 认证并保留节点身份/队列。

## 实际执行的检查

在当前工作树执行：

```sh
npm --prefix runtime run typecheck
npm --prefix runtime test
python3 -m py_compile scripts/*.py
sh -n scripts/build-*.sh
```

结果：runtime typecheck 通过；runtime 测试 `155 passed, 3 skipped, 0 failed`。新增凭据测试覆盖一次性 token、安装命令不含秘密、同 nonce 恢复、不同 nonce 重放拒绝、control/data audience 隔离、按 audience revoke 以及 Agent 配置的 legacy 兼容。

前端安装命令测试已覆盖 enrollment token 不进入生成命令、shell 参数转义和管理员操作边界；脚本通过 `sh -n deploy/agent/install.sh` 及运行时测试间接验证。上述检查没有替代真实 Linux systemd、网络中断、断电或供应链签名验收。

## 已知限制与未完成任务

| 范围 | 状态 |
| --- | --- |
| 凭据轮换 | 未实现自动/管理员 rotation、grace 窗口和确认事务；当前激活凭据有固定过期时间 |
| 重新 enrollment / abort | 未提供完整管理员 re-enroll 和 pending abort API；失败 pending 主要依赖过期/重试规则 |
| 配置租约 | 未实现；节点断网时缓存任务可能继续运行，恢复连接后才获知撤销 |
| legacy Key 收敛 | 旧 `config.key` 仍可下载、注册、控制和上报；尚未完成节点迁移与旧 Key 撤销 |
| 发行信任 | 只有 SHA256 清单，没有签名元数据、信任根、密钥轮换或降级保护 |
| 真实主机验收 | 尚未在 Linux amd64/arm64、glibc≥2.28 的真实 systemd 主机完成安装、升级、断网、满队列、掉电恢复和权限检查；现有 shell 验收使用命令 shim |
| Agent 容器 | 未发布独立 Agent 镜像或完整宿主采集容器验收 |
| UI 审计 | enrollment 创建/状态和一次性 token 已接入；撤销、轮换、离线恢复审计 UI 仍待完成 |

## 验收结论

中心 enrollment/activate、脚本 stdin 接入、节点绑定 control/data credential 和基础 revoke 已完成代码级验证。生产发布前仍需完成凭据轮换/重新 enrollment、签名发行、legacy Key 迁移、配置租约及 Linux 双架构实机验收；本记录不把这些缺口标记为已完成。
