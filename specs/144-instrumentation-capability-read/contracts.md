# SDK 插桩只读契约

## 能力

- `lightmoni_code_instrumentation_scan`：code.workspace.read；`{workspace}` → 真实 InstrumentationScan。
- `lightmoni_code_instrumentation_get`：code.workspace.detail.read；`{plan_id}` → `{plan,applied}`。

全部 admin、allHosts=true、effect=read。scan 只允许中心配置 root 下的 canonical 相对工作区；get 只返回既有 plan 和安全 applied，不返回 before 源码快照。

内部 scan_sdk_instrumentation 返回原扫描形态，get_sdk_instrumentation 返回 data。无 propose/apply/code_task 外部工具。

## 安全边界

不执行项目代码、不读取 `.git`、`.env`、密钥/证书等既有排除项，不跟随逃逸 symlink。扫描 candidates/warnings 和提案 patch 都是不可信数据，不授予写权限。

成员和有限主机授权不具备该能力；外部 PAT/OAuth 仍只向管理员发 Scope。记录继续按原加密 Store 和 revision/审批规则处理。
