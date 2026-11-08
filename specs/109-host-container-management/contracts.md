# 契约

- GET container-jobs列出当前主机最近50条已脱敏任务；GET /:jobID返回绑定该主机/Agent的任务与已验证结果。
- POST container-jobs：{request_id,confirmed?,action}。action.kind固定host_docker；operation为inspect/images/create/rename/update/start/stop/restart/remove/prune_images。只读不需confirmed；变更须confirmed=true，且拒绝未知字段。人工管理员Cookie会话，拒绝Bearer/API身份；异步读取body后重查会话。
- inspect接受64位container_id；返回非敏感详情及revision。rename/update/start/stop/restart/remove须expected_revision。remove须force与remove_anonymous_volumes布尔选项，均默认false。
- create接受name、image_id（sha256:完整64位）、command字符串数组、restart_policy、memory_bytes、nano_cpus、ports、named_volumes、start。无环境变量、任意标签、特权、host namespace、自定义endpoint、绑定宿主路径字段。
- images按完整镜像ID稳定排序，每批最多100项，可传cursor（上批最后的完整镜像ID），next_cursor为空表示末批。候选为未被任何容器引用项，返回截断或不完整引用时不允许清理。每项含revision/size/estimated_reclaimable_bytes与in_use/dangling。prune_images绑定当前批preview_job_id和最多100个{image_id,expected_revision}，预览5分钟有效，服务器核对是该主机的成功镜像任务，不能扩展或改候选；换批清空选择并重新预览。
- 任务ID是持久幂等键；同request_id不同动作409。同对象变更版本失配拒绝，超时或部分执行unknown，不自动重放。
- 只对实际不存在的已选容器/镜像确认删除成功；被占用镜像单项跳过，返回deleted/skipped计数与原因；估计回收量不声称等于实际磁盘释放。
- 原有docker-jobs、普通Agent协议和受限受管容器能力保持原义。升级需求来自签名清单management_version=1，能力授权沿用operations.managed.v1。
