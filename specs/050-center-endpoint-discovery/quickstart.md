# Validation guide

1. 管理→上报地址：登记公网引导URL及internal内网IP:port；保存并刷新回读。
2. 将SDK LIGHTMONI_ENDPOINT设为公网；调用显式刷新后上报，核对内网接收且公网只有发现请求。
3. 关闭内网监听：原批次下一次重试走公网；修改内网IP/port并刷新：新入口接收。
4. Agent按同样步骤验证心跳、任务及数据统一内网；检查旧relay接口404。
5. 运行runtime定向测试、四种SDK测试、web类型与页面验证；Doca写入后回读目标正文/原生图并保存证据。
