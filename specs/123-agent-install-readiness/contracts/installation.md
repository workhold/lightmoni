# 安装确认契约

现有 apply 请求、响应结构和状态集合不变。SSH 成功后仍为 running，平台在最多 60 秒内只读观察当前安装；成功需要已有健康条件全部满足。超时/取消仍为 unknown，error 使用固定说明，receipt.stages 记录 remote_command_completed（当 SSH 已返回）和固定失败阶段。不会返回任意远端输出或异常文本。人工结束不会停止远端服务，但会撤销本次激活的 control/data 身份。
