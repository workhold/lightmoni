# SDD 188 契约

## 会话轮次

`POST /api/v1/assistant/sessions/:id/turns` 保留 `{text,context}`，新增可选 `attachments`，最多 4 个。

- 图片：`{kind:"image",name,mime_type:"image/jpeg"|"image/png"|"image/webp",data:<base64>}`。单个解码后不超过 512 KiB，图片合计不超过 1 MiB。
- PDF：`{kind:"pdf",name,mime_type:"application/pdf",text:<提取文本>,pages:<页数>}`。提取文本最长 24,000 字符，最多 40 页；不传原始 PDF。
- 文本仍为必填；文件名最多 120 字符，不能含控制字符或路径分隔符。输入无效返回 400，不创建用户消息或 worker。
- `user.message` 事件新增可选 `attachments:[{kind,name,mime_type,pages?}]`；绝不包含图片编码或 PDF 文本。Session GET 的 `messages[*].attachments` 同样只含元数据。

服务端将附件正文以主密钥加密保存为所有者/会话/附件 ID 绑定的私有记录；Session 消息保存引用。模型 worker 输入中的用户消息只在内存解引用。内容与其它页面上下文一样是不可信资料，不能成为操作授权。

## 会话列表

`GET /api/v1/assistant/sessions` 的 `items[*].status` 可选，值为 `running | needs_action | failed | idle`。优先级为运行中、最近轮次失败、最近轮次待人工动作、空闲。旧客户端可忽略字段。列表不返回消息和事件正文。

## 队列与取消

队列仅在 Web 内存中，元素为不可变 `{id,sessionId,text,attachments,context}`。同一 session 同时最多一个 POST 轮次。优先发送按队列 ID 移到队首，调用既有 `/cancel`，等待当前流终态和同步完成后发送；取消失败时不抢发。独立的停止按钮只终止当前轮，队列随后照常处理。

## 展示

全页不常驻显示助手标题、模型标签及分析范围栏；范围、模型设置和代码工作区从输入区按钮打开。窄屏弹层不得超出视口。

终态为完成且没有待确认动作时工具组自动闭合。用户手动展开后保持其选择；新的轮次重新按状态决定默认开合。失败/待确认卡片保持可进入原审阅动作。SSH 行只描述现有固定只读检查，不展示或暗示可编辑的任意命令。
