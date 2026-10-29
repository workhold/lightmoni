# HLD、LLD、契约与任务

## HLD / LLD

`managed_machines.id` 是唯一受管主机资产ID；`agents.id` 标识Agent安装身份，两者不可混同。Agent只能通过主机管理的固定部署流程接入。中心内部签发enrollment必须给出machine_id，保存到enrollment服务端记录；所有公开请求不能注入该字段建立关系。

兑换/激活/注册/心跳依次核验预约存在、主机存在、绑定未被其他Agent占用及身份有效；SQLite事务确保先注册后安装回执也只关联原资产。注册和心跳不创建资产，不按hostname、Agent本地host_id、出口IP做匹配，不改变用户命名或SSH配置。控制面只使用独立control凭据，保留独立data凭据用于遥测，SDK Key仅作为SDK数据面凭据。

没有预约的旧身份/token无法继续控制面接入；不实现历史建档、自动迁移、手动合并或旧共享Key降级。不删除旧数据库数据。重新接入通过已登记主机的新部署计划；旧受管程序存在时仍遵守不覆盖安装的安全检查。

主机摘要可通过关联Agent提供observed_hostname，不赋予SSH信任。登记须填写SSH目标地址/端口/用户名，可信指纹与凭据可稍后配置；修改连接须提交完整目标，名称可单独编辑。删除活跃身份所在主机被拒绝，先移除身份；卸载/移除不删除资产。

## 接口与界面契约

- POST /agent-enrollments：停止独立签发，409提示从主机管理部署。内部issueEnrollment强制已登记主机预约。
- enrollment兑换/激活与Agent控制请求：要求主机预约和独立身份；缺失时明确错误，不创建资产。
- POST /machines/:id/agent-link：移除能力（410），不接受手工配对。
- GET /agents：仅返回真实关联身份，补machine_id/machine_name，不泄漏SSH地址/秘密。
- GET /machines：唯一管理员主机列表，补observed_hostname。PUT /machines/:id可修改名称或完整连接，id不可改。
- POST/PUT /machines 只接受 direct_ssh，未指定连接方式时新建默认 direct_ssh；不再新增 manual_script、bastion 或 ssm 接入。新增连接凭据只接受 ssh_key/password，不保存“手动脚本凭据”。历史数据库记录不自动删除，不恢复其旧接入能力。
- 前端不再创建node:行，不提供独立签发/脚本安装/手工关联入口。成员只读主机投影；保留管理主机、任务与卸载所需入口。

## 工作清单

- [x] 用户最终确认后更新规格与架构边界
- [x] 强制服务端主机预约、独立控制凭据、移除旧路径
- [x] 唯一主机UI与名称/连接编辑
- [x] 定向/回归测试与本地实际验收
- [x] 仓库系统设计与Doca正文/原生图同步回读
- [x] 推送并更新GitHub PR（正式 PR16，验证与交付见 validation.md）
