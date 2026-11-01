# Data Model

ops_application_logos: resource_id 主键；revision 正整数；content_base64（无 Logo 时为空字符串）、sha256、updated_at、updated_by。存储中心既有 SQLite，无新文件目录或云服务。移除保留独立递增版本防止并发覆盖；删除应用登记时移除该行。

PlatformResource 公共投影为 application 增加 logo_url（有上传内容时）与 logo_revision（未编辑为 0）；内容不进入 spec、ops_platform_revisions、Agent payload 或概览正文。历史模板记录通过 source.template_id / role 获取本地品牌图。

PNG 限制：完整签名、IHDR/IDAT/IEND、块 CRC、RGB/RGBA 8bit、无交错、宽高 1..512、完整解压行和过滤类型、256 KiB；移除非显示元数据后内容寻址。错误不回显文件内容。

应用 spec 新增 configuration_mode=form|yaml 展示意图。container 的输入字段 configuration_yaml 只参与解析，持久化前删除；compose 存规范化对象。保存高级配置后端口仍进入既有 ports 元数据，交给既有托管分配流程，不改变 Agent payload 协议。公开环境值始终遮罩，原始 YAML 和注释不落库。
