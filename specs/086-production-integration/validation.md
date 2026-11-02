# Validation

## 已完成

- v1 线上中心升级到 20261102-e3b5f75，healthz=ok；中心约6秒切换，ClickHouse未重建，管理员/会话/主机保留。
- zz-bj-1 已有 Docker 26.1.3 / Compose 2.27.0 的 CentOS 真实固定 SSH 验证成功。
- 经用户精确批准，仅容器管理的独立执行器安装、签名验证与容器 list 成功，退出码0，真实返回空列表。此为重建前基线证据，不等于新版统一 Agent 已验收。
- 新 SSH 失败诊断与恢复定向测试12/12；真实回环 ssh2 fixture 检查非零退出码/有限原因及秘密不回显，HTTP/数据库回归保持unknown、enrollment与生命周期阻塞，不重放安装。
- 根 typecheck、build通过。完整测试执行中，结果待补充。
- 浏览器隔离 fixture 核对 root Agent Docker 依赖文案、有效账户默认选择、确认后单次安装、成功状态；容器未授权英文引导跳往同一主机权限，ready状态启用计划。
- Demo真实HTTP测试1/1，覆盖健康、状态、POST请求计数、静态文件、安全响应头、404和超限请求；本地浏览器按钮得到真实请求ID，实时请求数增长。
- Doca同步：seq943最新全文回读，原807块与42张原生图完整不变，3段新增入口/授权/诊断约束与仓库第86章一致。证据见 evidence/doca-sync.json。

## 待完成

全量测试最终结果、GitHub合入、双架构镜像、v2状态启用和统一Agent实机、私有镜像/应用/网站/DNS/TLS、公网abc.heyphp.com请求。

任何生产数据库、主密钥、环境文件或DNS/SSH/registry秘密均不进入本目录；现场截图保存在忽略的 .local-dev/production-upgrade-083/。
