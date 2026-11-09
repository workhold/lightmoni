# Validation guide

1. 安装锁定依赖并构建SDK，运行涉及的machine-files、host-docker、operations-containers、platform-registry-images、operation-schedules、managed-executor与遥测检查。
2. 各语言hostname默认/覆盖测试，根typecheck。
3. 本地HTTP/浏览器夹具验收文件、容器、商店、主机监控；复跑Grafana parity和2000行日志性能。UI脚本连续三轮，实际看图。
4. 可丢弃OpenSSH/Docker/S3验证并发、吊销、unknown、备份恢复与迁移；未跑环境用例明确未验收。
5. 仓库与Doca写入后回读文本/原生图节点连线，diff检查、同步main，GitHub PR交付；不自动合并/部署。
