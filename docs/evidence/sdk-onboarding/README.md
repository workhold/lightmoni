# SDK 接入验收证据

规格、设计与完整边界见 [009-sdk-onboarding](../../../specs/009-sdk-onboarding/validation.md)。

- `verification-1.json`、`verification-2.json`、`verification-3.json`：连续三次真实页面/API/ClickHouse 验收，无 pageerror。
- `sdk-demos.json`：实际 Go、Node.js、Python 在带密钥与无密钥下共六组运行与身份读回；Rust 无 Cargo，未声称实机通过。
- `motion.json`：首屏/认证切换实际时间帧与创建 loading/结果。
- `deployment.json`：本地 18380 实例健康、登录、原有 1 用户 / 5 大盘 / 1 节点保留，四语言包可用，默认豁免空，构建字节与 Python 包修复匹配。

截图和三帧记录位于本地 `artifacts/screenshots/docs/evidence/sdk-onboarding/`，含空下拉、失败保留、新建选中、无密钥推荐、豁免管理、390px、200% 等效视口和三处动效；媒体不纳入源码。
