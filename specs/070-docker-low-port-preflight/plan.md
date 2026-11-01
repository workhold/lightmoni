# 修复设计

1. 将 workload/gateway 共用的临时 socket 预检收敛到内部 `operations/host-ports.ts`，保留配置的绑定地址和协议；IPv6 UDP 根据地址族选择 `udp6`，同时支持 `::` 和 `::1` 等具体地址。
2. `EADDRINUSE` 映射为 `HOST_PORT_OCCUPIED`；低于 1024 端口的 `EACCES` 仅跳过本地绑定预检，继续 Docker 最终校验；其余错误映射为 `HOST_PORT_CHECK_FAILED` 并中止。
3. 失败路径关闭临时 socket，不把原始错误或目标机细节写入回执。复用安装进度的白名单原因和中英文说明；新增错误码不改变已有冲突码或历史记录。
4. Gateway 进入端口循环前发出既有 `checking_ports` 阶段。
5. 使用真实 TCP/UDP 监听验证冲突及释放；注入 OS 错误验证权限、未知错误和低端口边界；执行器集成验证权限不足后确实进入 Docker 配置校验，并保留 Docker 返回的最终冲突诊断。

## 兼容契约

- 应用端口配置、API、任务载荷和已有 `host_port_occupied` 含义保持兼容。
- 新增静态原因 `host_port_check_failed`；旧前端可回退到通用诊断，新前端显示中英文处理建议。
- 不保证预检和 Docker 启动之间端口始终空闲；实际 Docker 启动结果仍为权威依据。
- 低端口预检被跳过不等于安装成功；镜像、Docker 启动、健康检查仍须通过原有验证。
