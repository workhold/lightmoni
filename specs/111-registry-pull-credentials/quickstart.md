# Validation guide

1. npm --prefix sdk/typescript run build；根npm run typecheck。
2. runtime中node --import tsx --test --test-concurrency=1 test/registry-credentials.test.ts test/registry-auth.test.ts及相关部署/代理/升级回归。
3. 用一次性HTTPS鉴权Registry实际推送测试镜像，证明匿名失败、正确凭据拉取成功、错误密码失败、结束临时目录不存在。
4. 本地隔离HTTP管理服务运行新界面脚本，检查创建/刷新/编辑留空/保存失败/应用绑定/撤销/中英文/窄屏；保存并查看截图。
5. 回读Doca目标段落与原生图，核对无关块/图保留。
6. GitHub PR合入main；双架构镜像及Agent包发行验证和Registry摘要回读记录到validation.md。
