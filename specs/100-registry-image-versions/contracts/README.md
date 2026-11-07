# HTTP 与执行契约

管理员限定，统一 no-store：

- POST /api/v1/ops/private-registry/images/query：{cluster_id, repository?, after?} → 202 PlatformRun；task=registry.inspect，operation=inspect。repository 未指定时返回 repositories；指定时返回 repository、versions[{tag,digest,used_by[{id,name}]}]、next。每页 100，next 为末标签。
- POST /api/v1/ops/private-registry/images/cleanup：{cluster_id, revision, confirmed:true} → 202 PlatformRun；task=registry.cleanup，operation=cleanup。所有镜像，不受筛选影响。
- GET /api/v1/ops/runs/:id：沿用状态和 result。清理返回 deleted、retained、failed、skipped、deleted_tags、failures（有界明细）、partial；verified=false 时为 failed，未知执行结果沿用 unknown。

可信 config 仅中心生成：registry endpoint、cluster_id、machine_id、aliases、references、usage_hash。新能力 operations.platform.registry.v1；只有所登记部署所在机器可领取，领取时引用与身份再验证。浏览无需修改任何应用配置。

限制：catalog 最多 1000 镜像；清理最多 10000 标签/manifest；响应体最多 1MiB；索引最大深度 8；单请求 15s；单作业受现有执行超时约束。超限明确失败，不把截断数据当完整结果。版本浏览按标签排序，不把标签排序当发布时间。

Registry 接口依照 https://distribution.github.io/distribution/spec/api/ ，manifest Accept 包含 OCI/Docker manifest 与 index；删除按 digest，保留引用摘要及索引子项，不调用 blob 删除或在线 GC。
