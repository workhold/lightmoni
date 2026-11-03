# 最终验收

新版应用卡片、网站列表、分节编辑、主题及响应式布局已通过PR #82上线，受管未知作业核对入口和主机互斥修复分别经PR #84/#85上线。当前中心镜像为`docker.heyphp.com/lightmoni/lightmoni:20261103-1bfd49c`，与latest同为索引`sha256:0991b9bb0cf29369406971d844435563f9f7b44c10cb531b9edbea7b5b533eb2`。本次仅交付主机部署资产、设计和证据，未变更中心/Agent源码，不另建同源码镜像。

- 维护作业由任务中心正常界面生成、逐字核对完整代码并批准一次：计划`d337e59e-f768-4040-9c2f-4d4556008a79`、作业`39bcef47-7b46-48cc-a8e8-99cb7734523e`，既有script.elevated.v1、真实root、绑定主机与Agent、Node解释器；结果succeeded/script_succeeded。此前两次批准遇正常任务互斥而未创建执行；未取消其他任务、重放旧任务或绕过锁。
- 审阅代码SHA256为`89ed13cf8de87c84a13b3325b65fcdae15afedcda682e1ceab0af3b625f40efc`，安装后防火墙脚本SHA256为`1b4f4272e0dc81dcf7332efcd19c6bc4af4aefe388790fd7c2d9f4611c0a8095`，root所有、0700。原配置保存在目标主机root私有目录。直接运行幂等脚本，未停止或重启Docker及防火墙依赖单元。
- 从panel外部主机检查49.232.14.169的20000/20001/20002，三个均TimeoutError；维护前20002匿名/v2/为200，维护后已阻断。目标主机内网172.21.0.16:20002/v2/仍200，逐端口iptables精确规则均存在。
- 最新独立验证使用正常DNS与可信HTTPS：abc和registry-demo均解析49.232.14.169，Demo页面200且标记正确，Registry匿名401/认证200；不可变镜像清单`sha256:c3fae4a7ce6af19b368ecef562446e251ed57c6b32386f96e91893b819cf1187`返回200且内容摘要一致。未使用固定IP覆盖，未打印认证信息。
- 新签名受管inspect/apply已成功；原unknown/executor_http_502及其人工核对审计保留，未核对未知root作业为0。升级仅变更中心镜像，16个其他容器与业务计数保留；最终SQLite备份完整性ok，目录0700、文件0600。
- CUA实际回读生产应用与网站页、保存并查看画面：四个应用在观察时均运行，三个网站已发布并显示HTTPS。1728px页面无横向溢出；实际Demo按钮请求成功。未触碰用户另一个尚未保存的网站表单。首次验收因Mac锁屏未执行原生200%；用户解锁后已补完原生Chrome200%及键盘检查，证据见../087-panel-ui/evidence/native-200-keyboard.json；先前模拟放大仍按实际方法标注。
- Doca与仓库第86章的现有网络段落同步：只扩充当前后端端口集合和精确热更新说明。保存后seq949逐字回读一致，总览原生图10节点/8边与SDD089完整数组完全一致，端点有效；无图块写操作。见evidence/doca-readback.json及[在线基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)。

维护资产`node --check`、`sh -n`、嵌入脚本与本地文件及摘要一致性、JSON解析和git diff --check通过。中心源码未再变更，沿用最终13文件368/368定向测试、两架构各43项成品检查和各10/10真实编译后签名作业回归；不重复无关测试。

安全的结构化证据保存在evidence；生产截图保存在忽略目录`.local-dev/image-release-089/`（final-applications.png、final-websites.png、demo-after.png、maintenance-success.png）。凭据、数据库及master.key只保留在服务器root私有备份中，不进入仓库。
