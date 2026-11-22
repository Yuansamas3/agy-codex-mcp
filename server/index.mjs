import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { RunnerHub } from './runner-hub.mjs';
import { getAutoNodeDir, redactSecrets } from './security.mjs';
import {
  applyShadowToSource,
  computeShadowDiff,
  discardShadow,
  undoLastApply,
} from './shadow-engine.mjs';
import {
  DEFAULT_OPENAI_CONTEXT_WINDOW,
  getContentMessageCount,
  hasFreshSessionSummary,
  normalizeContextUsage,
  normalizeContextWindow,
  readCodexUserDefaults,
  sanitizePersonaForApp,
  sanitizePersonaForModel,
  SideDeskStore,
} from './store.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');
const APP_URI = 'ui://sidedesk/app.html';
const DEFAULT_APP_HTML_PATH = join(PLUGIN_ROOT, 'app', 'dist', 'app.html');

function parseArg(prefix) {
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return '';
}

const dataDir = parseArg('--data_dir=') || process.env.SIDEDESK_DATA_DIR || '';
const codexSessionsDir =
  parseArg('--codex_sessions_dir=') || process.env.SIDEDESK_CODEX_SESSIONS_DIR || '';
const store = new SideDeskStore(dataDir);
const hub = new RunnerHub(store, { sessionsDir: codexSessionsDir });

const PLACEHOLDER_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>SideDesk · 副席</title></head>
<body style="font-family:system-ui,sans-serif;padding:16px;background:#14161a;color:#eceff4;">
  <h3>SideDesk · 副席</h3>
  <p>请运行 node app/build.mjs 构建单文件前端。</p>
</body>
</html>`;

function loadAppHtml() {
  const overridePath = process.env.SIDEDESK_APP_HTML || DEFAULT_APP_HTML_PATH;
  if (existsSync(overridePath)) {
    return readFileSync(overridePath, 'utf8');
  }
  return PLACEHOLDER_HTML;
}

function summarizeJobForModel(job) {
  if (!job) return null;
  const secrets = store.getKnownSecrets();
  const durSec =
    job.startedAt && job.finishedAt
      ? Number(((job.finishedAt - job.startedAt) / 1000).toFixed(1))
      : null;
  return {
    jobId: job.id,
    sessionId: job.sessionId,
    personaId: job.personaId,
    personaName: job.personaName,
    provider: job.provider || 'codex-cli',
    shadowId: job.shadowId,
    sourceDir: job.sourceDir,
    status: job.status,
    stage: job.stage || job.status,
    stageLabel: job.stageLabel || '',
    model: job.model,
    reasoningEffort: job.reasoningEffort || undefined,
    sandbox: job.sandbox,
    permissions: job.permissions || undefined,
    directMode: Boolean(job.directMode),
    codexThreadId: job.codexThreadId || undefined,
    durationSec: durSec,
    usage: job.usage,
    abortReason: job.abortReason ? redactSecrets(job.abortReason, secrets) : undefined,
    error: job.error ? redactSecrets(job.error, secrets) : undefined,
    diffSummary: job.diffSummary || undefined,
    directSummary: job.directSummary || undefined,
    sourceIntegrity: job.sourceIntegrity || undefined,
    finalReply: job.finalReply ? redactSecrets(job.finalReply.slice(0, 12000), secrets) : '',
    recentEvents: (job.events || []).slice(-12).map((ev) => ({
      ...ev,
      text: redactSecrets(ev.text, secrets),
    })),
  };
}

function sanitizeSessionForApp(s, contextUsageOverride = undefined) {
  if (!s) return null;
  // Exclude raw openaiMessages from UI state to keep payload compact
  const { openaiMessages, ...rest } = s;
  return {
    ...rest,
    contextUsage:
      contextUsageOverride !== undefined ? contextUsageOverride : normalizeContextUsage(s.contextUsage),
    hasFreshSummary: hasFreshSessionSummary(s),
    contentMessageCount: getContentMessageCount(s),
  };
}

async function buildCompactStateForApp(activeSessionId = '', personaId = '') {
  const bin = hub.getCodexBinaryFast();
  const defaults = readCodexUserDefaults();
  const quotaPromise = hub.getQuotaAsync();
  const pendingShadows = store.state.shadows
    .filter((s) => s.status !== 'discarded' && s.hasChanges)
    .map((s) => ({
      id: s.id,
      sourceDir: s.sourceDir,
      status: s.status,
      changedCount: s.changedCount,
      updatedAt: s.updatedAt,
      lastAppliedBackupId: s.lastAppliedBackupId,
    }));

  const undoableBackups = store.state.backups
    .filter((b) => !b.undone)
    .slice(-10)
    .reverse()
    .map((b) => ({
      id: b.id,
      shadowId: b.shadowId,
      sourceDir: b.sourceDir,
      addedCount: (b.addedFiles || []).length,
      modifiedCount: (b.modifiedFiles || []).length,
      deletedCount: (b.deletedFiles || []).length,
      createdAt: b.createdAt,
    }));

  const sessions = store.state.sessions
    .slice(-50)
    .reverse()
    .map((s) => ({
      id: s.id,
      personaId: s.personaId,
      provider: s.provider || 'codex-cli',
      title: s.title,
      sourceDir: s.sourceDir,
      shadowId: s.shadowId,
      codexThreadId: s.codexThreadId,
      model: s.model,
      reasoningEffort: s.reasoningEffort,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: (s.messages || []).length,
      contentMessageCount: getContentMessageCount(s),
      hasFreshSummary: hasFreshSessionSummary(s),
      hasInheritedSummary: Boolean(s.inheritedSummary?.summary),
      latestSummaryPreview: s.latestSummary?.summary ? s.latestSummary.summary.slice(0, 140) : '',
    }));

  let selectedSession = null;
  if (activeSessionId === '__none__') {
    selectedSession = null;
  } else if (activeSessionId) {
    selectedSession = store.getSession(activeSessionId);
  } else if (personaId) {
    for (let i = store.state.sessions.length - 1; i >= 0; i--) {
      if (store.state.sessions[i].personaId === personaId) {
        selectedSession = store.state.sessions[i];
        break;
      }
    }
  } else {
    selectedSession = store.state.sessions[store.state.sessions.length - 1] || null;
  }

  const jobDetailsById = {};
  if (selectedSession && Array.isArray(selectedSession.messages)) {
    for (const m of selectedSession.messages) {
      if (m.jobId && !jobDetailsById[m.jobId]) {
        const j = store.getJob(m.jobId);
        if (j) {
          jobDetailsById[m.jobId] = {
            id: j.id,
            provider: j.provider || 'codex-cli',
            status: j.status,
            model: j.model,
            reasoningEffort: j.reasoningEffort,
            fastMode: Boolean(j.fastMode),
            sandbox: j.sandbox,
            permissions: j.permissions || undefined,
            directMode: Boolean(j.directMode),
            shadowId: j.shadowId,
            startedAt: j.startedAt,
            finishedAt: j.finishedAt,
            usage: j.usage,
            error: j.error,
            abortReason: j.abortReason,
            diffSummary: j.diffSummary,
            directSummary: j.directSummary || undefined,
            sourceIntegrity: j.sourceIntegrity,
            events: (j.events || []).slice(-40),
          };
        }
      }
    }
  }

  const runningJobs = store.state.jobs
    .filter((j) => j.status === 'running')
    .map((j) => ({
      id: j.id,
      sessionId: j.sessionId,
      personaId: j.personaId,
      personaName: j.personaName,
      provider: j.provider || 'codex-cli',
      shadowId: j.shadowId,
      stage: j.stage || 'executing',
      stageLabel: j.stageLabel || '思考与执行中',
      model: j.model,
      reasoningEffort: j.reasoningEffort,
      sandbox: j.sandbox,
      directMode: Boolean(j.directMode),
      startedAt: j.startedAt,
      liveReply: (j.liveReply || '').slice(-4000),
      events: (j.events || []).slice(-40),
    }));

  const recentJobs = store.state.jobs
    .slice(-20)
    .reverse()
    .map((j) => ({
      id: j.id,
      sessionId: j.sessionId,
      personaName: j.personaName,
      provider: j.provider || 'codex-cli',
      shadowId: j.shadowId,
      status: j.status,
      model: j.model,
      sandbox: j.sandbox,
      directMode: Boolean(j.directMode),
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      diffSummary: j.diffSummary,
      directSummary: j.directSummary || undefined,
      sourceIntegrity: j.sourceIntegrity,
      error: j.error,
      abortReason: j.abortReason,
    }));

  let activeContextUsage = selectedSession ? normalizeContextUsage(selectedSession.contextUsage) : null;
  if (selectedSession) {
    const sessPersona = store.getPersona(selectedSession.personaId);
    const isApiSess =
      (selectedSession.provider || sessPersona?.provider || 'codex-cli') === 'openai-compatible';
    if (!isApiSess && selectedSession.codexThreadId) {
      const liveCtx = await hub.getCodexContextUsageAsync(selectedSession.codexThreadId);
      if (liveCtx) {
        selectedSession.contextUsage = liveCtx;
        activeContextUsage = liveCtx;
      }
    } else if (isApiSess && activeContextUsage) {
      const maxTokens =
        normalizeContextWindow(sessPersona?.contextWindow) || DEFAULT_OPENAI_CONTEXT_WINDOW;
      activeContextUsage = normalizeContextUsage({ ...activeContextUsage, maxTokens });
    }
  }
  const quota = await quotaPromise;

  return {
    codex: {
      available: Boolean(bin.path),
      version: bin.version,
      checking: Boolean(bin.checking),
    },
    quota,
    userProfile: store.getUserProfile(),
    defaultPermissions: store.getDefaultPermissions(),
    extraPath: store.getExtraPath(),
    autoNodeDir: getAutoNodeDir(),
    availableModels: defaults.models,
    modelReasoningLevels: defaults.modelReasoningLevels,
    personas: store.listPersonas().map(sanitizePersonaForApp),
    sessions,
    activeSession: sanitizeSessionForApp(selectedSession, activeContextUsage),
    jobDetailsById,
    runningJobs,
    recentJobs,
    pendingShadows,
    undoableBackups,
    drafts: store.state.drafts || {},
    recentSourceDirs: store.state.recentSourceDirs || [],
    updatedAt: store.state.updatedAt,
  };
}

function jsonResult(data, textSummary = '') {
  return {
    content: [
      {
        type: 'text',
        text: textSummary || JSON.stringify(data, null, 2),
      },
    ],
    structuredContent: data,
  };
}

const ReasoningEffortSchema = z
  .enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  .optional();

const PermissionsSchema = z
  .object({
    fileScope: z.enum(['read-only', 'shadow', 'direct']).optional(),
    commandPolicy: z.enum(['auto', 'disabled']).optional(),
    networkPolicy: z.enum(['allow', 'deny']).optional(),
  })
  .optional();

const server = new McpServer({
  name: 'sidedesk',
  version: '0.1.0',
});

// 1. Register MCP App HTML resource
registerAppResource(
  server,
  'SideDesk · 副席界面',
  APP_URI,
  {
    description: 'SideDesk 副席单文件交互面板（多引擎人物卡、实时进度、红绿 Diff 验收与撤销）',
    _meta: { ui: { prefersBorder: false } },
  },
  async () => ({
    contents: [
      {
        uri: APP_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: loadAppHtml(),
        _meta: { ui: { prefersBorder: false } },
      },
    ],
  })
);

// ===========================================================================
// Model-visible tools (strictly sanitized; NEVER expose apiKey or raw diff)
// ===========================================================================

const AUX_PANE_META = {
  ui: { resourceUri: APP_URI },
  'com.google.antigravity/ui': {
    entrypoints: [{ type: 'aux_pane', title: 'SideDesk · 副席' }],
  },
};

registerAppTool(
  server,
  'sidedesk_open',
  {
    title: 'SideDesk · 副席',
    description:
      '打开或刷新右侧 SideDesk · 副席面板，查看双引擎人物卡、运行中任务与待验收的影子副本 Diff。支持空参数调用。',
    inputSchema: {
      sessionId: z.string().optional().describe('可选：聚焦到指定副席会话 ID'),
    },
    _meta: AUX_PANE_META,
  },
  async ({ sessionId } = {}) => {
    const snap = await buildCompactStateForApp(sessionId || '');
    return jsonResult({
      ok: true,
      codexAvailable: snap.codex.available,
      codexVersion: snap.codex.version,
      personaCount: snap.personas.length,
      runningJobCount: snap.runningJobs.length,
      pendingDiffShadowCount: snap.pendingShadows.length,
      activeSessionId: snap.activeSession?.id || null,
    });
  }
);

server.registerTool(
  'sidedesk_list_personas',
  {
    title: '列出副席人物卡',
    description: '列出 SideDesk 中配置的所有人物卡（含驱动引擎类型、模型与权限），绝不返回任何密钥。',
    inputSchema: {},
  },
  async () => {
    const bin = hub.getCodexBinaryFast();
    const defaults = readCodexUserDefaults();
    return jsonResult({
      ok: true,
      codexAvailable: Boolean(bin.path),
      codexVersion: bin.version,
      codexChecking: Boolean(bin.checking),
      availableModels: defaults.models,
      modelReasoningLevels: defaults.modelReasoningLevels,
      personas: store.listPersonas().map(sanitizePersonaForModel),
    });
  }
);

registerAppTool(
  server,
  'sidedesk_dispatch',
  {
    title: '向 SideDesk 人物卡派单',
    description:
      '将后端分析、审计或编码任务派发给 SideDesk 副席中的指定人物卡（自动按人物卡驱动路由至本机 Codex CLI 或 OpenAI 兼容 API）。默认必须在隔离影子副本中执行（read-only / workspace-write），原工程目录零修改；仅当用户明确要求 Turbo / 直接改原目录，或目标人物卡默认权限为 turbo-direct 时，才允许使用 turbo-direct（跳过影子副本与容量熔断，直接在原目录无沙箱执行）。',
    inputSchema: {
      sourceDir: z.string().describe('目标工程绝对路径（影子模式下创建隔离副本；turbo-direct 下直接在原目录执行）'),
      prompt: z.string().describe('清晰、自包含的任务指令与验收标准'),
      personaId: z.string().optional().describe('可选：人物卡 ID，默认使用第一张卡（codex-default）'),
      sessionId: z.string().optional().describe('可选：传入已有副席 sessionId 以续聊同一上下文'),
      sandbox: z
        .enum(['read-only', 'workspace-write', 'turbo-direct'])
        .optional()
        .describe(
          '权限模式：默认必须优先选 read-only（纯只读分析）或 workspace-write（影子副本隔离读写）。严禁私自升级为 turbo-direct（直接操作原目录无沙箱、无容量熔断）；仅当用户明确要求开启 Turbo/直通模式或人物卡默认设为 turbo-direct 时使用。'
        ),
      model: z.string().optional().describe('可选：覆盖人物卡默认模型'),
      reasoningEffort: ReasoningEffortSchema.describe('可选：Codex CLI 推理强度（支持 minimal/low/medium/high/xhigh/max/ultra）'),
      fastMode: z.boolean().optional().describe('可选：Codex CLI 闪电加速（2x 速度，会增加订阅额度消耗）'),
      title: z.string().optional().describe('可选：本话题标题'),
      waitSeconds: z
        .number()
        .min(0)
        .max(120)
        .optional()
        .describe('可选：同步等待秒数（默认 0 立即返回 jobId 供异步查询）'),
    },
    _meta: { ui: { resourceUri: APP_URI } },
  },
  async (args) => {
    store.recordSourceDir(args.sourceDir);
    const { job } = hub.startJob({
      sourceDir: args.sourceDir,
      prompt: args.prompt,
      personaId: args.personaId || '',
      sessionId: args.sessionId || '',
      sandbox: args.sandbox || '',
      model: args.model || '',
      reasoningEffort: args.reasoningEffort || '',
      fastMode: args.fastMode,
      title: args.title || '',
      createdBy: 'hakimi',
    });

    const waitSec = Number(args.waitSeconds || 0);
    const current = waitSec > 0 ? await hub.waitForJob(job.id, waitSec) : job;
    return jsonResult({
      ok: current.status !== 'failed',
      ...summarizeJobForModel(current),
    });
  }
);

server.registerTool(
  'sidedesk_job_status',
  {
    title: '查询副席任务进度与结果',
    description:
      '查询指定 jobId 的运行状态、实时进度、影子副本改动摘要、源目录完整性校验与最终回复。可配合 waitSeconds 优雅等待。',
    inputSchema: {
      jobId: z.string().describe('sidedesk_dispatch 返回的 jobId'),
      waitSeconds: z.number().min(0).max(120).optional().describe('可选：最多等待多少秒再返回（默认 0）'),
    },
  },
  async ({ jobId, waitSeconds = 0 }) => {
    const job =
      waitSeconds > 0 ? await hub.waitForJob(jobId, waitSeconds) : store.getJob(jobId);
    if (!job) {
      return jsonResult({ ok: false, error: `未找到任务: ${jobId}` });
    }
    return jsonResult({
      ok: job.status !== 'failed',
      ...summarizeJobForModel(job),
    });
  }
);

server.registerTool(
  'sidedesk_abort_job',
  {
    title: '中止运行中的副席任务',
    description: '立即中止运行中的 Codex 进程树或 OpenAI API 流式请求，并将任务标记为 aborted（绝不自动重发）。',
    inputSchema: {
      jobId: z.string().describe('要中止的 jobId'),
      reason: z.string().optional().describe('可选：中止原因'),
    },
  },
  async ({ jobId, reason }) => {
    const res = hub.abortJob(jobId, reason || '主对话请求中止任务');
    return jsonResult({
      ok: true,
      aborted: res.aborted,
      status: res.status,
      jobId,
    });
  }
);

// ===========================================================================
// App-only tools (visibility: ["app"] — hidden from model)
// ===========================================================================

const APP_ONLY_META = {
  ui: {
    resourceUri: APP_URI,
    visibility: ['app'],
  },
};

registerAppTool(
  server,
  'app_get_state',
  {
    title: '获取副席面板状态',
    description: 'UI 专用：拉取脱敏后的人物卡、会话、实时任务流、待验收影子副本与可撤销备份。',
    inputSchema: {
      sessionId: z.string().optional(),
      personaId: z.string().optional(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ sessionId, personaId } = {}) =>
    jsonResult(await buildCompactStateForApp(sessionId || '', personaId || ''))
);

registerAppTool(
  server,
  'app_refresh_quota',
  {
    title: '刷新本地 Codex 配额与上下文快照',
    description:
      'UI 专用：零网络开销重新扫描本机 ~/.codex/sessions 最新 token_count 快照，并同步当前话题上下文水位。',
    inputSchema: {
      sessionId: z.string().optional(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ sessionId = '' } = {}) => {
    const { quota, contextUsage } = await hub.refreshQuotaAsync(sessionId);
    return jsonResult({ ok: true, quota, contextUsage });
  }
);

registerAppTool(
  server,
  'app_get_diff',
  {
    title: '获取影子副本红绿 Diff',
    description: 'UI 专用：按需计算并拉取指定影子副本的完整文件变更与红绿 Unified Diff。',
    inputSchema: { shadowId: z.string() },
    _meta: APP_ONLY_META,
  },
  async ({ shadowId }) => {
    const shadow = store.getShadow(shadowId);
    if (!shadow) return jsonResult({ ok: false, error: `未找到影子副本: ${shadowId}` });
    const diff = computeShadowDiff(shadow);
    shadow.hasChanges = diff.hasChanges;
    shadow.changedCount = diff.stats.totalFiles;
    store.scheduleSave();
    return jsonResult({ ok: true, diff });
  }
);

registerAppTool(
  server,
  'app_save_persona',
  {
    title: '保存人物卡',
    description: 'UI 专用：新增或编辑人物卡（支持 Codex CLI 与 OpenAI 兼容 API，返回脱敏结构）。',
    inputSchema: {
      id: z.string().optional(),
      name: z.string(),
      role: z.string().optional(),
      avatar: z.string().optional(),
      addressUserAs: z.string().optional(),
      memories: z
        .array(
          z.object({
            id: z.string().optional(),
            text: z.string(),
            enabled: z.boolean().optional(),
          })
        )
        .max(50)
        .optional(),
      provider: z.enum(['codex-cli', 'openai-compatible']).optional(),
      systemPrompt: z.string().optional(),
      model: z.string().optional(),
      reasoningEffort: ReasoningEffortSchema,
      fastMode: z.boolean().optional(),
      cleanCodexConfig: z.boolean().optional(),
      customCodexPath: z.string().optional(),
      defaultSandbox: z.enum(['read-only', 'workspace-write', 'turbo-direct']).optional(),
      permissions: PermissionsSchema,
      baseUrl: z.string().optional(),
      apiKey: z.string().optional(),
      clearApiKey: z.boolean().optional(),
      toolMode: z.enum(['agent', 'chat']).optional(),
      contextWindow: z.number().int().min(0).max(10_000_000).optional(),
    },
    _meta: APP_ONLY_META,
  },
  async (args) => {
    const persona = store.savePersona(args);
    return jsonResult({
      ok: true,
      persona: sanitizePersonaForApp(persona),
      personas: store.listPersonas().map(sanitizePersonaForApp),
    });
  }
);

registerAppTool(
  server,
  'app_delete_persona',
  {
    title: '删除人物卡',
    description: 'UI 专用：删除指定人物卡。',
    inputSchema: { id: z.string() },
    _meta: APP_ONLY_META,
  },
  async ({ id }) => {
    const removed = store.deletePersona(id);
    return jsonResult({
      ok: true,
      removed: sanitizePersonaForApp(removed),
      personas: store.listPersonas().map(sanitizePersonaForApp),
    });
  }
);

registerAppTool(
  server,
  'app_test_provider',
  {
    title: '测试引擎连接或重新检测 Codex',
    description:
      'UI 专用：provider=codex-cli 时异步重新探测本机 codex.exe；provider=openai-compatible 时向 Base URL 发最小化探测请求返回延迟或错误。',
    inputSchema: {
      provider: z.enum(['codex-cli', 'openai-compatible']).optional(),
      customCodexPath: z.string().optional(),
      baseUrl: z.string().optional(),
      apiKey: z.string().optional(),
      model: z.string().optional(),
      existingPersonaId: z.string().optional(),
      clearApiKey: z.boolean().optional(),
    },
    _meta: APP_ONLY_META,
  },
  async (args) => {
    if (args.provider === 'codex-cli') {
      const start = Date.now();
      const customPath = String(args.customCodexPath || '').trim();
      const bin = await hub.refreshCodexBinaryAsync(customPath);
      return jsonResult({
        ok: Boolean(bin.path),
        latencyMs: Date.now() - start,
        codexAvailable: Boolean(bin.path),
        codexVersion: bin.version,
        error: bin.path
          ? undefined
          : customPath
            ? `指定的 Codex 路径无效或不可执行: ${customPath}`
            : '未检测到本机 Codex CLI',
      });
    }
    const res = await hub.testOpenAiConnection(args);
    return jsonResult(res);
  }
);

registerAppTool(
  server,
  'app_boss_send',
  {
    title: '副席工位直聊发送',
    description: 'UI 专用：用户在副席直接给当前人物卡发消息（<50ms 瞬时异步启动，支持三组权限胶囊与图片附件）。',
    inputSchema: {
      sourceDir: z.string(),
      prompt: z.string(),
      personaId: z.string().optional(),
      sessionId: z.string().optional(),
      sandbox: z.enum(['read-only', 'workspace-write', 'turbo-direct']).optional(),
      permissions: PermissionsSchema,
      model: z.string().optional(),
      reasoningEffort: ReasoningEffortSchema,
      fastMode: z.boolean().optional(),
      title: z.string().optional(),
      attachments: z
        .array(
          z.object({
            name: z.string().optional(),
            dataUrl: z.string(),
            previewDataUrl: z.string().optional(),
          })
        )
        .max(6)
        .optional(),
    },
    _meta: APP_ONLY_META,
  },
  async (args) => {
    store.recordSourceDir(args.sourceDir);
    const savedAttachments = [];
    if (Array.isArray(args.attachments)) {
      for (const att of args.attachments) {
        if (!att?.dataUrl) continue;
        const saved = store.saveAttachmentFromDataUrl(att.dataUrl, att.name || 'image.png');
        savedAttachments.push({
          ...saved,
          dataUrl: att.dataUrl,
          previewDataUrl:
            att.previewDataUrl || (att.dataUrl.length <= 120_000 ? att.dataUrl : ''),
        });
      }
    }
    const { job, session, shadow } = hub.startJob({
      ...args,
      attachments: savedAttachments,
      createdBy: 'boss',
    });
    store.saveDraft(args.sessionId || 'new', { text: '', sourceDir: args.sourceDir });
    store.saveDraft(session.id, { text: '', sourceDir: args.sourceDir });
    return jsonResult({
      ok: true,
      jobId: job.id,
      sessionId: session.id,
      shadowId: shadow ? shadow.id : null,
      directMode: Boolean(job.directMode),
      status: job.status,
      stage: job.stage,
      stageLabel: job.stageLabel,
    });
  }
);

registerAppTool(
  server,
  'app_save_draft',
  {
    title: '保存未发送草稿',
    description: 'UI 专用：实时把输入框草稿与目标路径持久化到后端，防收起面板丢失。',
    inputSchema: {
      key: z.string().optional(),
      text: z.string().optional(),
      sourceDir: z.string().optional(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ key = 'default', text = '', sourceDir = '' } = {}) => {
    if (sourceDir) store.recordSourceDir(sourceDir);
    const draft = store.saveDraft(key, { text, sourceDir });
    return jsonResult({ ok: true, draft });
  }
);

registerAppTool(
  server,
  'app_abort_job',
  {
    title: 'UI 中止任务',
    description: 'UI 专用：强杀运行中的 Codex 进程树或中断 API 流式请求。',
    inputSchema: {
      jobId: z.string(),
      reason: z.string().optional(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ jobId, reason }) => {
    const res = hub.abortJob(jobId, reason || '用户在副席面板手动中止');
    return jsonResult({ ok: true, aborted: res.aborted, status: res.status });
  }
);

registerAppTool(
  server,
  'app_emergency_trip',
  {
    title: '全局急停熔断开关',
    description:
      'UI 专用：一次性强杀所有会话运行中的 Codex 进程树与在途 API 请求（绝不重发），并将在途全局 Turbo 直通安全降级回影子隔离。',
    inputSchema: {
      reason: z.string().optional(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ reason } = {}) => {
    const res = hub.emergencyTrip(reason || '用户在副席面板触发全局急停熔断');
    return jsonResult(res);
  }
);

registerAppTool(
  server,
  'app_apply_shadow',
  {
    title: '应用影子副本到原目录',
    description: 'UI 专用：冲突预检 → 自动快照备份原文件 → 应用改动到原工程目录。',
    inputSchema: {
      shadowId: z.string(),
      force: z.boolean().optional(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ shadowId, force = false }) => {
    const shadow = store.getShadow(shadowId);
    if (!shadow) return jsonResult({ ok: false, error: `未找到影子副本: ${shadowId}` });
    if (hub.hasRunningJobForShadow(shadowId)) {
      return jsonResult({
        ok: false,
        error: '该影子副本仍有任务正在运行，请等待完成或先点击停止后再应用写回',
      });
    }
    const res = applyShadowToSource(store, shadow, { force });
    return jsonResult({ ok: Boolean(res.applied), ...res });
  }
);

registerAppTool(
  server,
  'app_undo_last_apply',
  {
    title: '撤销上次应用',
    description: 'UI 专用：按备份快照精确还原修改/删除的原文件，并清理该轮新增文件。',
    inputSchema: {
      backupId: z.string().optional(),
      sourceDir: z.string().optional(),
      force: z.boolean().optional(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ backupId = '', sourceDir = '', force = false } = {}) => {
    const res = undoLastApply(store, { backupId, sourceDir, force });
    return jsonResult({ ok: Boolean(res.undone), ...res });
  }
);

registerAppTool(
  server,
  'app_discard_shadow',
  {
    title: '丢弃影子副本',
    description: 'UI 专用：删除影子副本及其未应用的改动，不触碰原目录。',
    inputSchema: { shadowId: z.string() },
    _meta: APP_ONLY_META,
  },
  async ({ shadowId }) => {
    if (hub.hasRunningJobForShadow(shadowId)) {
      throw new Error('该影子副本仍有任务正在运行，请等待完成或先点击停止后再丢弃');
    }
    const res = discardShadow(store, shadowId);
    return jsonResult({ ok: true, ...res });
  }
);

registerAppTool(
  server,
  'app_new_session',
  {
    title: '开启新副席话题',
    description:
      'UI 专用：为指定人物卡与工程目录开启全新话题（旧话题保留归档），可选继承压缩上下文摘要（已有新鲜摘要时零额度复用）。',
    inputSchema: {
      personaId: z.string(),
      sourceDir: z.string(),
      title: z.string().optional(),
      sourceSessionId: z.string().optional(),
      inheritSummary: z.boolean().optional(),
      summarizerPersonaId: z.string().optional(),
    },
    _meta: APP_ONLY_META,
  },
  async ({
    personaId,
    sourceDir,
    title,
    sourceSessionId = '',
    inheritSummary = false,
    summarizerPersonaId = '',
  }) => {
    const persona = store.getPersona(personaId) || store.listPersonas()[0];
    let inherited = null;
    let reusedSummary = false;

    if (inheritSummary && sourceSessionId) {
      const srcSess = store.getSession(sourceSessionId);
      if (srcSess && getContentMessageCount(srcSess) > 0) {
        const sumRes = await hub.summarizeSessionAsync({
          sessionId: srcSess.id,
          summarizerPersonaId: summarizerPersonaId || persona.id,
          reuseIfFresh: true,
        });
        reusedSummary = Boolean(sumRes.reused);
        inherited = {
          sourceSessionId: srcSess.id,
          sourceTitle: srcSess.title,
          summary: sumRes.summary,
          updatedAt: Date.now(),
        };
      }
    }

    const sess = store.createSession({
      personaId: persona.id,
      provider: persona.provider || 'codex-cli',
      title: title || '新话题',
      sourceDir,
      model: persona.model,
      reasoningEffort: persona.reasoningEffort,
      inheritedSummary: inherited,
    });
    return jsonResult({
      ok: true,
      reusedSummary,
      session: sanitizeSessionForApp(sess),
    });
  }
);

registerAppTool(
  server,
  'app_save_user_profile',
  {
    title: '保存用户个人资料',
    description: 'UI 专用：保存用户的称呼、头像与外观主题偏好到插件持久化目录；自定义称呼将自动注入双引擎指令。',
    inputSchema: {
      userName: z.string().optional(),
      userAvatar: z.string().optional(),
      themeMode: z.enum(['auto', 'light', 'dark']).optional(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ userName, userAvatar, themeMode } = {}) => {
    const userProfile = store.saveUserProfile({ userName, userAvatar, themeMode });
    return jsonResult({ ok: true, userProfile });
  }
);

registerAppTool(
  server,
  'app_set_theme',
  {
    title: '切换外观主题',
    description: 'UI 专用：轻量持久化外观主题模式（auto 跟随宿主 / light 浅色羊皮纸 / dark 深色暖炭），防关面板丢失。',
    inputSchema: {
      themeMode: z.enum(['auto', 'light', 'dark']),
    },
    _meta: APP_ONLY_META,
  },
  async ({ themeMode }) => {
    const userProfile = store.saveUserProfile({ themeMode });
    return jsonResult({ ok: true, themeMode: userProfile.themeMode, userProfile });
  }
);

registerAppTool(
  server,
  'app_save_default_permissions',
  {
    title: '保存全局默认设置与附加 PATH',
    description: 'UI 专用：保存三组全局默认权限胶囊（fileScope / commandPolicy / networkPolicy）及附加 PATH 环境变量。',
    inputSchema: {
      fileScope: z.enum(['read-only', 'shadow', 'direct']).optional(),
      commandPolicy: z.enum(['auto', 'disabled']).optional(),
      networkPolicy: z.enum(['allow', 'deny']).optional(),
      extraPath: z.string().max(4096).optional(),
    },
    _meta: APP_ONLY_META,
  },
  async (args = {}) => {
    const defaultPermissions = store.saveDefaultPermissions(args);
    return jsonResult({
      ok: true,
      defaultPermissions,
      extraPath: store.getExtraPath(),
      autoNodeDir: getAutoNodeDir(),
    });
  }
);

registerAppTool(
  server,
  'app_clear_inherited_summary',
  {
    title: '解绑当前话题继承摘要',
    description: 'UI 专用：移除当前话题的 inheritedSummary，后续轮次不再注入前序摘要。',
    inputSchema: { sessionId: z.string() },
    _meta: APP_ONLY_META,
  },
  async ({ sessionId }) => {
    const sess = store.clearSessionInheritedSummary(sessionId);
    return jsonResult({ ok: true, session: sanitizeSessionForApp(sess) });
  }
);

registerAppTool(
  server,
  'app_update_inherited_summary',
  {
    title: '更新当前话题继承摘要文本',
    description: 'UI 专用：允许用户直接微调当前话题顶部的继承摘要内容。',
    inputSchema: {
      sessionId: z.string(),
      summary: z.string(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ sessionId, summary }) => {
    const sess = store.setSessionInheritedSummary(sessionId, { summary });
    return jsonResult({ ok: true, session: sanitizeSessionForApp(sess) });
  }
);

registerAppTool(
  server,
  'app_compress_session',
  {
    title: '原地压缩话题上下文',
    description: 'UI 专用：将指定话题压缩为摘要、重置底层长线程并将摘要挂载到当前话题顶部继续。',
    inputSchema: {
      sessionId: z.string(),
      summarizerPersonaId: z.string().optional(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ sessionId, summarizerPersonaId = '' }) => {
    const res = await hub.compressSessionInPlaceAsync({ sessionId, summarizerPersonaId });
    return jsonResult({
      ok: true,
      summary: res.summary,
      meta: res.meta,
      session: sanitizeSessionForApp(res.session),
    });
  }
);

registerAppTool(
  server,
  'app_rename_session',
  {
    title: '重命名话题',
    description: 'UI 专用：修改指定话题的标题。',
    inputSchema: {
      sessionId: z.string(),
      title: z.string(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ sessionId, title }) => {
    const sess = store.renameSession(sessionId, title);
    return jsonResult({ ok: true, session: sanitizeSessionForApp(sess) });
  }
);

registerAppTool(
  server,
  'app_export_session',
  {
    title: '导出话题为 Markdown',
    description: 'UI 专用：导出指定话题完整记录为 .md 文件并返回内容与保存路径。',
    inputSchema: { sessionId: z.string() },
    _meta: APP_ONLY_META,
  },
  async ({ sessionId }) => {
    const exported = store.exportSessionMarkdown(sessionId);
    return jsonResult({ ok: true, ...exported });
  }
);

registerAppTool(
  server,
  'app_clear_session',
  {
    title: '清空话题消息',
    description: 'UI 专用：清空指定话题的对话记录并重置线程。',
    inputSchema: { sessionId: z.string() },
    _meta: APP_ONLY_META,
  },
  async ({ sessionId }) => {
    const sess = store.clearSessionMessages(sessionId);
    return jsonResult({ ok: true, session: sanitizeSessionForApp(sess) });
  }
);

registerAppTool(
  server,
  'app_delete_session',
  {
    title: '删除话题',
    description: 'UI 专用：永久删除指定归档或当前话题记录。',
    inputSchema: { sessionId: z.string() },
    _meta: APP_ONLY_META,
  },
  async ({ sessionId }) => {
    const removed = store.deleteSession(sessionId);
    return jsonResult({ ok: true, deletedId: removed.id });
  }
);

const CLIPBOARD_IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

function readClipboardImageAsync(mode = 'avatar') {
  return new Promise((resolvePromise) => {
    if (process.platform !== 'win32') {
      resolvePromise({
        ok: false,
        error: '当前系统暂不支持直接读取系统剪贴板，请改用「上传图片」或在界面按 Ctrl/Cmd+V 粘贴',
      });
      return;
    }
    const isAttachment = mode === 'attachment';
    const psScript = isAttachment
      ? [
          '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
          'Add-Type -AssemblyName System.Windows.Forms',
          'Add-Type -AssemblyName System.Drawing',
          'if ([System.Windows.Forms.Clipboard]::ContainsImage()) {',
          '  $img = [System.Windows.Forms.Clipboard]::GetImage()',
          '  if ($null -ne $img) {',
          '    $maxSide = 1600',
          '    $scale = [Math]::Min(1.0, [Math]::Min($maxSide / [double]$img.Width, $maxSide / [double]$img.Height))',
          '    $dw = [Math]::Max(1, [int]([Math]::Round($img.Width * $scale)))',
          '    $dh = [Math]::Max(1, [int]([Math]::Round($img.Height * $scale)))',
          '    $bmp = New-Object System.Drawing.Bitmap($dw, $dh)',
          '    $g = [System.Drawing.Graphics]::FromImage($bmp)',
          '    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
          '    $g.DrawImage($img, 0, 0, $dw, $dh)',
          '    $ms = New-Object System.IO.MemoryStream',
          '    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)',
          '    $g.Dispose(); $bmp.Dispose(); $img.Dispose()',
          '    Write-Output ("B64:" + [Convert]::ToBase64String($ms.ToArray()))',
          '    $ms.Dispose()',
          '    exit 0',
          '  }',
          '}',
          'if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {',
          '  $files = [System.Windows.Forms.Clipboard]::GetFileDropList()',
          '  foreach ($f in $files) {',
          '    if ($f -match "\\.(png|jpe?g|webp|gif|bmp)$") {',
          '      Write-Output ("FILE:" + $f)',
          '      exit 0',
          '    }',
          '  }',
          '}',
          'Write-Output "EMPTY"',
        ].join('\n')
      : [
          '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
          'Add-Type -AssemblyName System.Windows.Forms',
          'Add-Type -AssemblyName System.Drawing',
          'if ([System.Windows.Forms.Clipboard]::ContainsImage()) {',
          '  $img = [System.Windows.Forms.Clipboard]::GetImage()',
          '  if ($null -ne $img) {',
          '    $side = [Math]::Min($img.Width, $img.Height)',
          '    $sx = [int](($img.Width - $side) / 2)',
          '    $sy = [int](($img.Height - $side) / 2)',
          '    $bmp = New-Object System.Drawing.Bitmap(192, 192)',
          '    $g = [System.Drawing.Graphics]::FromImage($bmp)',
          '    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
          '    $rectDst = New-Object System.Drawing.Rectangle(0, 0, 192, 192)',
          '    $rectSrc = New-Object System.Drawing.Rectangle($sx, $sy, $side, $side)',
          '    $g.DrawImage($img, $rectDst, $rectSrc, [System.Drawing.GraphicsUnit]::Pixel)',
          '    $ms = New-Object System.IO.MemoryStream',
          '    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)',
          '    $g.Dispose(); $bmp.Dispose(); $img.Dispose()',
          '    Write-Output ("B64:" + [Convert]::ToBase64String($ms.ToArray()))',
          '    $ms.Dispose()',
          '    exit 0',
          '  }',
          '}',
          'if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {',
          '  $files = [System.Windows.Forms.Clipboard]::GetFileDropList()',
          '  foreach ($f in $files) {',
          '    if ($f -match "\\.(png|jpe?g|webp|gif|bmp)$") {',
          '      Write-Output ("FILE:" + $f)',
          '      exit 0',
          '    }',
          '  }',
          '}',
          'Write-Output "EMPTY"',
        ].join('\n');

    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Sta', '-Command', psScript],
      { encoding: 'utf8', timeout: 8000, maxBuffer: 12 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolvePromise({ ok: false, error: '读取剪贴板失败，请改点「上传图片」' });
          return;
        }
        const out = String(stdout || '').trim();
        if (out.startsWith('B64:')) {
          const b64 = out.slice(4).trim();
          if (b64) {
            resolvePromise({ ok: true, dataUrl: `data:image/png;base64,${b64}` });
            return;
          }
        }
        if (out.startsWith('FILE:')) {
          const filePath = out.slice(5).trim();
          const ext = extname(filePath).toLowerCase();
          const mime = CLIPBOARD_IMAGE_MIME[ext];
          try {
            if (mime && existsSync(filePath)) {
              const st = statSync(filePath);
              if (st.size > 0 && st.size <= 15 * 1024 * 1024) {
                const buf = readFileSync(filePath);
                resolvePromise({ ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}` });
                return;
              }
            }
          } catch {
            // fallthrough
          }
        }
        resolvePromise({
          ok: false,
          error: '剪贴板里没有检测到图片（支持截图、复制网页图或在资源管理器 Ctrl+C 复制图片文件）',
        });
      }
    );
  });
}

registerAppTool(
  server,
  'app_paste_clipboard_image',
  {
    title: '从系统剪贴板粘贴图片',
    description: 'UI 专用：读取系统剪贴板中的位图截图或复制的图片文件，供头像裁剪或聊天附图使用。',
    inputSchema: {
      mode: z.enum(['avatar', 'attachment']).optional(),
    },
    _meta: APP_ONLY_META,
  },
  async ({ mode = 'avatar' } = {}) => {
    const res = await readClipboardImageAsync(mode);
    return jsonResult(res);
  }
);

function onExit() {
  hub.shutdownAll();
  process.exit(0);
}
process.on('SIGINT', onExit);
process.on('SIGTERM', onExit);

const transport = new StdioServerTransport();
await server.connect(transport);
