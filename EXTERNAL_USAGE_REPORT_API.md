# 开放平台与使用报告 API

Spring Mouse 后台提供独立的“开放平台”模块。进入页面后直接展示开放接口文档；API Key 的创建、停用、删除和调用记录通过右侧管理抽屉完成。

后台入口：

```text
/dashboard/open-platform
```

开放平台密钥与模型调用密钥完全独立：

- 模型调用密钥通常以 `sk-` 开头，用于 `/v1/*` 模型接口。
- 开放平台密钥以 `smop_` 开头，仅用于 `/open/v1/*` 开放接口。
- 开放平台密钥完整值只在创建时展示一次，数据库仅保存 SHA-256 哈希。
- 每次通过有效开放平台密钥发起的调用都会写入持久化调用记录。

## 鉴权

推荐使用 Bearer Token：

```http
Authorization: Bearer smop_YOUR_OPEN_PLATFORM_KEY
```

也支持：

```http
x-api-key: smop_YOUR_OPEN_PLATFORM_KEY
```

不要把密钥放在 URL 查询参数中，避免进入访问日志。

## 1. 获取成员目录

```http
GET /open/v1/users
```

调用示例：

```bash
curl 'https://spring-mouse.example.com/open/v1/users' \
  -H 'Authorization: Bearer smop_YOUR_OPEN_PLATFORM_KEY'
```

响应：

```json
{
  "object": "list",
  "data": [
    {
      "userId": "8cf1...",
      "name": "Alice",
      "active": true,
      "createdAt": "2026-07-01T08:00:00.000Z",
      "lastUsedAt": "2026-08-28T10:30:00.000Z"
    }
  ]
}
```

该接口不会返回模型调用密钥原文。`userId` 用于后续查询指定成员的使用报告。

## 2. 查询成员使用报告

```http
GET /open/v1/usage/report
```

### 查询参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `userId` | 是 | 成员目录接口返回的成员标识 |
| `startDate` | 是 | ISO-8601 起始时间，包含该时刻 |
| `endDate` | 是 | ISO-8601 结束时间，包含该时刻，且不得早于 `startDate` |

建议始终携带明确时区，例如 `2026-08-01T00:00:00+08:00`。

### 请求示例

```bash
curl -G 'https://spring-mouse.example.com/open/v1/usage/report' \
  -H 'Authorization: Bearer smop_YOUR_OPEN_PLATFORM_KEY' \
  --data-urlencode 'userId=USER_ID_FROM_DIRECTORY' \
  --data-urlencode 'startDate=2026-08-01T00:00:00+08:00' \
  --data-urlencode 'endDate=2026-08-28T23:59:59+08:00'
```

### 报告内容

响应包含：

- 调用次数及成功、失败、取消次数
- Prompt、Completion、Cached 和总 Token
- 预估成本
- 请求耗时、活跃会话时长、活跃天数和会话数
- 模型、来源应用和来源 IP 分布
- 使用节奏和工作日分布
- AI 使用投入指数、分层、团队排名和百分位
- 团队均值、P25、P50、P75、最大值和最小值

如果成员在指定时间段没有使用记录，接口仍返回 `200`，`subject.hasUsage` 为 `false`，使用数据为零，排名和投入指数为 `null`。

## 调用记录

后台查看路径：

```text
开放平台 → API Key 管理 → 调用记录
```

调用记录支持按 API Key 筛选和分页查看，记录以下字段：

- 调用时间、API Key 名称及前缀
- HTTP 方法和开放接口路径
- HTTP 状态码和服务端处理耗时
- 查询的成员 `userId`（仅使用报告接口）
- 可信代理传入的来源 IP 和客户端 User-Agent

只有通过有效 API Key 完成鉴权后的请求才能关联到具体密钥，因此未携带密钥或密钥无效的 `401` 请求不会进入按密钥统计的调用记录。停用密钥后不会再产生有效调用记录；删除密钥不会删除已有历史记录。

## 错误码

| HTTP 状态 | `error.code` | 说明 |
| --- | --- | --- |
| `400` | `invalid_user_id` | 未提供有效的 `userId` |
| `400` | `invalid_date_range` | 时间参数缺失、格式错误或起止顺序错误 |
| `401` | `missing_api_key` | 未提供开放平台密钥 |
| `401` | `invalid_api_key` | 开放平台密钥不存在或已停用 |
| `404` | `user_not_found` | 查询的成员不存在 |
| `500` | `user_list_failed` | 无法读取成员目录 |
| `500` | `usage_report_failed` | 无法生成使用报告 |

## 安全说明

- 所有开放接口响应均设置 `Cache-Control: no-store`。
- 开放平台密钥拥有成员目录和使用报告读取权限，应只交给可信的服务端系统。
- 删除或停用密钥后，使用该密钥的外部系统立即无法继续访问；已产生的历史调用记录仍会保留。
- 开放接口不会返回模型调用密钥原文，也不会在使用报告中返回其他成员的姓名或个人明细。
