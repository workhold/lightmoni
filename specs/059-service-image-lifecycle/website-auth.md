# OpenResty网站密码访问

2026-11-01，设计提案，尚未实现。对齐1Panel网站“密码访问”的全站/按路径能力，采用原生HTTP Basic Auth，覆盖普通反向代理与静态网站；Registry作为首个协议兼容用例。OAuth/SSO、验证码、外部auth_request和repository级token权限不在首版。

## 1. 配置与界面

网站配置增加“访问鉴权”分组，默认关闭以兼容旧网站。开启后选择账号组并填写realm，展示覆盖的域名、路径和部署集群；账号组可管理多个用户名、启停和重置密码。密码写入后不回显，保存/刷新只显示已设置、更新时间和待发布状态。此账号不是LightMoni登录账号，不复用管理员密码。

全站配置位于website.spec.auth={mode:off|basic, credential_set_id, realm}；locations[].auth.mode=inherit|off|basic。inherit为默认，off显式免登录，basic覆盖账号组/realm，使用现有location匹配和优先级，不再引入第二套路径匹配器。空basic账号组、非法realm/用户名、重复用户、删除被引用组和不支持的组合拒绝保存。网站全局配置跨集群相同，内网免登录优先使用独立监听/入口而非依赖公网请求头绕过鉴权。

界面显示每路径最终策略及继承来源，off或从basic改off显示受影响域名/路径并通过发布确认。账号变更生成新版本，引用网站显示待发布；用户可以发布受影响网站，逐集群成功/失败分别显示，不能将只保存密码或部分集群成功报告为全部生效。

## 2. 凭据与发布

中心只接收一次性write-only密码，在宿主端用受支持的bcrypt算法产生htpasswd哈希，参数/用户名/总用户数有界；哈希再经现有加密存储，不保存可回显明文，也不把哈希当普通公开配置。Agent/OpenResty镜像必须实际验证crypt/bcrypt能力，不因NGINX声明支持crypt就假定所有镜像均支持。

AuthCredentialSet有稳定ID和单调revision；发布冻结账号组版本和整个鉴权配置，生成不可变凭据材料hash。现有网站部署载荷绑定site/cluster/gateway Agent、website revision、credential_set_revision/material_hash和有效lease；只向确切入口Agent分发。网关将版本文件以0600或仅受限worker组可读权限写入私有版本目录，容器只读挂载，不接受用户指定任意auth_basic_user_file路径。

配置和凭据文件作为完整网站bundle一起nginx -t、原子切换、reload、验证；失败保留上一完整配置，绝不退化成auth off来恢复健康。新节点及网关换机获取相同冻结版本。旧Agent没有能力时阻止鉴权发布并提示升级，不静默忽略。重置/禁用/删除用户仅在目标网关确认新bundle后生效，明确展示未同步集群；unknown先inspect。回执仅返回版本/hash/状态码等白名单，不返回用户名口令头、哈希、文件正文或原始命令。

## 3. 编译、安全与兼容

编译器根据最终策略生成auth_basic与受管auth_basic_user_file；off生成显式覆盖，继承按原生NGINX语义且与页面预览一致。已有IP allow/deny和Basic默认同时满足（satisfy all），不默认以“任何私网IP”免密。可信代理来源另外配置，X-Forwarded-For不能自行成为鉴权豁免。

鉴权控制指令由结构化编译器拥有，server/location自定义片段不能覆盖auth_basic、auth_basic_user_file、satisfy或插入旁路。受保护location不得通过rewrite阶段return、CORS直接OPTIONS 204或内部跳转绕过：编译器重排至鉴权后执行，无法保证的组合明确拒绝。HTTP入口只重定向HTTPS或拒绝，不在明文链路挑战并接收公网密码。平台保留的验证路径仅限受控内部探测，不提供可读取业务内容的公共免登录旁路。

网站前置Basic的Authorization默认在代理上游前移除，防止把网站密码发给业务；结构化头/自定义片段不能偷偷恢复它。依赖上游Bearer/Basic的业务需展示单一Authorization头的冲突，首版拒绝同时使用不兼容前置Basic组合，而不是承诺同时登录。Registry模板后端采用信任边缘模式，适配此行为。所有访问/错误/安装/AI预览均不含凭据头。

受保护路径禁用普通响应代理缓存，避免通过免登录路径/内部跳转读取缓存内容；不只依赖客户端是否带Authorization判断安全。401/403不触发摘除健康后端或网站DNS；配置发布的健康验证包含匿名401及有效凭据访问两部分，后端健康检查使用独立受限探测。凭据组和材料hash不出现在可分享预览、URL、PR正文或运行日志。

Registry模式增加pull/push账号组：GET/HEAD走pull组，写入POST/PATCH/PUT走push组，默认禁DELETE，push组用户也必须在pull组；这是整个端点的权限，不能宣称repository级隔离。普通网站仅需单账号组，不把Registry特例带进通用页面。

## 4. 契约与后续验证

沿用website保存/预览/发布接口增加auth与location.auth；预览仅返回模式、realm、账号组ID/版本、继承来源及受影响范围，不返回hash或密码文件。账号组有独立管理员CRUD与revision，秘密输入字段只接受写入。保留既有网站、域名范围及逐集群发布授权，保存草稿不改变线上鉴权。

真实OpenResty验收：全站开启、路径inherit/off/basic、精确/最长前缀/正则、静态/反代、错误密码、禁用/重置、多用户、非TLS公网拒绝、IP策略组合、CORS/return/内部跳转旁路、敏感头移除、受保护缓存关闭、旧Agent拒绝、换机与部分失败保留旧版、匿名401不错误摘除网站。另用真实Docker CLI完成Registry login/push/pull及受限账号组验证。当前不得将文档检查作为这些功能已通过的证据。
