# SDD 173：Agent 中断恢复启动与助手内联审批

## 背景

`vchive` 的 Agent 离线且存在 unknown 更新。平台只读 SSH 预检证明 root 登录、系统依赖和既有安装仍存在，但核对/恢复返回远端退出码 127。现有状态读取、探针和恢复启动都固定执行 `/opt/lightmoni-agent/current/node`；当中断维护已经破坏 current 入口时，恢复维护器也无法启动，形成死锁。同时，AI 助手只展示原记录链接，没有原生只读核对与恢复审批卡片。

## 用户场景与验收

### US1：损坏 current 不阻断受控核对和恢复

- 仅对现有只读 probe/status 和人工恢复启动增加恢复运行时选择；正常升级、commit 和主动 rollback 不改变。
- 运行时候选只来自 current 指向的受管直接子发行或 `/opt/lightmoni-agent/releases` 的直接子目录。拒绝路径逃逸、符号链接发行目录、非 root 或可被其他用户写入的目录/文件。
- 每个 Node 必须与同发行 `release.json.node_binary_sha256` 匹配，并通过一次无副作用启动检查；没有合格运行时仍失败关闭，返回固定安全错误。
- 选定运行时只用于启动平台当前固定且校验 SHA 的维护器；原维护器继续核验操作 ID、Agent 身份、原/目标指纹、进程停止和恢复快照，不得跳过这些检查。

### US2：助手内联核对与恢复审批

- unknown 更新卡片向管理员提供“只读核对结果”，调用同一原生记录的 reconcile API；不执行更新、卸载或恢复。
- 仅当记录含当前 `recovery_revision` 且 `recovery_requires_verification=false` 时，允许管理员勾选恢复影响并确认恢复。
- 恢复 POST 前重新 GET 同一记录，复核 ID、Host、unknown 状态、revision 和恢复核对围栏；使用原审批凭据，不在简化卡片中切换凭据。
- 不新增 AI/MCP apply/approve/execute 工具；浏览器中的管理员明确操作直接调用原 API。成员无操作按钮。
- succeeded/rolled_back/failed/unknown 仍按原语义展示，HTTP 接受不等于恢复成功。

## 非目标与边界

- 不自动清除 unknown、不盲目重装、不自动恢复或自动卸载，不执行通用 SSH/Shell。
- 不用保留运行时绕过维护器的业务与安全校验；不为损坏发行伪造成功回执。
- 除只读预检、核对及其原生审计外，不执行生产恢复、升级或卸载；修复需经新镜像部署后再执行人工恢复。

## 成功标准

1. 固定运行时选择在 current 损坏时选择合格保留发行，并拒绝错误摘要、路径逃逸、可写和无可用运行时。
2. 现有 Agent 更新/恢复回归通过，新增运行时选择与助手卡片浏览器测试通过。
3. 类型检查、生产构建、版本一致性、Markdown 链接/围栏及 `git diff --check` 通过。
