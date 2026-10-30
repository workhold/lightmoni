# SDD 033 验证与交付记录

日期：2026-10-29（Asia/Shanghai）。分支：`codex/033-operations-control-plane`。交付：[GitHub PR #15](https://github.com/workhold/lightmoni/pull/15)，目标main，未合并。

## 实现与验收结论

本轮多路径与Nginx高级配置、用户实际页面404修复和最新验收见 [validation-nginx.md](validation-nginx.md)。本文原有三轮页面记录为首版验收，新能力的独立三轮记录为ui-live/nginx-run-*.json；Doca最新同步为seq776。

五个核心能力已接入真实管理 API、SQLite 加密资源和现有 Agent pull job/control lease：DNS 双平台；ACME/上传/自签及三类证书目标；Docker/Compose 应用；机器池、副本与健康发现；host OpenResty 网站。中心未引入 Docker socket 或第二控制通道。前端以五核心页签和基础设施抽屉管理共享资源，旧 `/services` 入口转向托管服务。

证书新增目标覆盖阿里云、腾讯云、火山引擎的 CDN 域名，以及指定 Agent 的目录和更新脚本。配置与发布分开，证书目标/续期的持续策略要求管理员明确启用；执行按不可变版本去重，unknown 不自动重放。云端真实账号及公网发证未执行，不能由本地协议测试代替。

## 回归与构建

| 检查 | 结果 |
| --- | --- |
| `npm --prefix runtime test` | 491项，470通过、21跳过、0失败，127.05秒 |
| `npm --prefix ai-runtime test` | 71通过、0失败，33.22秒 |
| `npm --prefix sdk/typescript test` | 18通过、0失败，32.19秒 |
| `npm run typecheck` | runtime、ai-runtime、web全部通过 |
| `npm run build` | SDK、runtime、ai-runtime、Web全部通过 |
| `git diff --check` | 通过 |

合计580项，559通过、21跳过。跳过包括Linux专属/旧systemd执行、需要外部ClickHouse和Go基线工具链的测试，以及默认未启用的Docker现场项；不计为通过。Docker现场另行显式启用，见下节。结构化计数见 [regression.json](evidence/regression.json)。构建存在依赖包已有的 `use client` 指令提示，退出码为0。

新增定向测试覆盖：全量资源引用校验与API分页、中心动作及真实Agent lease忙锁、加密请求快照/输入、关闭等待、独立领域收敛、角色撤销、DNS完整分页/64位ID/记录归属、云协议独立签名向量、ACME订单重启与同名TXT清理、不可变证书版本、逐目标结果、资源/端口事务预留、跨轮逐副本发布、离线/unknown和有界健康重建。

`platform-api.test.ts` 使用实际HTTP/SQLite/AgentJobRunner，完成真实自签密码学→私有租约载荷→目录落盘（私钥0600）和脚本读取临时证书/显式环境→回执版本；重复tick不再执行。另覆盖首次HTTPS发布自动签发所选证书后才派发网关包，普通job不含PEM。

## Docker和文件现场

完整步骤、镜像摘要、macOS host网络失败及Linux复验、清理记录见 [validation-workloads.md](validation-workloads.md)。

- 实际Docker单容器和Compose：1次通过，31.52秒。实际检查配置v1→v2、初始化文件用户修改、业务数据保留、字面量环境、inspect/stats/stop/remove。
- 实际Linux host OpenResty：1次通过，1.70秒。实际检查静态HTML、TLS指纹、版本重载、无健康后端503和停止。首次macOS localhost不属于VM host网络，探针失败并恢复，未计为通过；没有修改Docker Desktop全局设置。
- 真实临时文件系统/进程测试验证目录指针、非托管文件与符号链接边界、脚本不继承隐式秘密、不公开stdout/stderr、超时unknown与持久写锁。
- 只创建和清理本轮标签的QA容器/文件，没有部署用户远程机器，没有全局Docker prune。

## 页面与视觉验收

最终代码连续三轮执行两套浏览器脚本：每轮HTTP夹具13项、真实SQLite后端7项均通过，三轮均无page error。独立报告保存在 [ui](evidence/ui/run-1.json)、[ui-live](evidence/ui-live/run-1.json) 的run-1/2/3文件中。英文与390px无页面横向溢出，保存409和HTTP202业务失败均保留输入。

真实后端页面实际生成自签证书、保存并读回配置、解析Compose YAML、校验资源引用与SAN、验证脚本正文/环境脱敏及留空保留；该验收没有请求云、公网DNS/ACME或部署Docker。可复现夹具见 `runtime/test/fixtures/platform-ui-server.ts`；它自动创建临时SQLite，仅loopback固定QA身份，Agent不可登记、云fetch禁用、周期调度关闭。新增夹具另外完成一轮7项，见 [reproducible-harness.json](evidence/ui-live/reproducible-harness.json)。启动与清理步骤见 [quickstart.md](quickstart.md)。

构建后的生产bundle通过原导航/默认首页13项回归，新增运维入口合并与旧服务路径重定向断言，见 [navigation.json](evidence/navigation.json)。

按Oil UI完成桌面、窄屏、200%与动效截图/录像，并由独立评审读取实际截图；没有给出主观评分。修正长表单标题/关闭/保存失去视口、原始错误码难读、空版本和长版本干扰三项。最终长表单内部滚动后固定控件均在视口，主任务再次目视核对截图。明暗主题复用现有系统，截图中均有实际画面。设计说明见 [ui-design.md](ui-design.md)。

媒体遵循仓库规则放在忽略目录 `artifacts/screenshots/specs/033-operations-control-plane/evidence/`，包含certificates、websites、hook-form、certificates-200、interaction-motion和long-form-fixed-controls；报告可提交，媒体不混入源码。

## 架构同步

影响：全局资源/加密版本存储、DNS/ACME/云凭据边界、持续调度、Agent新动作、服务发现、网关部署拓扑和脚本/AI边界均有变化。

仓库更新：`docs/system-design.md`第33章；第26章标题标记新章替代其网站/容器部分，保留备份恢复说明。对应在线文档：[LightMoni系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)。保存后使用最新版本回读全文定位和目标块，逐块比较文本与原生节点/连线：

- 原有304块中303块完全未变，1个第26章标题按预期更新；原顺序保留。
- 原有8个原生图块全部逐字段保留。
- 追加23块；全部新增文本与原生数据匹配，架构图11节点、14连线匹配。
- 首次写入的首标题被服务端自动识别为列表，后续块插到开头；已定点恢复标题并移动新增块，最终章顺序、原文档标题和原有内容全部再次核对。
- 工具确认saved，最新回读seq775；证据见 [doca-sync.json](doca-sync.json)。Doca正文注明分支实现范围，没有声称已合入main或完成真实外部验收。

## 外部未验收与首版边界

- 未提供运行时云账号和测试域，没有执行真实阿里DNS/DNSPod写入、三云CDN上传/绑定或边缘传播验证；已实现固定官方端点签名、分页、上传/绑定/回读和独立协议测试。
- 没有执行公网ACME staging发证；本地覆盖实际账号/订单持久化逻辑与模拟CA/DNS协议生命周期。上线前应按quickstart在专用域和账号联调。
- 续期按证书实际寿命触发，首版没有ARI或完整自动失败退避；失败可人工issue/renew。到期提醒在页面和状态中提供，没有声称已发送邮件等通知。
- 托管要求机器之间已有可达网络；不提供overlay、共享存储复制或有状态应用的静默跨机故障迁移。DNS多地址和TTL不承诺即时故障切换。
- 任意管理员脚本具有Agent本机权限，无沙箱承诺。unknown的只读核对不会自动解除节点旧进程/daemon未知写锁，需按运维恢复流程检查现场。

## 交付

提交前已同步GitHub `origin/main`，当时与分支起点相同。只推送功能分支、创建面向main的PR；未向main直接推送、未合并、未向Gitea写入。
