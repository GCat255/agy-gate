# agy-opencode-router

非侵入式前置分流网关，使 **OpenChamber** 在不修改任何底层源码的前提下，同时支持原生 **OpenCode 2.x** 与本地 **agy-cli**（Gemini 订阅模型等），并可在原生主聊天界面随时按模型自由切换。

## 核心设计

- **零源码入侵**：在 OpenChamber 的「OpenCode 可执行文件路径」中指向本网关启动器即可接入，OpenChamber 仍运行在完整托管模式下，不影响版本升级。
- **生成式 UI 与 OpenChamber 工具全打通（抗升级）**：
  - 首轮自动从本机已安装的 `@openchamber/web` 动态提取最新 `openui-lang` 组件规范并注入新建会话，完整拦截 `POST /api/session/:id/synthetic` 支持卡片交互回传与 `POST /api/experimental/generate/text` 小模型生成。
  - 内置零依赖 MCP stdio 桥接器（`agy-opencode-router mcp-bridge`）：启动时自动在 `~/.gemini/config/mcp_config.json` 幂等注册 `openchamber` 服务，并仅在 OpenChamber 注入 `OPENCHAMBER_AGENT_TOOL_URL` 时动态同步开启 `openchamber_render`、`openchamber`、`openchamber_web` 等工具（对普通终端下的 `agy` 零影响）。
- **按模型归属分流**：
  - 网关注入虚拟 Provider `agy-cli`（模型列表动态取自 `agy models`）。
  - 当前会话选中的模型属于 `providerID === "agy-cli"` 时，网关直接拦截请求并原生调用本地 `agy.exe`（默认不注入 `magpie` 代理模型，仅使用 `agy-cli` 原生模型），将其流式事件翻译为 OpenCode 2.x `OpenCodeEvent` 推入 `/api/event` SSE。
  - 其他所有模型原样透明转发给内部托管的真实 `opencode serve`。
- **混合影子会话**：会话元数据由内部 `opencode serve` 统一维护（保留标题、目录、重命名、归档与小模型辅助功能），`agy-cli` 的对话消息由网关本地持久化并与 `GET /api/session/:id/message` 合并返回，支持同一会话内跨引擎切换。

## 目录结构

```text
agy-opencode-router/
├── bin/
│   ├── agy-opencode-router.mjs   # CLI 主入口（--version / serve / models / doctor / help）
│   ├── agy-opencode-router.cmd   # Windows 垫片（可填入 OpenChamber opencodeBinary）
│   └── agy-opencode-router       # POSIX / Git Bash 垫片
├── extensions/
│   └── agy-quota/                # OpenChamber 独立用量扩展（B2：自带只读 Google OAuth）
├── src/                          # 网关核心模块（纯 Node 24 ESM，零第三方运行时依赖）
├── docs/                         # 协议映射与架构说明
└── test/                         # 单元测试与模拟端到端集成测试
```

## Agy CLI 用量扩展（OpenChamber）

`extensions/agy-quota` 是一个无多余界面、零第三方依赖的 OpenChamber 后台用量扩展（仅保留原生「设置 → 用量」及顶部状态栏展示，不在左侧栏添加额外面板图标）：

1. 在 OpenChamber 打开 **设置 → 扩展 → 添加扩展**，填入本地目录路径：`<repo-dir>\extensions\agy-quota`，并批准本地服务与用量查询权限。
2. 在终端执行一次只读 Google OAuth 授权（也可在 `occ` 菜单中选择 **Agy 用量授权**）：
   ```bash
   agy-opencode-router quota-login
   ```
   授权凭证以 `0600` 权限保存在 `~/.config/agy-opencode-router/quota-auth.json`（与 OpenCode 完全隔离）；可用 `agy-opencode-router quota-status` 检查或 `agy-opencode-router quota-logout` 解绑。
3. 随后在 **设置 → 用量 → Agy CLI 用量**（及顶部状态栏下拉）即可只展示精简的 5 小时 / 每周配额池（`Gemini` 与 `Claude / GPT`）。

## 快速命令

```bash
# 查看帮助与环境诊断
node ./bin/agy-opencode-router.mjs --help
node ./bin/agy-opencode-router.mjs doctor

# 运行语法检查与全部测试
npm run check
npm test
```
