# 契约

DELETE /api/v1/ops/resources/:id 使用现有 revision 与管理员权限。返回 deleted=true, remote_data_deleted=false。仅有确认 removed 的实例可注销登记；从未部署且无实例可直接删除。保留历史状态不把 unknown 改为成功，不调用远端删除。

GET /api/v1/ops/resources/:id/storage 仅管理员，支持 application/website，返回 resource_id、layout_version=1、standard_root、instances；每项含集群/机器/实例身份、状态、observed_at 与 storage（没有回执时为 null）。所有实例包括退役记录，offset 按20项分页，next_offset=null 表示结束；路径为上次 Agent 实际回执，不代表当前实时核验。网站 storage 仅包含该网站的分组、网关根、current/nginx.conf 和版本信息，不含其他网站正文、环境或证书秘密。

storage.layout_version=1，instance_root/state_file 与 mounts；挂载记录包含 container_id、service、type、source、target、read_only、volume。gateway 另含 current、config_file、version_root、sites[] 的 website_id/fragment_id/root/public_dir/certificate_dir。Docker volume 实际路径取 inspect.Mounts.Source，不假设 Docker data-root。

既有受管根、实例ID、配置摘要目录和 Compose 项目命名保留。新建同名应用产生新ID，不自动接管删除登记后留下的数据；备份/恢复与迁移需要独立明确操作。
