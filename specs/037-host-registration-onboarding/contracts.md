# 契约

- 既有 POST /api/v1/machines 由中心生成 `id`，`name` 由用户填写。GET 列表/详情返回既有 `id/name`；PUT 可改 `name` 但不能改 `id`，同名主机允许存在，以 ID 区分。不新增 `sdk_environment` 或主机环境配置。
- 主机 name 最大 128 字节，不允许控制字符；id 仍由中心生成。名称后续修改只更新新配置，现有进程环境不会自动变化。
- POST /machines/:id/credentials 扩展 password retention=temporary|managed；省略保持 one_time。managed 需要 confirm_managed=true；密码 managed 默认86400秒。其他范围及清除策略见 plan。无 secret 返回。
- `active_reusable_ssh_credential_count` 区分可执行安装的凭据；旧 active_ssh_key_count 等字段保持。安装/卸载拒绝 one_time 密码。
- SDK、Agent 配置和安装脚本不新增主机变量读取或资产元信息参数，保留此前契约及 Agent 自身身份。
