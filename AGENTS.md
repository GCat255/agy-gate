# AGENTS.md — agy-gate

本文件为 `agy-gate` 仓库的项目级协作与工程规范，适用于在本仓库内进行开发、重构或测试的所有人类与 AI 代理。

---

## 1. 项目定位

`agy-gate` 是 **OpenChamber 的非侵入式前置双引擎路由网关与终端启动器（`occ`）**：

- 对上（OpenChamber）：伪装为 OpenCode 2.x CLI / HTTP + SSE 服务（`agy-gate serve`），并在扩展插件 `extensions/agy-quota` 中提供只读配额面板。
- 对下（引擎分发）：保持 OpenCode 2.x 作为默认与元数据底座，同时注入虚拟 Provider `agy-cli`；当会话选用 `agy-cli/*` 模型时拦截流量，直连本地 `agy.exe`，将其事件流、`transcript.jsonl` 思考流与子代理树翻译回 OpenCode 2.x 协议。
- 约束：**不修改上游 OpenChamber 或 `agy-cli` 二进制源码**，所有集成均通过公共接口、配置文件绑定与协议翻译完成。

---

## 2. 源码目录与入口向下的树形依赖架构

`src/` 严格采用 **入口向下（Top-Down DAG）** 的分层树形结构。**禁止下层反向 `import` 上层或跨同层循环依赖**；共享基础原语下沉至 `src/core/`。

```text
bin/                             # [层 0] CLI 入口与跨平台垫片
├── agy-gate.mjs                 #   主网关入口（--version / serve / setup / models / doctor / quota-* / mcp-bridge）
├── agy-gate(.cmd)
├── occ.mjs                      #   终端启动器入口（Thin entrypoint -> src/occ/app.mjs）
└── occ(.cmd)

src/                             # 依赖方向：cli, occ ─▶ gateway ─▶ agy, bridge ─▶ core
├── cli/                         # [层 1] 命令行子命令与一条龙安装配置
│   ├── args.mjs                 #   agy-gate CLI 参数解析
│   └── setup.mjs                #   环境绑定（settings.json / extensions.json / mcp_config.json）
│
├── occ/                         # [层 1] occ 终端控制台（仅由 bin/occ.mjs 调用）
│   ├── app.mjs                  #   交互菜单状态机、快捷键循环与 cli setup 分发
│   ├── services.mjs             #   OpenChamber 启停、版本检查、升级回滚与状态读写
│   └── render.mjs               #   备用屏绘制、CJK 列宽计算与布局自适应
│
├── gateway/                     # [层 2] HTTP / SSE 双引擎路由网关
│   ├── server.mjs               #   HTTP 请求分流、Provider 注入与合成消息路由
│   ├── upstream.mjs             #   内部托管 opencode serve 进程与端口/Auth 管理
│   ├── sse-hub.mjs              #   上游与 agy-cli 双源 SSE 聚合广播
│   └── store.mjs                #   混合影子会话、子会话树与消息持久化
│
├── agy/                         # [层 3] agy-cli 执行内核与协议翻译（不依赖 gateway/）
│   ├── runner.mjs               #   agy.exe 常驻 worker 复用、并发排队、思考同步与首轮命名
│   ├── event-translator.mjs     #   stream-json -> OpenCodeEvent 翻译与 token 统计
│   ├── subagent-bridge.mjs      #   agy 子代理 transcript.jsonl 监听与子会话树同步
│   ├── session-title.mjs        #   首轮完成后基于 flash-low 生成短标题
│   ├── models.mjs               #   agy models 拉取、档位折叠与 magpie 模型过滤
│   └── magpie-env.mjs           #   可选 magpie agy env 注入与脱敏摘要
│
├── bridge/                      # [层 3] OpenChamber 生态桥接（不依赖 gateway/ 与 agy/）
│   ├── openchamber.mjs          #   动态定位 @openchamber/web，提取 openui-lang 与工具规范
│   └── mcp.mjs                  #   openchamber stdio MCP 桥接服务器与跨体系子代理拦截
│
└── core/                        # [层 4] 底层共享原语（零上层依赖，仅依赖 Node 内置模块）
    ├── config.mjs               #   数据目录（~/.config/agy-gate）、二进制探测与防自指环路校验
    └── process.mjs              #   跨平台子进程封装（buildSpawnSpec / resolveNpmInvocation）

extensions/
└── agy-quota/                   # OpenChamber 后台用量扩展（只读 Google OAuth + Quota 轮询）
scripts/
├── install.ps1                  # Windows 一键部署脚本
└── install.sh                   # macOS / Linux 一键部署脚本
```

### 依赖红线

1. `src/core/*` 只允许依赖 Node.js 内置模块。
2. `src/bridge/*` 只允许依赖 `src/core/*` 与同目录更底层模块（`mcp.mjs` -> `openchamber.mjs`）。
3. `src/agy/*` 不得导入 `src/gateway/*`、`src/cli/*` 或 `src/occ/*`。
4. 跨体系子代理边界：**禁止 `agy-cli` 会话通过 OpenChamber `ownWork`/`returnResult` 创建 OpenCode 子代理**，`agy` 侧统一使用原生 `invoke_subagent` / `send_message` / `manage_subagents`，由 `src/agy/subagent-bridge.mjs` 映射到前端。
5. 不得将用户真实机器路径（如 `C:\Users\<name>`）或运行时可变文件（如 `occ-state.json`、`quota-auth.json`）写死或落盘在仓库目录中，运行时数据统一写入 `~/.config/agy-gate/`。

---

## 3. 代码规范与验证要求

- **运行时与零依赖**：使用纯 Node.js `>= 24.0.0` ESM（`.mjs`），禁止引入第三方运行时依赖。
- **跨平台垫片**：Windows `.cmd` 文件仅使用 ASCII，避免 OEM 代码页乱码；POSIX 脚本（`bin/agy-gate`、`bin/occ`、`scripts/install.sh`）需保留执行权限（`100755`）。
- **提交前必跑**：每次修改源码、入口脚本或扩展后，必须先通过以下两项全量校验：
  ```bash
  npm run check
  npm test
  ```
- **安全与敏感数据**：禁止将 Token、OAuth 凭证（`quota-auth.json`）、本地会话日志提交到仓库；`doctor` / 日志输出需先脱敏。

---

## 4. OP / OpenCode 更新后的自检与反“打补丁”兼容维护规范

OpenChamber（`@openchamber/web`）或 `@opencode/cli` 更新频繁，但 `agy-gate` 与它们的实际耦合面仅限于以下 **5 个契约边界**；其余接口均由 `src/gateway/server.mjs` 透明反向代理。每次 OP 升级后，按本节先自检再决定是否改动，严禁为追随上游局部变化堆砌临时补丁。

### 4.1 五个契约边界

| 边界 | 依赖方 | 关键契约 | 所在模块 |
|---|---|---|---|
| **1. CLI 托管启动** | OpenChamber lifecycle | `--version`、`serve --stdio --hostname --port`、`server listening on http://...` | `bin/agy-gate.mjs` |
| **2. HTTP / SSE 分流协议** | OpenChamber UI / Server | `/api/provider`、`/api/model`、`/api/session*`、`PATCH /api/session/:id`、`/api/experimental/generate/text`、`/api/event` | `src/gateway/server.mjs`、`src/agy/event-translator.mjs` |
| **3. Web 运行时动态抽取** | `@openchamber/web` | `ui-blocks-guidance.js`、`runtime.js`、`agent-tool/runtime.js` (`createAgentToolRuntime().materializePlugin`) | `src/bridge/openchamber.mjs` |
| **4. Agent Tool 转发与命名** | OpenChamber Agent Tool | `OPENCHAMBER_AGENT_TOOL_URL` / `TOKEN`、内置工具名前缀归一化 | `src/bridge/mcp.mjs` |
| **5. 宿主配置与扩展 API** | `~/.config/openchamber` | `settings.json` (`opencodeBinary`)、`extensions.json`、`openchamber.apiVersion: 1` (`quota`) | `src/cli/setup.mjs`、`extensions/agy-quota/` |

### 4.2 OP 更新后五步自检流程

升级 OP 或 OpenCode 后，必须先跑通以下最小闭环检查；全部正常则**零代码改动**：

1. **自动化契约与单测**：运行 `npm run check && npm test` 与 `agy-gate doctor`。重点核对 `openchamberCompat` 中 `degraded === false`、`guidanceSource === "openchamber-live"`、`toolSpecSource === "openchamber-live"`，及时发现“内部模块路径变更导致的静默降级”。
2. **宿主启动与绑定复核**：运行 `occ` 重启服务，确认进程正常就绪；若升级清除了扩展或重置配置，跑一次 `agy-gate setup` 复原。
3. **主对话与小功能实测**：新建 `agy-cli` 会话发送包含工具调用的消息，确认 **思考流（`reasoning`）→ 工具调用 → 正文 → 首轮自动命名** 完整显示。
4. **子代理与卡片交互实测**：触发一次 `invoke_subagent` 与二次 `send_message` 续传，确认子会话树状态正常；如遇交互卡片，确认 `openchamber_render` 回传正常。
5. **用量扩展核验**：检查 OpenChamber「设置 → 用量」中 `Agy CLI` 5 小时 / 每周配额窗口正常刷新。

### 4.3 反“打补丁式兼容”四大原则

遇到自检失败或契约退化时，必须遵守以下原则重构适配层，禁止靠堆叠条件分支续命：

1. **动态发现与透传优先，禁止静态复制上游实现**
   能通过运行时动态读取（如 `openchamber.mjs` 从 `@openchamber/web` 提取指南与工具 Schema）或透明转发解决的问题，不得复制一份静态文案/枚举进本仓库去追上游每次微调。
2. **单点适配器收敛，禁止补丁散落多处**
   所有与 OP/OpenCode 协议相关的差异只允许收敛在对应边界模块（HTTP 路由归 `gateway/server.mjs`，事件格式归 `agy/event-translator.mjs`，Web 运行时抽取归 `bridge/openchamber.mjs`），不得把针对 OP 版本特性的 `if/else` 散写进 `runner.mjs`、`store.mjs` 或 `subagent-bridge.mjs`。
3. **只做最小必需兼容（P0/P1 修，P2 透传不管）**
   - **P0 阻断**（无法启动、对话断流、工具/子代理失效、标题失联）：必须修复对应边界适配器。
   - **P1 能力退化**（如 `doctor` 报 `degraded: true` 回退到 `fallback`）：更新单个发现适配器重新对齐 live 导出。
   - **P2 非核心体验差异**（非阻塞纯前端样式调整、仅与原生 OpenCode 相关的新特性）：不做额外适配，交由上游 `opencode serve` 透明承接。
4. **替换式演进，禁止叠加历史多版本兼容分支**
   本仓库只维护与当前主流稳定版 OP/OpenCode 对齐的单一路径。需要兼容新版契约时，**直接替换旧映射逻辑并删除失效适配代码**（必要时使用上游最新字段语义）；若用户暂需旧版 OP，通过 `occ` 菜单的「升级 → 回滚」或切换引擎入口处理，不在源码中保留多版本并存的 `if (ver < ...)` 历史补丁包袱。

