# agy-gate

非侵入式前置双引擎路由网关与终端管理工具（集成 **`occ`** 启动器），使 **OpenChamber** 在不修改任何底层源码的前提下，同时支持原生 **OpenCode 2.x** 与本地 **agy-cli**（Gemini 订阅模型、原生工具、子代理体系与思考流），并可在新设备上一键完成全套部署。

## 新设备一条龙安装与使用

前置要求：**Node.js >= 24.0.0**、**Git**；如需使用 `agy-cli` 引擎，需提前安装并登录本机 `agy`。

### Windows（PowerShell）

```powershell
git clone https://github.com/GCat255/agy-gate.git
cd agy-gate
.\scripts\install.ps1
```

### macOS / Linux / Git Bash

```bash
git clone https://github.com/GCat255/agy-gate.git
cd agy-gate
./scripts/install.sh
```

安装脚本会自动完成以下全部动作：
1. 全局链接 `occ` 与 `agy-gate` 命令（`npm link`，失败时回退 `npm install -g .`）。
2. 检查并在缺失时全局安装 `@openchamber/web` 与 `@opencode/cli`。
3. 运行 `agy-gate setup`，自动完成三项本地配置：
   - 在 `~/.config/openchamber/settings.json` 将 `opencodeBinary` 绑定到 `agy-gate`；
   - 在 `~/.config/openchamber/extensions.json` 注册并授权 `extensions/agy-quota` 用量扩展；
   - 在 `~/.gemini/config/mcp_config.json` 幂等注册 `mcpServers.openchamber`（仅在 OpenChamber 会话内激活工具）。
4. 运行 `agy-gate doctor` 输出环境自检摘要。

安装完成后即可直接在任意终端运行 **`occ`** 启动 OpenChamber、切换引擎、升级组件、授权 Agy 用量（在 OpenChamber「设置 → 用量」列表底部选择 **`Agy CLI 用量`** 查看，而非内置的 `Antigravity`）或一键同步 GitHub 更新（也可手动执行 `agy-gate quota-login` 完成只读 Google OAuth 授权）。

### 日常更新

在已安装设备上可直接通过 `occ` 一键同步（推荐）：

```bash
# 打开 occ 交互菜单选择「同步更新」，或直接在终端执行：
occ sync
```

`occ sync` 会自动检查 GitHub 更新、执行 `git pull --ff-only`、在非软链安装模式下重新 `npm install -g .`、刷新 `setup` 配置，并在 OpenChamber 运行中时自动重启生效；也可手动执行：

```bash
cd agy-gate
git pull
# Windows 重新应用更新与环境校验：
.\scripts\install.ps1
# macOS / Linux 重新应用更新与环境校验：
./scripts/install.sh
```

> 说明：若之前通过 `npm link` 安装，代码在 `git pull` 后即生效；若系统曾自动回退为 `npm install -g .` 拷贝安装，则必须重新运行安装脚本（或 `npm install -g . && agy-gate setup`）以同步全局入口。

## 核心设计

- **零源码入侵**：在 OpenChamber 的 `opencodeBinary` 中指向本网关即可接入，OpenChamber 仍运行在完整托管模式下，不影响版本升级。
- **按模型归属分流**：
  - 网关注入虚拟 Provider `agy-cli`（模型列表动态取自 `agy models` 并自动折叠档位为可选变体）。
  - 当前会话选中的模型属于 `providerID === "agy-cli"` 时，网关直接拦截请求并原生调用本地 `agy.exe`（默认不注入 `magpie` 代理模型），将其流式事件翻译为 OpenCode 2.x `OpenCodeEvent` 推入 `/api/event` SSE。
  - 其他所有模型原样透明转发给内部托管的真实 `opencode serve`。
- **完整协议与子代理打通**：
  - **思考过程恢复**：针对 `agy-cli` 标准输出流不输出思考增量的特点，按轮次从 `transcript.jsonl` 增量恢复 `PLANNER_RESPONSE.thinking` 并同步回传前端。
  - **原生子代理桥接**：禁止跨体系混调，将 `agy` 的 `invoke_subagent` / `send_message` / `manage_subagents` 映射为 OpenChamber 子会话树，支持异步回传、二次消息续传及父会话终止清理。
  - **自动会话命名**：首轮对话完成后异步生成简洁标题并通过 `PATCH /api/session/:id` 同步上游并广播 `session.renamed`。
  - **生成式 UI 与工具桥接**：首轮动态提取 `@openchamber/web` 的 `openui-lang` 规范，通过内置 `mcp-bridge`（仅在存在 `OPENCHAMBER_AGENT_TOOL_URL` 时激活）支持 `openchamber_render` 等工具及 `/api/session/:id/synthetic` 交互回传。
- **混合影子会话与跨引擎上下文承接**：会话元数据由内部 `opencode serve` 统一维护，`agy-cli` 对话消息由网关本地持久化并与 `GET /api/session/:id/message` 按时间顺序合并返回；在同一会话中从其他模型切换到 `agy-cli`（或反方向切回）时自动承接前置上下文并支持切换后立即 `/compact`、分叉与撤回同步。

## 目录结构

```text
agy-gate/
├── AGENTS.md                   # 项目规范与入口向下的树形依赖约束
├── bin/
│   ├── agy-gate.mjs            # 网关 CLI 入口（serve / setup / models / doctor / quota-* / mcp-bridge）
│   ├── agy-gate.cmd / agy-gate # Windows / POSIX 垫片
│   ├── occ.mjs                 # 终端启动器入口（Thin entrypoint -> src/occ/app.mjs）
│   └── occ.cmd / occ           # Windows / POSIX 垫片
├── src/                        # 入口向下分层依赖：cli, occ -> gateway -> agy, bridge -> core
│   ├── cli/                    #   命令行解析（args.mjs）与一条龙配置（setup.mjs）
│   ├── occ/                    #   occ 终端控制面板（app.mjs / services.mjs / render.mjs）
│   ├── gateway/                #   HTTP/SSE 分流网关（server.mjs / upstream.mjs / sse-hub.mjs / store.mjs）
│   ├── agy/                    #   agy-cli 执行与翻译（runner / event-translator / subagent-bridge / session-title / models / magpie-env）
│   ├── bridge/                 #   OpenChamber 生态桥接（openchamber.mjs / mcp.mjs）
│   └── core/                   #   底层共享原语（config.mjs / process.mjs）
├── scripts/
│   ├── install.ps1             # Windows 一键安装与环境初始化脚本
│   └── install.sh              # macOS / Linux 一键安装与环境初始化脚本
├── extensions/
│   └── agy-quota/              # OpenChamber 后台用量扩展（只读 Google OAuth）
├── docs/                       # 协议映射与 occ 使用说明
└── test/                       # 单元测试与模拟端到端集成测试
```

## 常用命令

```bash
# 打开交互式控制面板（启停、升级/回滚、切换引擎、授权用量、一键配置）
occ

# 在新环境执行一条龙配置（也可附加 --install-deps / --dry-run / --json / --uninstall）
agy-gate setup
occ setup

# 环境自检、模型目录与用量管理
agy-gate doctor
agy-gate models
agy-gate quota-login
agy-gate quota-status
agy-gate quota-logout

# 运行语法检查与全部测试
npm run check
npm test
```
