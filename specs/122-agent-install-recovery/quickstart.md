# Validation

1. 在 runtime 运行 machine-ssh、install-release、machine-agent-lifecycle、agent-uninstall-script、machine-installation-recovery 及 races 测试。
2. 运行 runtime/web typecheck 与相关构建、shell syntax 检查。
3. 页面场景：reconcile 502 后 GET 成功可人工结束；GET 失败仍锁定；切换目标后旧读回不能覆盖新记录。
4. 仅在隔离 fixture 创建 20-docker-access.conf：预检 present → 显式恢复卸载 → 覆盖目录 absent、业务文件不变 → fresh 预检 absent。
5. 在 evidence/validation.md 记录命令、结果、限制与架构不适用理由。无线上清理、重装或发布隐含在本地验证中。
