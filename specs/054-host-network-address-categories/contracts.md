# 显示契约

- 保持HostNetwork、HostNetworkAddress与后端响应原样；从addresses中interface/address派生范围与接口角色，不把private_ips/public_ips混合聚合当主机可用地址。
- 接口角色按明确名称保守识别容器/虚拟机内部网络、VPN/隧道及普通/未识别接口；不能用172.16/12或10/8直接判Docker，也不把所有br*、bond/VLAN隐藏。该角色仅是显示推测，不是OS设备类型探测。
- IP显示范围独立于接口角色，区分public/private/shared/loopback/link_local/special；无效值不升格为公网。IPv4映射IPv6按其IPv4范围处理。
- 登记SSH域名不解析、不与网卡自动匹配；显示IP入口只表示管理员保存的目标。SSH端口保持独立，IPv6格式保留方括号。
- 私有/本地/特殊来源只在详情展示，不因scope或source_kind=direct推断其为真实主机出口。公网来源也仅标“到平台的公网来源”。出口说明明确证据限制，不填造公网/内网出口值。
- 详情默认展示有用地址；其他地址可展开，保留网卡名、地址、IP版本、范围、分类依据及观测时间。不删除后端数据、不改变SDK/Agent采集。
