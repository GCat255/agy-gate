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
