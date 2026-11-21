# agy-opencode-router

非侵入式前置分流网关，使 **OpenChamber** 在不修改任何底层源码的前提下，同时支持原生 **OpenCode 2.x** 与本地 **agy-cli**（Gemini 订阅模型等），并可在原生主聊天界面随时按模型自由切换。

## 核心设计

- **零源码入侵**：在 OpenChamber 的「OpenCode 可执行文件路径」中指向本网关启动器即可接入，OpenChamber 仍运行在完整托管模式下，不影响版本升级。
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

`extensions/agy-quota` 是一个零第三方依赖的 OpenChamber 独立扩展（Guest Panel + Host Service），用于直接在 OpenChamber「设置 → 用量」和顶部状态栏展示 Agy CLI / Google Antigravity 的 5h 与周配额，且完全隔离于 OpenCode 与本网关：

1. 在 OpenChamber 打开 **设置 → 扩展 → 添加扩展**，填入本地目录路径：`<repo-dir>\extensions\agy-quota`。
2. 批准扩展所需的本地服务与用量查询权限后，在左侧栏打开 **Agy CLI 用量** 面板。
3. 点击 **使用 Google 登录** 完成一次只读 OAuth 授权（回调失败时也支持手动粘贴回调 URL 或授权码）。
4. 随后即可在 **设置 → 用量 → Agy CLI 用量**（以及顶部状态栏下拉）实时查看订阅配额。

## 快速命令

```bash
# 查看帮助与环境诊断
node ./bin/agy-opencode-router.mjs --help
node ./bin/agy-opencode-router.mjs doctor

# 运行语法检查与全部测试
npm run check
npm test
```
