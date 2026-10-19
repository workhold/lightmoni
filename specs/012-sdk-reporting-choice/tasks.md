# Tasks

- [x] T001 先冻结规格、设计、契约与非目标。
- [x] T002 当前发布 SDK 的显式模式只读取所选凭据；保留所选来源检查与 auto 兼容，并记录 Go/Rust 后续支持范围。
- [x] T003 接入页默认 direct，保留两模式和独立地址，更新链路/凭据/容器提示。
- [x] T004 环境示例清理遗留变量，正确表达可选 local token，更新当前三种发布 SDK 说明并移除 PHP。
- [x] T005 添加配置隔离和真实收据检查，覆盖失败不改投及所选秘密仍校验。
- [x] T006 运行相关 SDK/runtime/Web 检查并记录真实证据与缺失工具链。
- [x] T007 同步远端 main，完成最终审查，推送分支并创建待审核 [PR #13](https://gitea.heyphp.com/lightmoni/lightmoni/pulls/13)。

- [x] T008 移除 PHP SDK 源码、示例与发布入口；Go/Rust 源码保留并标为后续支持，当前仅发布 TypeScript/JavaScript、Python、Ruby。
- [x] T009 复验 API 旧包访问限制、发布包校验清单和三语言双路径桌面/窄屏页面。
- [x] T010 按用户要求安装本机 Go/Rust 工具链，补跑现有原生与 HTTP 场景测试并记录结果；保留后续支持的发布范围。
- [x] T011 修复 Python 对 Connection: close 响应的读取，补充真实 ACK、截止时间和响应大小限制回归检查，并复验 Go 启动的实际 Agent 集成。
- [x] T012 拒绝截断的 Content-Length/chunked 响应，确认批次不被误确认、既有规则不被覆盖，复验 Python 与 Go→实际 Agent 集成。
