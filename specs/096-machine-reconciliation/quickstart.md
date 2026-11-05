# Validation Guide

前提：Node >=22.19、runtime 和本地 TypeScript SDK 依赖可用。

1. npm --prefix runtime run typecheck
2. cd runtime && node --import tsx --test --test-concurrency=1 test/reconciliation.test.ts test/agent.test.ts test/platform-api.test.ts test/platform-executor.test.ts
3. npm --prefix runtime test
4. 管理员读取 /api/v1/machines/:id/reconciliation 查看三类资源；连续配置、部署及目录证书分别展示具体目标。注入可控失败后推进时间，检查无重复活动任务且最终一致。
5. 核对清单不含证书私钥、环境变量、密码或文件正文；Doca 以最新保存版本回读文本及新增原生图，保留既有图块。
