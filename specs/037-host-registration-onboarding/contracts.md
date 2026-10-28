# 契约

- 既有 POST /api/v1/machines 与 GET 管理员摘要增加 `sdk_environment:{LIGHTMONI_MACHINE_ID:string,LIGHTMONI_MACHINE_NAME:string}`。这不是认证凭据，不改变成员投影。
- 主机 name 最大 128 字节，不允许控制字符；id 仍由中心生成。名称后续修改只更新新配置，现有进程环境不会自动变化。
- POST /machines/:id/credentials 扩展 password retention=temporary|managed；省略保持 one_time。managed 需要 confirm_managed=true；密码 managed 默认86400秒。其他范围及清除策略见 plan。无 secret 返回。
- `active_reusable_ssh_credential_count` 区分可执行安装的凭据；旧 active_ssh_key_count 等字段保持。安装/卸载拒绝 one_time 密码。
- LIGHTMONI_MACHINE_ID / NAME 映射 lightmoni.machine.id / name；显式 resource 对应键优先，空环境忽略，超长/控制字符环境忽略，不影响 SDK 原有上报。ID 最大64字节、名称128字节。
- Agent install 可选参数携带公开 machine metadata；配置保存 machine_id/machine_name，默认空，旧安装和已有 identity 不变。名称引号、空格、Unicode 不得导致脚本注入。
