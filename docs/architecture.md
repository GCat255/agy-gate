# 架构与协议映射设计

## 1. 进程拓扑

```text
OpenChamber Server
   │  spawn: agy-gate serve [--stdio] --hostname 127.0.0.1 --port <P_gw>
   ▼
agy-gate (监听 P_gw，透传 Basic Auth)
   ├──▶ 内部子进程：opencode serve [--stdio] --hostname 127.0.0.1 --port <P_oc>
   └──▶ 按需调用：agy.exe -p --output-format stream-json --model <modelID> [--conversation <convID>]
```

## 2. 接口分流矩阵

| 路由 | 行为 | 说明 |
|---|---|---|
| `GET /api/info` | 透传 `P_oc` | 保持 OpenCode 版本号与服务能力声明 |
| `GET /api/provider` | 透传 + 注入 | 追加虚拟 Provider `agy-cli` |
| `GET /api/model` | 透传 + 注入 | 追加 `agy models` 解析出的模型清单 |
| `POST /api/session` | 转发 `P_oc` + 剥离未知模型 | 若初始模型为 `agy-cli/*`，先创建影子会话并记录归属 |
| `POST /api/session/:id/model` | 条件拦截 | 若切换至 `agy-cli/*`，本地记录并广播 `session.model.selected`，返回 `204` |
| `POST /api/session/:id/prompt` | 按模型分流 | `agy-cli` 模型走本地 `agy.exe`，否则原样转发 `P_oc` |
| `POST /api/session/:id/interrupt` | 按活跃执行分流 | 若存在本地 `agy.exe` 进程则中止并触发中断事件，否则转发 `P_oc` |
| `GET /api/session` / `GET /api/session/:id` | 透传 + 叠加 | 叠加 `agy-cli` 选中模型、token 与更新时间 |
| `GET /api/session/:id/message` | 透传 + 合并 | 将本地存储的 `agy-cli` 消息与 `P_oc` 消息按时间排序合并 |
| `GET /api/event` | 双源 SSE 聚合 | 透传 `P_oc` SSE，并混入 `agy-cli` 翻译后的 `OpenCodeEvent` |
| 其他所有 `/api/*` | 透明反向代理 | 直达 `P_oc` |

## 3. 事件翻译约定（`agy-cli` → OpenCode 2.3.2）

- `init` → 记录 `conversation_id`（用于后续 `--conversation` 续聊），发出 `session.execution.started` 与 `session.step.started`。
- `step_update`（`step_type: "agent_response"`）→ 发出 `session.text.started` / `session.text.delta` / `session.text.ended`。
- `step_update`（思考/推理增量）→ 发出 `session.reasoning.started` / `session.reasoning.delta` / `session.reasoning.ended`。
- `step_update`（工具调用）→ 发出 `session.tool.input.started` / `session.tool.called` / `session.tool.success`（或 `failed`）。
- `result` → 发出 `session.step.ended`、`session.usage.updated`、`session.execution.succeeded` 与 `session.idle`。
