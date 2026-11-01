# 新增应用与固定版本

核对日期：2026-11-01。服务数包含一次性初始化和内部依赖；版本以各项目实际镜像标签为准。官方来源可由应用名称进入。运行前提详见表单 notes；此表不代表全部业务运行已实测。

| 分类 | 应用 / 官方来源 | 固定版本 | 服务数 |
| --- | --- | --- | ---: |
| database | [PostgreSQL](https://hub.docker.com/_/postgres) | 18.6-bookworm | 1 |
| database | [MariaDB](https://hub.docker.com/_/mariadb) | 11.8.9 | 1 |
| database | [MongoDB](https://hub.docker.com/_/mongo) | 8.0.34 | 1 |
| database | [ClickHouse](https://clickhouse.com/docs/install/docker) | 26.8.36.3 | 1 |
| database | [Elasticsearch](https://www.elastic.co/docs/deploy-manage/deploy/self-managed/install-elasticsearch-docker-basic) | 9.2.6 | 1 |
| database | [Qdrant](https://qdrant.tech/documentation/guides/installation/) | v1.20.0 | 1 |
| database | [InfluxDB](https://docs.influxdata.com/influxdb/v2/install/use-docker-compose/) | 2.9.1 | 1 |
| middleware | [RabbitMQ](https://www.rabbitmq.com/docs/download) | 4.3.7-management-alpine | 1 |
| middleware | [Nacos](https://nacos.io/en/docs/latest/quickstart/quick-start-docker/) | v2.5.5 | 1 |
| middleware | [EMQX](https://docs.emqx.com/en/emqx/latest/deploy/install-docker.html) | 6.3.2 | 1 |
| middleware | [Memcached](https://hub.docker.com/_/memcached) | 1.6.45-alpine | 1 |
| middleware | [Kafka](https://hub.docker.com/r/apache/kafka) | 4.4.0 | 1 |
| middleware | [RocketMQ](https://rocketmq.apache.org/docs/quickStart/02quickstartWithDocker/) | 5.5.0 | 3 |
| devops | [Gitea](https://docs.gitea.com/installation/install-with-docker) | 28.2.0 | 1 |
| devops | [Jenkins](https://www.jenkins.io/doc/book/installing/docker/) | 2.580.2-jdk21 | 1 |
| devops | [GitLab CE](https://docs.gitlab.com/install/docker/installation/) | 19.4.5-ce.0 | 1 |
| devops | [Nexus Repository](https://github.com/sonatype/docker-nexus3) | 3.96.5 | 1 |
| devops | [SonarQube Community Build](https://docs.sonarsource.com/sonarqube-community-build/server-installation/from-docker-image/starting-sonarqube-container) | 26.10.0.133078-community | 2 |
| devops | [Harbor](https://goharbor.io/docs/2.14.0/install-config/) | v2.14.6 | 9 |
| ai | [Ollama](https://docs.ollama.com/docker) | 0.40.13 | 1 |
| ai | [Open WebUI](https://docs.openwebui.com/getting-started/quick-start/) | v0.12.5 | 1 |
| ai | [MaxKB](https://github.com/1Panel-dev/MaxKB) | v2.10.8-lts | 1 |
| ai | [AnythingLLM](https://docs.anythingllm.com/installation-docker/overview) | 1.19.0 | 1 |
| ai | [vLLM](https://docs.vllm.ai/en/latest/deployment/docker/) | v0.32.0 | 1 |
| ai | [Dify](https://docs.dify.ai/en/self-host/quick-start/docker-compose) | 1.14.2 | 12 |
| ai | [FastGPT](https://doc.fastgpt.io/docs/self-host/deploy/docker) | v4.17.2 | 9 |
| tools | [DBX](https://dbxio.com/en/docs/getting-started) | 0.6.62 | 1 |

原有 MySQL、Redis、OpenResty、Docker Registry 保留，共 31 个应用。工具类只有 DBX。
