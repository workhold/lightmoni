# 实现计划

1. 固定账号矩阵、helper 协议和双组件同包生命周期。
2. 安装器与维护器统一非 root Agent unit、可选 root helper unit、独立任务账号及 root 私有 helper 配置。
3. Runtime 分离遥测与任务循环，普通 TaskRunner 仅在 helper 运行，独立任务 UID；常驻进程拒绝 UID0。
4. Center/Web 使用非 root Agent 心跳和独立 helper 签名确认完整模式，更新操作文案和脚本能力状态。
5. 功能检查、构建、文档与 Doca 同步回读，提交 GitHub PR，列出未验证的生产范围。
