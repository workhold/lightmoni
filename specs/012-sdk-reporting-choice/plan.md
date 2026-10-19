# Implementation Plan

## 设计

1. 复用 011 已实现的 TypeScript/JavaScript、Python、Ruby 连接层、环境构造函数与现有 OTLP exporter，不新建协议；Go/Rust 代码保留但暂不发布，PHP SDK 移除。
2. 将凭据解析收敛到选定模式：direct 读取 data key 和 legacy alias；agent 读取 local token；auto 保持原有两类来源和选择逻辑。错误的 mode 在读取秘密前拒绝。
3. 接入页默认 direct；两种 mode 继续各自保存 endpoint。页面统一“平台 / LightMoni Agent”术语，说明节点采集独立于 SDK 路由。
4. 生成环境块时显式清理旧变量（含 `_FILE` 和 `LIGHTMONI_KEY`），只输出当前路径的必需字段；Agent local token 作为可选配置说明，不导出假的占位令牌。
5. 为 direct/agent 加配置隔离 fixture 和本地 HTTP 收据检查。检查所选来源冲突仍报错；不重做 011 中 auto 的全部矩阵，也不将未运行语言标记验证通过。

## 兼容性

SDK 缺省 direct 与旧显式构造保持不变；仅接入页初始选项从 agent 改成 direct。用户明确选择 agent 仍使用原地址和 local token。模式切换不修改保存到中心的连接设置。读取秘密的变化仅限于忽略显式未选路径，auto 原有校验保留。

## 影响范围

- 当前三种发布 SDK 的环境连接配置入口；TypeScript 发布 dist 随构建更新。
- SDKSetup、DataPage、sdkExamples 与对应单测/页面验证。
- SDK 总览和 011 相关需求交叉引用；新增本轮验证记录。

## 验证

使用可用的 Node/TypeScript、Python、Ruby 工具链进行真实 direct/agent 配置和请求验证；Go/Rust 仅保留后续支持记录，PHP 不再构建或验证。运行 Web 类型/构建检查及 SDK 接入页面验证；runtime 回归确认 Agent 转发路径未被破坏。最终同步 main、审查 diff、提交 PR。
