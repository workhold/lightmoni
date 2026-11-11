# 设计与实施计划

沿用 registerManagedMachines 的安装生命周期、主机 busy 和同记录条件更新。抽出只读轮询 helper，使用单调时钟界定总预算、可取消延迟；默认最多等待 60 秒，间隔 1 秒。不重复 SSH、不重签身份、不撤销成功激活授权。每轮重新读 enrollment、runtime 和 heartbeat，root 模式重新查询在线签名执行通道，提交前沿用 running/resolved_at 条件保护。

固定原因区分激活未确认、运行身份心跳未确认、签名通道未就绪、SSH 超时/取消/连接错误和平台确认失败，复用 receipt.error/stages，不增加字段。人工结束文案说明现有撤销行为，不更改该行为。

先编写 SDD 与失败回归，再实现、跑关联生命周期测试和 runtime/web 类型检查、记录验收。代码经 GitHub 功能分支 PR 合入；本轮不假称生产已升级。架构同步不适用，理由见 spec.md。
