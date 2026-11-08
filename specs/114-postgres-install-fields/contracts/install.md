# PostgreSQL 安装契约

沿用 `POST /api/v1/ops/catalog/postgresql/install` 与现有目录元数据：

| 参数 | 基本表单 | 默认值 | 约束 |
| --- | --- | --- | --- |
| `parameters.user` | 用户名 / Username | `lightmoni` | 原有字母开头、字母数字下划线及 31 字符上限 |
| `parameters.password` | 访问密码 / Access password | 无 | 原有必填、8–256 字符、密码控件 |
| `parameters.database` | 数据库名称 / Database name | `app` | 原有字母开头、字母数字下划线及 63 字符上限 |

沿用 `POSTGRES_USER`、`POSTGRES_PASSWORD`、`POSTGRES_DB` 映射及既有加密存储和公开响应脱敏。高级设置不重复注册以上字段。API、默认值、可选语义及已有实例行为不变。
