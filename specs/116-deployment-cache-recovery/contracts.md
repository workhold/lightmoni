# 契约

- image_cache 仍为中心冻结的 version=1 策略，使用现有精确 origin_host、私网 endpoint、origin_mode、allow_upstream；不接收浏览器/环境临时覆盖，不改变配置开关。认证镜像缓存命中不领取秘密；回源仍使用精确 registry/repository 授权与临时 DOCKER_CONFIG。
- 仍固定本机验证后的 image ID 与 pull_policy=never；缓存平台、清单/配置/层摘要、大小限制和禁止重定向继续执行。缓存不存在/不可用且禁止回源时失败，不能私自公网下载。
- POST signed jobs/:id/reconcile 请求结构不变，仍只接收 lease_id。响应 release_fence=true 仅额外涵盖经过冻结载荷与身份核验的未知只读平台观察；原状态保持 unknown，resolved_by 记录 executor ID，固定原因区分自动核对与人工处理。
- 原 mutable unknown、非平台任务、混合/多个动作、摘要或目标不匹配均不自动解除。不接受 ordinary Agent 或浏览器伪造恢复。释放后新观察重新走签名任务/许可/本机锁，只有当前内容及健康回执才能恢复 ready。
