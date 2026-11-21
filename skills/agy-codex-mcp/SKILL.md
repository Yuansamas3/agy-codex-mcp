---
name: agy-codex-mcp
description: >-
  Delegate backend architecture review, complex backend coding/refactoring, and
  code auditing to dual-engine SideDesk · 副席 personas (local Codex CLI or
  OpenAI-compatible HTTP APIs such as DeepSeek / OpenRouter / Ollama) via the
  `agy-codex-mcp_sidedesk` MCP App. By default edits run inside an isolated shadow
  workspace (`read-only` / `workspace-write`) so the original project stays
  untouched until the user reviews the red/green Diff and clicks Apply; an
  opt-in `turbo-direct` mode is also available when explicitly requested by the
  user or configured as the persona default for huge repos or full local
  toolchain execution. Use when the user asks to open SideDesk, delegate to
  Codex/GPT/DeepSeek/API personas, or wants a second-opinion audit or
  shadow-isolated implementation.
---

# SideDesk · 副席 操作指南

本插件通过 MCP Server `agy-codex-mcp_sidedesk` 在 Antigravity 右侧 `aux_pane` 提供双引擎副席工坊，支持：
- **本机 Codex CLI**（动态探测商店版 `codex.exe`，异步预热缓存 0ms 响应，45s 冷启动超时看门狗）
- **通用 OpenAI 兼容 HTTP API**（DeepSeek / OpenRouter / Ollama / LM Studio 等，支持 SSE 流式思考链 `reasoning_content` 与工具调用循环）

支持三组直观权限开关（文件范围 `read-only` / `shadow` / `direct`、执行命令 `auto` / `disabled`、联网 `allow` / `deny`），对外兼容三档 MCP `sandbox` 快捷模式：
- **`read-only`（只读）**：基于影子副本隔离只读分析，原目录零变动。
- **`workspace-write`（影子隔离，默认写模式）**：所有修改均在 `${PLUGIN_DATA}/shadows/` 隔离副本中执行，原目录验收前零变动，通过右侧「待验收」审阅红绿 Diff 后应用或一键撤销。
- **`turbo-direct`（⚡ Turbo 全开直通）**：跳过影子副本与 5,000 文件 / 200 MB 熔断限制，`<50ms` 瞬时直接在真实目标目录执行（Codex CLI 使用 `--dangerously-bypass-approvals-and-sandbox` 并继承完整本机环境变量；OpenAI 兼容 API Agent 模式额外开放带超时/截断/可中止的 `run_command` 工具与外部绝对路径只读）。不进「待验收」影子列表，仅在任务摘要中记录轻量的 `git status` 变更统计。

右侧面板提供 1v1 独立单聊工位（我的个人资料称呼注入、附图发送、话题压缩摘要继承/解绑与 `⋯` 话题管理）。

## 可用 Model 工具（Server: `agy-codex-mcp_sidedesk`）

1. **`sidedesk_open`**：打开或刷新右侧「SideDesk · 副席」辅助栏（支持空参数 `{}` 或 `{ sessionId }`）。
2. **`sidedesk_list_personas`**：列出当前配置的人物卡（含 `provider`、`model`、`defaultSandbox` 与 `toolMode`，严禁且永不返回任何 API Key）。
3. **`sidedesk_dispatch`**：向指定人物卡派单（自动按人物卡 `provider` 路由至 Codex CLI 或 OpenAI 兼容 API）。
   - 必填：`sourceDir`（目标工程目录绝对路径）、`prompt`（自包含指令与验收标准）。
   - 可选：`personaId`（默认第一张卡 `codex-default`）、`sessionId`（续聊同一上下文）、`sandbox`（`read-only` / `workspace-write` / `turbo-direct`）、`model`、`reasoningEffort`（仅 Codex CLI 生效）、`title`、`waitSeconds`（默认 `0` 瞬时返回 `jobId`；短任务可设 `30`~`90`）。
4. **`sidedesk_job_status`**：按 `jobId` 查询实时阶段（`准备隔离副本` / `启动引擎` / `思考与执行中` / `汇总红绿 Diff` / `汇总工作区变动`）、改动摘要（`diffSummary` 或 `directSummary`）、`sourceIntegrity` 与最终回复（支持 `waitSeconds` 最多 120s）。
5. **`sidedesk_abort_job`**：按 `jobId` 立即中止运行中的 Codex 进程树、OpenAI API 流式请求或 `run_command` 子进程树（状态标为 `aborted`，绝不自动重发）。

## 协作与安全纪律

- **主对话默认安全守则（红线）**：
  - 架构评审 / 挑刺审计 / Bug 定位优先用 `sandbox: "read-only"`；明确需要动手写代码或修复时默认用 `sandbox: "workspace-write"`（影子副本隔离）。
  - **严禁私自升级为 `turbo-direct`**：仅当**用户明确要求开启 Turbo / 直通 / 直接修改原目录**（例如大工程跳过副本熔断、直接依赖本机 `.venv`/`node_modules` 跑测试），或**目标人物卡自身的 `defaultSandbox` 已由用户设为 `turbo-direct`** 时，才允许使用 `turbo-direct`。
- 派单后建议先用 `waitSeconds: 0`（或短等待 `30`）拿到 `jobId`，需要继续等再调 `sidedesk_job_status(jobId, waitSeconds: 60)`，不要高频轮询。
- 任务完成后检查 `status`、`directMode`、`sourceIntegrity.untouched`、`diffSummary` / `directSummary` 与 `finalReply`：
  - 影子模式下若 `diffSummary.hasChanges` 为 `true`，向用户汇报摘要并提示在右侧 **SideDesk · 副席 → 待验收** 中审阅红绿 Diff 后点 **「应用到原目录」**、**「撤销上次应用」** 或 **「丢弃此副本」**。
  - `turbo-direct` 模式下向用户明确汇报已在原目录直接执行及 `directSummary` 变动概况。
  - 若状态为 `aborted` 或 `needs_review`（结果待核对），如实告知用户，**严禁私自重新派发同一任务**。
