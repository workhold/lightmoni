# 接口契约

## 主机登记与编辑

`POST /api/v1/machines`、`PUT /api/v1/machines/:id` 不接受 `host_key_fingerprint`、`host_key_public_key`、`host_key_observed_at`、`host_key_status`、`ssh_target_generation`，出现任意字段返回 400。主机名称、地址、端口、用户名及既有受支持元数据保持原约束。凭据使用原独立 API，有限/永久确认契约保持。

管理员主机响应只读增加：

| 字段 | 含义 |
| --- | --- |
| host_key_public_key | 实际 SSH 握手公钥，OpenSSH `<算法> <base64>`；首次连接前为空 |
| host_key_fingerprint | 同一公钥的 SHA256 指纹；首次连接前为空 |
| host_key_observed_at | 首次记录时间，ISO8601；首次连接前为空 |
| host_key_status | observed 表示已自动记录；unconfigured 表示尚未记录；已有指纹待补全公钥可为 confirmed |
| ssh_target_generation | 平台维护的单调目标版本，参与检查、租约及计划 revision |

主机名称及登录用户名更改保留同一 SSH 端点公钥，地址/端口改变清空公钥、指纹及时间；影响目标的编辑递增 generation，删除旧检查并取消待审批安装/卸载计划。AI 返回清空上述公钥/指纹/时间；成员不获得 SSH 元数据。

## SSH 操作

无需额外身份发现或确认 API。预检、终端、部署/卸载使用同一服务端验证器，在实际握手获取公钥并进行原子首次记录或匹配。未记录公钥不会单独产生能力禁用原因；原有权限、凭据、互斥和节点关联条件保持。

公钥变化返回现有 `host_key_mismatch`，拒绝登录认证或远端操作且不覆盖已保存身份。预检响应形状保持，首次记录后使用新 revision；安装与卸载仍从预检生成持久化计划并审阅确认。终端仍受同源、登录、有效凭据与会话限时约束。
