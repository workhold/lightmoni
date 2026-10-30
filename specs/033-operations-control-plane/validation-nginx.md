# Nginx扩展与开发页面修复

2026-10-29，补充到同一SDD及PR #15。变更涉及网站配置模型、共享编译和只读预览协议；架构同步适用。

## 真实开发页面

用户浏览器为 `http://127.0.0.1:18880/operations?tab=website`。发现后端进程在08:27启动，新构建为09:48，前端已更新而进程仍持有旧路由。保留原监听、数据目录、ClickHouse和运行时凭据后重启，原会话无需重新登录；回读当前页面不再出现“not found”。没有创建测试用户/节点或向用户机器发布网站。

后续仍会遇到旧后端时，页面提供明确的更新/重启后端提示。Node进程加载dist后不会因重新构建自动更新；开发验证必须同时核对实际运行实例，不能只检查文件和隔离夹具。

## 新能力

共享 `runtime/src/operations/nginx.ts` 承担中心/Agent共同校验与编译，网站保存nginx与locations。覆盖多路径/正则顺序、手填或服务发现后端、权重/备用/失败隔离/负载策略、URI处理、Host/SNI/TLS、WebSocket、超时/缓冲、头部、CORS、ACL、上传/速率/连接限制、缓存、站点TLS/HTTP2/Gzip/日志与静态SPA/index/缓存。server/location自定义片段受上下文和执行指令限制。

网站详情提供管理员只读脱敏配置预览；无job、no-store、不含PEM及敏感头值，片段隐藏，validated=false。发布仍使用完整包真实nginx -t及现场HTTP/TLS验证，检查失败保留当前配置。

## 代码与现场验证

| 检查 | 结果 |
| --- | --- |
| Runtime全量 | 491项，470通过、21按环境跳过、0失败，127.05秒 |
| API/工作负载/执行器/Nginx最终定向 | 31通过、0失败、0跳过，2.62秒 |
| 根目录类型检查与构建 | 通过；最终Web和Runtime构建另通过 |
| 生产bundle导航与首页 | 13项通过 |
| HTTP页面夹具 | 13项通过 |
| 真实SQLite页面 | 新增多路径保存/编译与390px英文双路径长表单，每轮9项，连续三轮通过，见ui-live/nginx-run-1/2/3.json |
| 真实Linux host OpenResty | 两项通过、0失败、0跳过，2.94秒 |

默认回归跳过项不计为通过。真实OpenResty在一次性Linux Node QA容器执行，与网关共享Docker host网络，复用 `validation-workloads.md` 方法；临时镜像 `lightmoni-ops-033-nginx-qa:local`，固定OpenResty镜像与前轮相同。

现场检查实际HTTP结果：静态HTML/TLS/reload与空服务503；`/api/`去前缀并保留查询串、`/legacy/`替换到`/v2/`、原URI保留、精确308、正则路径、请求/响应头与隐藏上游头、CORS预检204、WebSocket101、IP拒绝403、上传413、未匹配404。缓存实际MISS→HIT，Authorization和Cookie请求均BYPASS且真实访问后端；每IP限流实际429。故意提交未知指令使nginx -t失败，旧网关仍能正确转发。

单元/集成另检查同协议源站、URI和保留探活路径、重复规则、CORS凭据与通配来源冲突、片段引号/转义/include/动态代码/上下文逃逸、服务路径独立503和嵌套服务引用删除保护、预览权限/脱敏/无部署。SPA首页必须存在；前缀URI替换要求匹配路径末尾斜杠，正则只保留URI；缓存禁止与关闭响应缓冲同时启用。

## 界面与证据

新表单沿用Ant Design，以路径重复项及折叠高级选项控制信息量；每条规则可上移/下移。主任务在用户当前登录的18880页面打开并填写未保存示例，确认新控件可操作，未提交业务资源；390px时页面和modal正文均无横向溢出，最后恢复原视口并关闭示例。

独立只读视觉评审实际查看桌面和390px截图，未见阻塞问题，无评分；静态截图不能证明全部滚动/多路径操作或英文适配，随后用真实后端交互脚本补测双路径创建、修改、保存/读回、英文390px缓存/限流长标签及内部滚动，标题/关闭/保存保持视口可见。窄屏通过现有“Collapse navigation”收起导航后操作，没有强制点击绕过遮挡。

媒体遵循仓库规则存放于 `artifacts/screenshots/specs/033-operations-control-plane/evidence/nginx/`（当前用户页面）及 `evidence/ui-live/nginx-english-390.png`（QA画面）；结构化报告可提交，媒体忽略。

## 架构与支持边界

仓库 `docs/system-design.md` 的33.9、33.11和原生图对应标签已同步。[Doca基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)定点修改33.9、图中的网关标签并追加33.11两块，保存后seq776回读，正文、标题和11节点/14边完全匹配；节点ID/位置/尺寸/样式与所有边保留，未重建其他图块。见 `doca-nginx-sync.json`。

自定义片段不是任意全局nginx.conf或动态代码入口，镜像未编译模块的指令会被nginx -t拒绝；缓存是容器临时数据，容器替换可清空。目录/证书、云服务和生产网络验收范围仍按原validation.md，不把本轮本地Nginx验证当作真实云/CDN/公网ACME验收。
