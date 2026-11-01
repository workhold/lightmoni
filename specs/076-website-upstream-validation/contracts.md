# 契约

- 继续使用 `POST /api/v1/ops/resources` 和 `PUT /api/v1/ops/resources/:id`。网站手动目标仍为 `bindings[].locations[].cluster_targets[] = {cluster_id, target: "proxy", upstreams: [{url, weight, ...}]}`；应用目标序列化时继续移除隐藏 upstreams。
- URL 必须能被标准 URL 解析，protocol 为 http:/https:，hostname 非空，无用户名、密码、非根 pathname、search 或 hash，host 不含空白或 Nginx 特殊字符 `{ } ; $`。服务端保存 `url.origin`；前端不改写输入。
- 手动目标至少一个后端且每项 URL 必填。前端验证失败不调用保存 API；列表错误显示在所属集群；URL 错误显示在该行。错误定位与保留输入不改变资源或 revision。
- 服务端错误代码、HTTP 状态和响应结构保持兼容；前端仅翻译展示文本。未经网页的无效创建不产生资源，无效编辑不增加 revision 或替换原后端。
