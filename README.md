# agy-codex-mcp · SideDesk 副席 (`v0.1.0`)

基于 Google Antigravity 原生 **MCP App (`aux_pane`)** 规范构建的轻量级右侧 1v1 副工位插件。支持接入本机官方 **OpenAI Codex CLI** 或任意标准 **OpenAI 兼容 HTTP API**（DeepSeek / OpenRouter / SiliconFlow / 本地 Ollama 等），默认在物理隔离的影子副本中执行文件修改，经红绿 Unified Diff 审阅确认后再安全写回原目录。

---

## 写在前面（背景与叠甲声明）

1. **为什么会有这个小工具**：
   作者本人只是平时折腾 AI 辅助写码的业余小白（非专业前端/架构科班），早期用过也参考过社区里一些多角色工作台、侧边协作面板和本地 MCP 桥接项目的交互思路，觉得「左边主对话统筹 + 右边开个独立单聊副工位审代码/做方案」的配合方式非常顺手。
2. **为什么要从头走原生接口重构**：
   在外部第三方软件里反代、抓包或套壳拉起编辑器的内置 CLI / 订阅登录态，很容易触碰平台服务条款（ToS）导致风控封号，多开群聊也很容易白烧额度。因为实在害怕折腾外部 CLI 套壳被封号，干脆在 AI 辅助下，**100% 遵循 Antigravity 官方文档公开的原生插件与 MCP App 接口**，从零手搓重构了这个只保留纯粹 **1v1 侧边单聊 + 影子副本验收** 的极简自用版。
3. **版本说明（`v0.1.0` 早期自用版）**：
   本项目目前仅为个人学习与日常自用的早期探索版本（`v0.1.0`），代码全部基于 Node.js 与 `@modelcontextprotocol/ext-apps` 独立编写，很多细节肯定还有考虑不周的地方，放出来纯粹给有类似需求的同好做个参考，大佬轻喷。

---

## 核心功能

- **双引擎驱动（零反代、零套壳）**
  - **本机 Codex CLI**：自动检测系统已安装的官方 `codex`（含 Windows 微软商店版或全局 CLI），直接复用本机官方客户端登录态，支持动态读取模型推理档位（`low` ~ `ultra`）、`service_tier="fast"` 加速开关与 `--ignore-user-config` 纯净启动。
  - **通用 OpenAI 兼容 API**：支持自定义 `Base URL`、`API Key` 与模型名（内置常用平台快捷填充），兼容流式输出与 `reasoning_content` 思考链折叠，并内置锁死在工作区内的轻量文件读写工具循环。
- **影子副本隔离与一键后悔药**
  - 默认在 `${PLUGIN_DATA}/shadows/` 独立副本内执行修改（超 `5,000` 文件或 `200 MB` 自动熔断保护，自动跳过 `.git` / `node_modules` / `.venv` 等重目录）。
  - 在「待验收」页逐文件查看红绿 Unified Diff，支持冲突检测、自动快照备份写回、**一键字节级撤销上次应用** 与丢弃副本。
- **三组直观权限胶囊 & 可选 Turbo 直通档**
  - 提供「文件范围（只读 / 影子隔离 / 原目录不限）」「执行命令（自动 / 禁止）」「联网（允许 / 禁止）」分段开关；处理超大目录或需直接调用本机完整依赖跑测试时可手动切至 `Turbo 直通`，并配有两段式防误触全局急停开关。
- **清爽 1v1 独立单聊工位**
  - 支持多张自定义角色卡、长期记忆开关、长对话定期设定同步（防多轮后遗忘设定）、图片附件发送、话题改名/导出 Markdown/压缩摘要继承开新话题，以及浅色羊皮纸 / 深色暖炭双主题切换。
  - 零额外请求开销读取本地会话日志中的配额剩余百分比与当前话题上下文窗口水位提示。

---

## 安装与使用

### 环境要求
- Google Antigravity（支持 MCP Apps `aux_pane`）
- Node.js `>= 20`
- Git（用于影子副本内部生成标准 Unified Diff）
- （可选）若使用 Codex CLI 模式，需先在本机安装并完成一次官方 `codex` 登录。

### 1. 克隆到 Antigravity 插件目录

**Windows (PowerShell)：**
```powershell
git clone https://github.com/Yuansamas3/agy-codex-mcp.git "$HOME\.gemini\config\plugins\agy-codex-mcp"
cd "$HOME\.gemini\config\plugins\agy-codex-mcp"
npm install
```

**macOS / Linux：**
```bash
git clone https://github.com/Yuansamas3/agy-codex-mcp.git ~/.gemini/config/plugins/agy-codex-mcp
cd ~/.gemini/config/plugins/agy-codex-mcp
chmod +x bin/launch.sh
npm install
```
> **macOS / Linux 启动配置提示**：仓库默认 `mcp_config.json` 配置了 Windows 启动脚本 `cmd /d /c ${PLUGIN_ROOT}/bin/launch.cmd`。在 macOS / Linux 下只需将 `mcp_config.json` 改为：
> ```json
> {
>   "mcpServers": {
>     "sidedesk": {
>       "command": "/bin/sh",
>       "args": ["${PLUGIN_ROOT}/bin/launch.sh", "--data_dir=${PLUGIN_DATA}"]
>     }
>   }
> }
> ```

### 2. 打开面板
安装依赖后，在 Antigravity 的 **MCP Servers** 设置中刷新/重启 `agy-codex-mcp_sidedesk`，或直接在主对话中输入：
> `打开 SideDesk 副席面板`

即可在对话右侧辅助栏呼出工位面板。

*(小贴士：如果不希望影子副本占用系统盘空间，可将插件目录与 `~/.gemini/antigravity/plugin_data/agy-codex-mcp` 通过系统目录联接 `Junction` / 软链接指向其他大容量磁盘分区。)*

---

## 开发与自检脚本

```bash
# 重新打包单文件前端 (app/dist/app.html)
npm run build:app

# 运行后端与安全边界端到端测试
npm run test:e2e

# 运行无头浏览器 360px 窄栏布局与严格 CSP 校验
npm run verify:app
```

---

## 安全与合规免责声明 (Disclaimer)

1. **合规边界**：本插件仅在 Antigravity 官方公开的本地 MCP App 扩展机制内运行，**绝不反代、截获、提取或包装 Antigravity (`agy`) 或任何第三方客户端的私有 OAuth 凭据与登录令牌**。
2. **数据与密钥安全**：所有会话状态、影子副本与用户自行填写的第三方 API Key 均仅保存在用户本机 `${PLUGIN_DATA}` 目录中（无任何外部遥测或上传）；API Key 对主对话侧模型（Model Tools）完全隔离不可见，前端界面亦仅回显脱敏掩码。
3. **风险自担**：开启「原目录不限（Turbo 直通）」模式后，底层引擎将直接在目标真实目录执行读写与命令而不再经过影子副本隔离，请务必在版本控制（Git）保护或充分确认风险的前提下谨慎使用。本项目按 MIT 协议“原样（AS IS）”提供，作者不对使用过程中产生的任何代码改动、配额消耗或数据损失承担责任。

---

## License

[MIT](./LICENSE)
