# Data model

instance_settings.reporting_endpoints沿用{endpoints:[{id,name,url,scope}],default_endpoint_id}，scope为internal/public，旧值默认public。默认引导地址必须为public；至少一个public入口（未配置地址时externalURL）；内网URL接受IPv4/IPv6和端口，沿用完整HTTP(S)URL验证。instance_settings.center_id保存UUID并在重启后保持。

地址清单{version:1,center_id,revision,endpoints:[{url,scope}],refresh_after_seconds:30}。revision为规范JSON摘要，地址删除在下一有效清单立即生效。客户端状态：bootstrap、center_id、manifest、selected、expires、failed_until、last_error；仅内存，不存秘密。Agent本地状态/status可展示选择结果。HTTP请求失败标记选中地址待重探测，不在同次调用内重发。
