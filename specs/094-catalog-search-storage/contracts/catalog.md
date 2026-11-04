# 目录与安装契约

GET /api/v1/ops/catalog 的 templates 增加 meilisearch / searxng / firecrawl / rustfs；categories 新增 search（搜索服务 / Search services）、storage（云存储 / Cloud storage）。总数35；旧分类顺序保留，新分类追加。

POST /api/v1/ops/catalog/:id/install 沿用 parameters、host_ports、listen_ip、deployments 和 confirmation 契约。主端口必须排在 ports 首位，供快捷域名安装使用：Meilisearch http:7700；SearXNG http:8080；Firecrawl http:3002；RustFS s3:9000，其后 console:9001。端口在安装时默认自动分配；SearXNG 和 Firecrawl 的 host_ip 默认127.0.0.1，可显式覆盖。

meilisearch.parameters.master_key 必填，至少16个字符，最多256字符。rustfs.parameters.access_key 必填3–128个 ASCII 字母数字/下划线/连字符；secret_key 必填8–256字符，两项均拒绝公开默认值 rustfsadmin，以满足上游启动凭据约束。SearXNG无必填参数。Firecrawl可选 searxng_endpoint（标准HTTP(S)源地址），服务端拼接 /search；可选 LLM key 不属于首版，基础抓取不需模型密钥。

不支持的版本、额外参数、非法端口、过短或错误类型参数在资源创建前返回既有固定错误码。主密钥/访问密钥/随机内部凭据按环境字段加密并在公开回读中脱敏。既有 API schema 不变。
