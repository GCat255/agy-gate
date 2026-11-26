# occ — OpenChamber 终端启动器

集成于 `agy-gate` 的零依赖终端管理面板与启动器，用于在命令行统一启停 OpenChamber、切换引擎入口、管理组件升级/回滚，以及完成一行环境配置与 Google 配额授权。

## 用法

```text
occ                  打开交互式终端菜单
occ setup            一键配置分流网关、agy-quota 扩展与 OpenChamber MCP
occ sync [--check]   检查或从 GitHub 同步最新代码并刷新环境配置
occ --help           查看说明
```

主菜单项：

| 选项 | 已停止 | 运行中 |
|---|---|---|
| `启动服务` | 启动本地 OpenChamber 并显示访问地址 | 灰显，显示 `运行中 · http://127.0.0.1:3000` |
| `停止服务` | 灰显，不可选 | 停止实例并复核状态 |
| `升级` | 选择 `opencode` / `openchamber` / `agy-cli` 升级或回滚 | 同左（先停后恢复） |
| `同步更新` | 检查并从 GitHub `origin` 拉取最新代码、同步全局命令与环境配置 | 同左（有更新时先停后恢复） |
| `引擎入口` | 在原生 OpenCode 与 `agy-gate` 间切换 | 同左（自动重启生效） |
| `Agy 用量授权` | 完成/解除只读 Google OAuth 授权并自动确保 `agy-quota` 扩展已启用 | 同左（必要时自动重启生效；OP 内在设置 → 用量 底部查看「Agy CLI 用量」） |
| `一键配置` | 绑定 `opencodeBinary`、注册 `agy-quota` 扩展与 `openchamber` MCP | 同左（配置变更时自动重启生效） |
| `退出` | 等同于 `q` | 等同于 `q` |

按键：`↑` `↓`（或 `j` `k`）移动，`Enter` 执行，`q` / `Esc` / `Ctrl-C` 退出；子列表按 `Esc` 返回上一层。非交互管道环境下自动打印文本状态后退出。

## 升级与回滚

- **OpenCode**（`@opencode/cli`）：从 npm packument 获取最近 5 个稳定版并附带当前与可回滚版本；调用 `opencode upgrade <版本>`（Windows 上会自动补充 Git `bin` 到子进程 `PATH`，规避官方 issue #50886 缺失 `bash` 问题）。
- **OpenChamber**（`@openchamber/web`）：调用 `npm install -g @openchamber/web@<版本>`。
- **Agy CLI**（`agy-cli`）：调用本地 `agy update`。
- **回滚记录**：保存在 `~/.config/agy-gate/occ-state.json`（不污染代码仓库工作区），删除该文件即可清空历史。
