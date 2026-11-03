# Contracts

## Catalog
POST /api/v1/ops/catalog/:id/install 新增可选domain和request_id；deployments省略时自动选择在线且资源足够位置，非网关默认宿主端口0。有domain要求HTTP端口、托管区域和可用证书或ACME账号。创建前验证先决条件；返回201、公共应用、关联安装状态和部署错误。相同管理员/模板/request_id返回原应用，不重复创建。
提供管理员确认的quick-install-retry动作；重试复用关联资源，不绕过unknown。

## Entry/DNS
入口名自动生成，高级设置可选区域。新网站dns_record_mode只接受cname，省略同样为cname，address拒绝。入口A/AAAA与网站CNAME独立所有权与回读；无权重的默认CNAME不要求权重套餐能力。

## Registry
仅一个固定机器上的系统部署，新增集群副本或切换存储位置返回registry_data_migration_required。旧多位置配置不自动删除或迁移数据，须先迁移后再调整。只发布registry→5000，compose仅一个registry服务与数据挂载，/v2/标准推送和拉取。删除hub-cache/origin-cache端点和独立缓存服务；现有私库数据保留，不删除原缓存磁盘目录。集群镜像复用从已有系统仓库读取匹配发布源，Hub镜像沿用Docker本地镜像复用与既有来源代理。额外仓库由用户在商店自行部署。

## SDK
Node/Python/Go/Java/.NET/PHP/Ruby/Rust后端按research.md变量提供环境默认，显式配置优先；浏览器入口维持显式配置。标签记录服务与资产关联，不授予平台权限。SDK Key禁用继续生效。

## Errors
无在线位置、域名未托管、缺少ACME账号、模板无HTTP端口、域名冲突在创建前拒绝；后续失败写入阶段，保留引用。应用运行不等于HTTPS/DNS可用。
