import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  atomicWriteFileSync,
  isSafeBitmapDataUrl,
  redactSecrets,
} from './security.mjs';

export const VALID_PROVIDERS = ['codex-cli', 'openai-compatible'];
export const VALID_TOOL_MODES = ['agent', 'chat'];
export const VALID_SANDBOXES = ['read-only', 'workspace-write', 'turbo-direct'];
export const VALID_FILE_SCOPES = ['read-only', 'shadow', 'direct'];
export const VALID_COMMAND_POLICIES = ['auto', 'disabled'];
export const VALID_NETWORK_POLICIES = ['allow', 'deny'];
export const VALID_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const DEFAULT_REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const VALID_THEME_MODES = ['auto', 'light', 'dark'];
export const DEFAULT_OPENAI_CONTEXT_WINDOW = 128_000;

export function normalizeContextWindow(val) {
  if (val === undefined || val === null || val === '') return 0;
  const n = Math.round(Number(val));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(10_000_000, Math.max(1024, n));
}

export function normalizeContextUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const usedTokens = Math.max(0, Math.round(Number(raw.usedTokens) || 0));
  const inputTokens = Math.max(0, Math.round(Number(raw.inputTokens) || 0));
  const outputTokens = Math.max(0, Math.round(Number(raw.outputTokens) || 0));
  const cachedTokens = Math.max(0, Math.round(Number(raw.cachedTokens) || 0));
  const reasoningTokens = Math.max(0, Math.round(Number(raw.reasoningTokens) || 0));
  const maxTokens = Math.max(0, Math.round(Number(raw.maxTokens) || 0));
  if (usedTokens === 0 && inputTokens === 0 && maxTokens === 0) return null;
  const computedPct =
    maxTokens > 0
      ? Math.min(100, Math.max(0, Math.round((usedTokens / maxTokens) * 1000) / 10))
      : Math.min(100, Math.max(0, Math.round((Number(raw.usedPercent) || 0) * 10) / 10));
  return {
    usedTokens,
    inputTokens,
    outputTokens,
    cachedTokens,
    reasoningTokens,
    maxTokens,
    usedPercent: computedPct,
    source: typeof raw.source === 'string' && raw.source ? raw.source : 'unknown',
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

export const PRESET_SAFE_PERMISSIONS = Object.freeze({
  fileScope: 'shadow',
  commandPolicy: 'auto',
  networkPolicy: 'deny',
});

export const PRESET_TURBO_PERMISSIONS = Object.freeze({
  fileScope: 'direct',
  commandPolicy: 'auto',
  networkPolicy: 'allow',
});

export function permissionsFromSandbox(sandbox = 'workspace-write') {
  if (sandbox === 'turbo-direct') {
    return { ...PRESET_TURBO_PERMISSIONS };
  }
  if (sandbox === 'read-only') {
    return {
      fileScope: 'read-only',
      commandPolicy: 'auto',
      networkPolicy: 'deny',
    };
  }
  return { ...PRESET_SAFE_PERMISSIONS };
}

export function permissionsToSandbox(perms) {
  const scope = perms?.fileScope;
  if (scope === 'direct') return 'turbo-direct';
  if (scope === 'read-only') return 'read-only';
  return 'workspace-write';
}

export function normalizePermissions(input, fallbackSandbox = 'workspace-write') {
  const base = permissionsFromSandbox(
    VALID_SANDBOXES.includes(fallbackSandbox) ? fallbackSandbox : 'workspace-write'
  );
  if (!input || typeof input !== 'object') {
    return base;
  }
  return {
    fileScope: VALID_FILE_SCOPES.includes(input.fileScope) ? input.fileScope : base.fileScope,
    commandPolicy: VALID_COMMAND_POLICIES.includes(input.commandPolicy)
      ? input.commandPolicy
      : base.commandPolicy,
    networkPolicy: VALID_NETWORK_POLICIES.includes(input.networkPolicy)
      ? input.networkPolicy
      : base.networkPolicy,
  };
}

export function maskApiKey(rawKey) {
  const k = String(rawKey || '').trim();
  if (!k) return '';
  if (k.length <= 8) return '****';
  return `${k.slice(0, 3)}...${k.slice(-4)}`;
}

export function normalizeSafeAvatar(rawAvatar, fallback = '🤖') {
  const val = typeof rawAvatar === 'string' ? rawAvatar.trim() : '';
  if (!val) return fallback;
  if (/^data:/i.test(val)) {
    if (!isSafeBitmapDataUrl(val)) {
      throw new Error('头像图片格式不安全或不受支持，仅允许 PNG/JPG/WebP/GIF/BMP 位图');
    }
    return val;
  }
  if (/^(?:javascript|vbscript|file|https?):/i.test(val)) {
    return fallback;
  }
  return val.slice(0, 16);
}

export function normalizeMemories(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const text = String(item.text || '').trim().slice(0, 300);
    if (!text) continue;
    out.push({
      id: String(item.id || `mem-${randomUUID().slice(0, 8)}`).trim(),
      text,
      enabled: item.enabled !== false,
    });
    if (out.length >= 50) break;
  }
  return out;
}

export function normalizeAnchorState(raw, defaultForceSync = false) {
  if (!raw || typeof raw !== 'object') {
    return {
      digest: '',
      turnsSinceSync: 0,
      charsSinceSync: 0,
      forceSync: Boolean(defaultForceSync),
    };
  }
  return {
    digest: String(raw.digest || ''),
    turnsSinceSync: Math.max(0, Number(raw.turnsSinceSync) || 0),
    charsSinceSync: Math.max(0, Number(raw.charsSinceSync) || 0),
    forceSync: Boolean(raw.forceSync),
  };
}

/**
 * Model-visible projection: NEVER exposes apiKey, hasApiKey, apiKeyHint, or private auth details.
 */
export function sanitizePersonaForModel(p) {
  if (!p) return null;
  const permissions = normalizePermissions(p.permissions, p.defaultSandbox);
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    avatar: p.avatar,
    addressUserAs: String(p.addressUserAs || '').trim(),
    memoriesCount: normalizeMemories(p.memories).filter((m) => m.enabled).length,
    provider: p.provider || 'codex-cli',
    model: p.model,
    reasoningEffort: p.provider === 'openai-compatible' ? undefined : p.reasoningEffort,
    fastMode: p.provider === 'openai-compatible' ? undefined : Boolean(p.fastMode),
    cleanCodexConfig: p.provider === 'openai-compatible' ? undefined : p.cleanCodexConfig !== false,
    defaultSandbox: permissionsToSandbox(permissions),
    permissions,
    toolMode: p.provider === 'openai-compatible' ? (p.toolMode || 'agent') : undefined,
    contextWindow:
      p.provider === 'openai-compatible'
        ? normalizeContextWindow(p.contextWindow) || DEFAULT_OPENAI_CONTEXT_WINDOW
        : undefined,
  };
}

/**
 * UI panel projection (visibility: ["app"]): strips raw apiKey completely,
 * returning only hasApiKey + masked apiKeyHint.
 */
export function sanitizePersonaForApp(p) {
  if (!p) return null;
  const { apiKey, ...rest } = p;
  const permissions = normalizePermissions(p.permissions, p.defaultSandbox);
  return {
    ...rest,
    addressUserAs: String(p.addressUserAs || '').trim(),
    memories: normalizeMemories(p.memories),
    provider: p.provider || 'codex-cli',
    fastMode: Boolean(p.fastMode),
    cleanCodexConfig: p.cleanCodexConfig !== false,
    customCodexPath: String(p.customCodexPath || '').trim(),
    baseUrl: p.baseUrl || '',
    toolMode: p.toolMode || 'agent',
    contextWindow: normalizeContextWindow(p.contextWindow),
    defaultSandbox: permissionsToSandbox(permissions),
    permissions,
    hasApiKey: Boolean(String(apiKey || '').trim()),
    apiKeyHint: maskApiKey(apiKey),
  };
}

export function readCodexUserDefaults() {
  const defaults = {
    model: 'gpt-6.2-sol',
    reasoningEffort: 'high',
    windowsSandbox: '',
    models: [],
    modelReasoningLevels: {},
  };
  const cfgPath = join(homedir(), '.codex', 'config.toml');
  try {
    if (existsSync(cfgPath)) {
      const text = readFileSync(cfgPath, 'utf8');
      const m = text.match(/^\s*model\s*=\s*"([^"]+)"/m);
      if (m) defaults.model = m[1];
      const e = text.match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m);
      if (e && VALID_REASONING_EFFORTS.includes(e[1])) defaults.reasoningEffort = e[1];
      const lines = text.split(/\r?\n/);
      let inWindowsSection = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('[')) {
          inWindowsSection = trimmed === '[windows]';
          continue;
        }
        if (inWindowsSection) {
          const ws = trimmed.match(/^sandbox\s*=\s*"([^"]+)"/);
          if (ws) {
            defaults.windowsSandbox = ws[1];
            break;
          }
        }
      }
    }
  } catch {
    // ignore read error
  }

  const cachePath = join(homedir(), '.codex', 'models_cache.json');
  try {
    if (existsSync(cachePath)) {
      const raw = readFileSync(cachePath, 'utf8');
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.models)
          ? parsed.models
          : [];
      const slugs = new Set();
      for (const item of list) {
        const slug = typeof item?.slug === 'string' ? item.slug.trim() : '';
        if (!slug || slug === 'codex-auto-review') continue;
        slugs.add(slug);
        if (Array.isArray(item.supported_reasoning_levels) && item.supported_reasoning_levels.length > 0) {
          const levels = item.supported_reasoning_levels
            .map((lv) => (typeof lv === 'string' ? lv.trim() : String(lv?.effort || '').trim()))
            .filter((lv) => lv && VALID_REASONING_EFFORTS.includes(lv));
          if (levels.length > 0) {
            defaults.modelReasoningLevels[slug] = Array.from(new Set(levels));
          }
        }
        if (!defaults.modelReasoningLevels[slug]) {
          defaults.modelReasoningLevels[slug] = [...DEFAULT_REASONING_LEVELS];
        }
      }
      defaults.models = Array.from(slugs);
    }
  } catch {
    // ignore cache read error
  }

  if (!defaults.models.includes(defaults.model)) {
    defaults.models.unshift(defaults.model);
  }
  if (!defaults.modelReasoningLevels[defaults.model]) {
    defaults.modelReasoningLevels[defaults.model] = [...DEFAULT_REASONING_LEVELS];
  }
  return defaults;
}

export function createDefaultPersonas() {
  const defaults = readCodexUserDefaults();
  const now = Date.now();
  return [
    {
      id: 'codex-default',
      name: 'Codex',
      role: '',
      avatar: '🤖',
      addressUserAs: '',
      memories: [],
      provider: 'codex-cli',
      systemPrompt: '',
      model: defaults.model,
      reasoningEffort: defaults.reasoningEffort,
      fastMode: false,
      cleanCodexConfig: true,
      customCodexPath: '',
      defaultSandbox: 'workspace-write',
      permissions: { ...PRESET_SAFE_PERMISSIONS },
      baseUrl: '',
      apiKey: '',
      toolMode: 'agent',
      contextWindow: 0,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

function normalizePersonaRecord(p, defaults) {
  const fallbackSandbox = VALID_SANDBOXES.includes(p.defaultSandbox)
    ? p.defaultSandbox
    : 'workspace-write';
  const permissions = normalizePermissions(p.permissions, fallbackSandbox);
  let safeAvatar = '🤖';
  try {
    safeAvatar = normalizeSafeAvatar(p.avatar, '🤖');
  } catch {
    safeAvatar = '🤖';
  }
  return {
    id: String(p.id || `persona-${randomUUID().slice(0, 8)}`),
    name: String(p.name || '副席成员'),
    role: String(p.role || ''),
    avatar: safeAvatar,
    addressUserAs: String(p.addressUserAs || '').trim().slice(0, 40),
    memories: normalizeMemories(p.memories),
    provider: VALID_PROVIDERS.includes(p.provider) ? p.provider : 'codex-cli',
    systemPrompt: String(p.systemPrompt || ''),
    model: String(p.model || defaults.model),
    reasoningEffort: VALID_REASONING_EFFORTS.includes(p.reasoningEffort)
      ? p.reasoningEffort
      : defaults.reasoningEffort,
    fastMode: Boolean(p.fastMode),
    cleanCodexConfig: p.cleanCodexConfig !== false,
    customCodexPath: String(p.customCodexPath || '').trim().slice(0, 500),
    defaultSandbox: permissionsToSandbox(permissions),
    permissions,
    baseUrl: String(p.baseUrl || ''),
    apiKey: String(p.apiKey || ''),
    toolMode: VALID_TOOL_MODES.includes(p.toolMode) ? p.toolMode : 'agent',
    contextWindow: normalizeContextWindow(p.contextWindow),
    createdAt: Number(p.createdAt) || Date.now(),
    updatedAt: Number(p.updatedAt) || Date.now(),
  };
}

function normalizeUserProfile(raw) {
  const name = typeof raw?.userName === 'string' && raw.userName.trim() ? raw.userName.trim().slice(0, 40) : '我';
  let avatar = '🧑';
  try {
    avatar = normalizeSafeAvatar(raw?.userAvatar, '🧑');
  } catch {
    avatar = '🧑';
  }
  const themeMode = VALID_THEME_MODES.includes(raw?.themeMode) ? raw.themeMode : 'auto';
  return { userName: name, userAvatar: avatar, themeMode };
}

function normalizeSessionRecord(s) {
  return {
    ...s,
    id: String(s.id || randomUUID()),
    personaId: String(s.personaId || 'codex-default'),
    provider: VALID_PROVIDERS.includes(s.provider) ? s.provider : 'codex-cli',
    title: String(s.title || '新话题').trim().slice(0, 80),
    sourceDir: String(s.sourceDir || ''),
    shadowId: s.shadowId || null,
    codexThreadId: s.codexThreadId || null,
    openaiMessages: Array.isArray(s.openaiMessages) ? s.openaiMessages : [],
    model: String(s.model || ''),
    reasoningEffort: String(s.reasoningEffort || ''),
    archived: Boolean(s.archived),
    inheritedSummary:
      s.inheritedSummary && typeof s.inheritedSummary === 'object' && s.inheritedSummary.summary
        ? {
            sourceSessionId: String(s.inheritedSummary.sourceSessionId || ''),
            sourceTitle: String(s.inheritedSummary.sourceTitle || '上一话题'),
            summary: String(s.inheritedSummary.summary),
            updatedAt: Number(s.inheritedSummary.updatedAt) || Date.now(),
          }
        : null,
    latestSummary:
      s.latestSummary && typeof s.latestSummary === 'object' && s.latestSummary.summary
        ? {
            summary: String(s.latestSummary.summary),
            messageCountAtSummary: Number(s.latestSummary.messageCountAtSummary) || 0,
            lastMessageId: String(s.latestSummary.lastMessageId || ''),
            summarizerPersonaId: String(s.latestSummary.summarizerPersonaId || ''),
            summarizerName: String(s.latestSummary.summarizerName || ''),
            updatedAt: Number(s.latestSummary.updatedAt) || Date.now(),
          }
        : null,
    messages: Array.isArray(s.messages) ? s.messages : [],
    contextUsage: normalizeContextUsage(s.contextUsage),
    anchorState: normalizeAnchorState(s.anchorState, Boolean(s.inheritedSummary?.summary)),
    pendingDiskRollbackNotice: Boolean(s.pendingDiskRollbackNotice),
    createdAt: Number(s.createdAt) || Date.now(),
    updatedAt: Number(s.updatedAt) || Date.now(),
  };
}

export function getLastContentMessageId(session) {
  if (!session || !Array.isArray(session.messages)) return '';
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (m && m.role !== 'system') return String(m.id || '');
  }
  return '';
}

export function getContentMessageCount(session) {
  if (!session || !Array.isArray(session.messages)) return 0;
  return session.messages.filter((m) => m && m.role !== 'system').length;
}

export function hasFreshSessionSummary(session) {
  if (!session?.latestSummary?.summary) return false;
  const lastId = getLastContentMessageId(session);
  if (!lastId) return false;
  return session.latestSummary.lastMessageId === lastId;
}

const MIME_TO_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
};

export class SideDeskStore {
  constructor(dataDir) {
    const rawDataDir =
      dataDir ||
      process.env.SIDEDESK_DATA_DIR ||
      join(homedir(), '.gemini', 'antigravity', 'plugin_data', 'sidedesk');
    mkdirSync(rawDataDir, { recursive: true });
    // Resolve Junctions / symlinks so codex.exe never rejects `-o` / `-C` with "path contains a reparse point"
    try {
      this.dataDir = (realpathSync.native || realpathSync)(rawDataDir);
    } catch {
      this.dataDir = rawDataDir;
    }
    this.stateFile = join(this.dataDir, 'state.json');
    this.jobsLogDir = join(this.dataDir, 'job_logs');
    this.shadowsDir = join(this.dataDir, 'shadows');
    this.backupsDir = join(this.dataDir, 'backups');
    this.tmpDir = join(this.dataDir, 'tmp');
    this.attachmentsDir = join(this.dataDir, 'attachments');
    this.exportsDir = join(this.dataDir, 'exports');

    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.jobsLogDir, { recursive: true });
    mkdirSync(this.shadowsDir, { recursive: true });
    mkdirSync(this.backupsDir, { recursive: true });
    mkdirSync(this.tmpDir, { recursive: true });
    mkdirSync(this.attachmentsDir, { recursive: true });
    mkdirSync(this.exportsDir, { recursive: true });

    this._saveTimer = null;
    this.state = this._load();
  }

  _makeEmptyState() {
    return {
      version: 3,
      userProfile: normalizeUserProfile(null),
      defaultPermissions: { ...PRESET_SAFE_PERMISSIONS },
      personas: createDefaultPersonas(),
      sessions: [],
      jobs: [],
      shadows: [],
      backups: [],
      drafts: {},
      recentSourceDirs: [],
      updatedAt: Date.now(),
    };
  }

  _load() {
    if (!existsSync(this.stateFile)) {
      const init = this._makeEmptyState();
      this._writeSync(init);
      return init;
    }

    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, 'utf8'));
      const defaults = readCodexUserDefaults();
      const personas = Array.isArray(parsed?.personas)
        ? parsed.personas.map((p) => normalizePersonaRecord(p, defaults))
        : createDefaultPersonas();

      const st = {
        version: 3,
        userProfile: normalizeUserProfile(parsed?.userProfile),
        defaultPermissions: normalizePermissions(parsed?.defaultPermissions, 'workspace-write'),
        personas,
        sessions: Array.isArray(parsed?.sessions)
          ? parsed.sessions.map(normalizeSessionRecord)
          : [],
        jobs: Array.isArray(parsed?.jobs) ? parsed.jobs : [],
        shadows: Array.isArray(parsed?.shadows) ? parsed.shadows : [],
        backups: Array.isArray(parsed?.backups) ? parsed.backups : [],
        drafts: parsed?.drafts && typeof parsed.drafts === 'object' ? parsed.drafts : {},
        recentSourceDirs: Array.isArray(parsed?.recentSourceDirs) ? parsed.recentSourceDirs : [],
        updatedAt: Number(parsed?.updatedAt) || Date.now(),
      };

      // Safety invariant: never auto-resend interrupted jobs after restart;
      // mark any leftover "running" job as "needs_review" ("结果待核对").
      let dirty = false;
      for (const job of st.jobs) {
        if (job.status === 'running') {
          job.status = 'needs_review';
          job.error =
            '后端服务已重启，原运行中任务状态未知（结果待核对）。已按安全策略停止，不会自动重发。';
          job.finishedAt = Date.now();
          job.events = job.events || [];
          job.events.push({
            ts: Date.now(),
            kind: 'system',
            text: '检测到服务重启，任务标记为「结果待核对」（绝不自动重发）',
          });
          const sess = st.sessions.find((s) => s.id === job.sessionId);
          if (sess) {
            sess.messages = sess.messages || [];
            sess.messages.push({
              id: randomUUID(),
              role: 'system',
              text: `任务 ${job.id.slice(0, 8)} 因服务重启进入「结果待核对」状态，请核查后再决定是否重新发送。`,
              jobId: job.id,
              createdAt: Date.now(),
            });
            sess.updatedAt = Date.now();
          }
          dirty = true;
        }
      }

      if (dirty) {
        this._writeSync(st);
      }
      return st;
    } catch {
      const fallback = this._makeEmptyState();
      this._writeSync(fallback);
      return fallback;
    }
  }

  getKnownSecrets() {
    if (!Array.isArray(this.state?.personas)) return [];
    return this.state.personas
      .map((p) => String(p?.apiKey || '').trim())
      .filter((k) => k.length >= 6);
  }

  _pruneState(st) {
    // 1. Bound jobs: preserve all running jobs + newest finished jobs up to 80
    if (Array.isArray(st.jobs)) {
      if (st.jobs.length > 80) {
        const running = st.jobs.filter((j) => j && j.status === 'running');
        const finished = st.jobs.filter((j) => j && j.status !== 'running');
        const keepFinished = Math.max(0, 80 - running.length);
        st.jobs = [...finished.slice(-keepFinished), ...running];
      }
      // Trim older finished job events & redundant liveReply so state.json stays compact (< 1 MiB)
      const total = st.jobs.length;
      for (let i = 0; i < total; i++) {
        const j = st.jobs[i];
        if (!j || j.status === 'running') continue;
        if (j.liveReply) j.liveReply = '';
        if (typeof j.finalReply === 'string' && j.finalReply.length > 16000) {
          j.finalReply = j.finalReply.slice(0, 16000);
        }
        const isOlder = i < total - 20;
        const maxEvs = isOlder ? 12 : 60;
        if (Array.isArray(j.events) && j.events.length > maxEvs) {
          j.events = j.events.slice(-maxEvs);
        }
      }
    }

    // 2. Bound sessions, shadows, and backups
    if (Array.isArray(st.sessions) && st.sessions.length > 60) {
      st.sessions = st.sessions.slice(-60);
    }
    if (Array.isArray(st.shadows) && st.shadows.length > 40) {
      const active = st.shadows.filter((s) => s && s.status === 'active' && s.hasChanges);
      const others = st.shadows.filter((s) => !(s && s.status === 'active' && s.hasChanges));
      const keepOthers = Math.max(0, 40 - active.length);
      st.shadows = [...others.slice(-keepOthers), ...active];
    }
    if (Array.isArray(st.backups) && st.backups.length > 40) {
      st.backups = st.backups.slice(-40);
    }
  }

  _writeSync(st) {
    st.updatedAt = Date.now();
    this._pruneState(st);
    atomicWriteFileSync(this.stateFile, JSON.stringify(st, null, 2));
  }

  scheduleSave() {
    this.state.updatedAt = Date.now();
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        this._writeSync(this.state);
      } catch {
        // best-effort background flush
      }
    }, 120);
  }

  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._writeSync(this.state);
  }

  // ---- User Profile & Default Permissions ----

  getUserProfile() {
    return normalizeUserProfile(this.state.userProfile);
  }

  saveUserProfile({ userName, userAvatar, themeMode } = {}) {
    const cur = this.getUserProfile();
    const validatedAvatar =
      typeof userAvatar === 'string' && userAvatar.trim()
        ? normalizeSafeAvatar(userAvatar, cur.userAvatar)
        : cur.userAvatar;
    const next = normalizeUserProfile({
      userName: typeof userName === 'string' && userName.trim() ? userName : cur.userName,
      userAvatar: validatedAvatar,
      themeMode: VALID_THEME_MODES.includes(themeMode) ? themeMode : cur.themeMode,
    });
    this.state.userProfile = next;
    this.flush();
    return next;
  }

  getDefaultPermissions() {
    return normalizePermissions(this.state.defaultPermissions, 'workspace-write');
  }

  saveDefaultPermissions(input) {
    const cur = this.getDefaultPermissions();
    const next = normalizePermissions(
      {
        fileScope: input?.fileScope ?? cur.fileScope,
        commandPolicy: input?.commandPolicy ?? cur.commandPolicy,
        networkPolicy: input?.networkPolicy ?? cur.networkPolicy,
      },
      permissionsToSandbox(cur)
    );
    this.state.defaultPermissions = next;
    this.flush();
    return next;
  }

  // ---- Attachments ----

  saveAttachmentFromDataUrl(dataUrl, rawName = 'image.png') {
    const str = String(dataUrl || '').trim();
    if (!isSafeBitmapDataUrl(str)) {
      throw new Error('附件格式无效或不安全，仅支持 PNG/JPG/WebP/GIF/BMP 位图图片');
    }
    const m = str.match(/^data:(image\/(?:png|jpeg|jpg|webp|gif|bmp));base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!m) {
      throw new Error('附件格式无效，仅支持 PNG/JPG/WebP/GIF/BMP 图片');
    }
    const mime = m[1].toLowerCase();
    const ext = MIME_TO_EXT[mime];
    if (!ext) {
      throw new Error(`不支持的图片类型: ${mime}`);
    }
    const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
    if (buf.length === 0 || buf.length > 10 * 1024 * 1024) {
      throw new Error('单张图片附件需大于 0 且不超过 10 MB');
    }
    const id = `att-${randomUUID().slice(0, 10)}`;
    const filePath = join(this.attachmentsDir, `${id}${ext}`);
    writeFileSync(filePath, buf);
    const cleanName = String(rawName || `image${ext}`).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 64);
    return {
      id,
      name: cleanName,
      mime,
      filePath,
      size: buf.length,
    };
  }

  // ---- Personas ----

  listPersonas() {
    return this.state.personas;
  }

  getPersona(id) {
    if (!id) return this.state.personas[0] || null;
    return this.state.personas.find((p) => p.id === id) || null;
  }

  savePersona(input) {
    const defaults = readCodexUserDefaults();
    const now = Date.now();
    const existing = input.id ? this.state.personas.find((p) => p.id === input.id) : null;

    if (existing) {
      if (typeof input.name === 'string' && input.name.trim()) existing.name = input.name.trim();
      if (typeof input.role === 'string') existing.role = input.role.trim();
      if (typeof input.avatar === 'string' && input.avatar.trim()) {
        existing.avatar = normalizeSafeAvatar(input.avatar, existing.avatar || '🤖');
      }
      if (typeof input.addressUserAs === 'string') {
        existing.addressUserAs = input.addressUserAs.trim().slice(0, 40);
      }
      if (Array.isArray(input.memories)) {
        existing.memories = normalizeMemories(input.memories);
      }
      if (VALID_PROVIDERS.includes(input.provider)) existing.provider = input.provider;
      if (typeof input.systemPrompt === 'string') existing.systemPrompt = input.systemPrompt;
      if (typeof input.model === 'string' && input.model.trim()) existing.model = input.model.trim();
      if (VALID_REASONING_EFFORTS.includes(input.reasoningEffort)) {
        existing.reasoningEffort = input.reasoningEffort;
      }
      if (typeof input.fastMode === 'boolean') {
        existing.fastMode = input.fastMode;
      }
      if (typeof input.cleanCodexConfig === 'boolean') {
        existing.cleanCodexConfig = input.cleanCodexConfig;
      }
      if (typeof input.customCodexPath === 'string') {
        existing.customCodexPath = input.customCodexPath.trim().slice(0, 500);
      }
      if (input.permissions && typeof input.permissions === 'object') {
        const nextPerms = normalizePermissions(
          input.permissions,
          input.defaultSandbox || existing.defaultSandbox
        );
        existing.permissions = nextPerms;
        existing.defaultSandbox = permissionsToSandbox(nextPerms);
      } else if (VALID_SANDBOXES.includes(input.defaultSandbox)) {
        existing.defaultSandbox = input.defaultSandbox;
        existing.permissions = permissionsFromSandbox(input.defaultSandbox);
      }
      if (typeof input.baseUrl === 'string') {
        existing.baseUrl = input.baseUrl.trim();
      }
      if (VALID_TOOL_MODES.includes(input.toolMode)) {
        existing.toolMode = input.toolMode;
      }
      if (input.contextWindow !== undefined) {
        existing.contextWindow = normalizeContextWindow(input.contextWindow);
      }
      // API Key update semantics: clearApiKey wipes it; non-empty string overwrites; empty preserves existing.
      if (input.clearApiKey === true) {
        existing.apiKey = '';
      } else if (typeof input.apiKey === 'string' && input.apiKey.trim() !== '') {
        existing.apiKey = input.apiKey.trim();
      }
      existing.updatedAt = now;
      this.flush();
      return existing;
    }

    const provider = VALID_PROVIDERS.includes(input.provider) ? input.provider : 'codex-cli';
    const basePerms = input.permissions
      ? normalizePermissions(input.permissions, input.defaultSandbox || 'workspace-write')
      : VALID_SANDBOXES.includes(input.defaultSandbox)
        ? permissionsFromSandbox(input.defaultSandbox)
        : this.getDefaultPermissions();

    const created = {
      id: (input.id && String(input.id).trim()) || `persona-${randomUUID().slice(0, 8)}`,
      name: String(input.name || '新副席成员').trim(),
      role: String(input.role || '后端开发搭档').trim(),
      avatar: normalizeSafeAvatar(input.avatar, '🤖'),
      addressUserAs: String(input.addressUserAs || '').trim().slice(0, 40),
      memories: normalizeMemories(input.memories),
      provider,
      systemPrompt: String(input.systemPrompt || ''),
      model: String(
        input.model || (provider === 'openai-compatible' ? 'deepseek-chat' : defaults.model)
      ).trim(),
      reasoningEffort: VALID_REASONING_EFFORTS.includes(input.reasoningEffort)
        ? input.reasoningEffort
        : defaults.reasoningEffort,
      fastMode: Boolean(input.fastMode),
      cleanCodexConfig: input.cleanCodexConfig !== false,
      customCodexPath: String(input.customCodexPath || '').trim().slice(0, 500),
      defaultSandbox: permissionsToSandbox(basePerms),
      permissions: basePerms,
      baseUrl: String(input.baseUrl || '').trim(),
      apiKey: input.clearApiKey === true ? '' : String(input.apiKey || '').trim(),
      toolMode: VALID_TOOL_MODES.includes(input.toolMode) ? input.toolMode : 'agent',
      contextWindow: normalizeContextWindow(input.contextWindow),
      createdAt: now,
      updatedAt: now,
    };
    this.state.personas.push(created);
    this.flush();
    return created;
  }

  deletePersona(id) {
    const idx = this.state.personas.findIndex((p) => p.id === id);
    if (idx === -1) throw new Error(`未找到人物卡: ${id}`);
    const [removed] = this.state.personas.splice(idx, 1);
    this.flush();
    return removed;
  }

  // ---- Sessions & Topic Management ----

  createSession({
    personaId,
    provider = 'codex-cli',
    title,
    sourceDir,
    shadowId = null,
    model,
    reasoningEffort,
    inheritedSummary = null,
  }) {
    const now = Date.now();
    const session = normalizeSessionRecord({
      id: randomUUID(),
      personaId,
      provider,
      title: String(title || '新话题').trim().slice(0, 80),
      sourceDir: String(sourceDir || ''),
      shadowId,
      codexThreadId: null,
      openaiMessages: [],
      model: model || '',
      reasoningEffort: reasoningEffort || '',
      archived: false,
      inheritedSummary,
      latestSummary: null,
      messages: [],
      contextUsage: null,
      anchorState: normalizeAnchorState(null, Boolean(inheritedSummary?.summary)),
      pendingDiskRollbackNotice: false,
      createdAt: now,
      updatedAt: now,
    });
    this.state.sessions.push(session);
    this.flush();
    return session;
  }

  getSession(id) {
    return this.state.sessions.find((s) => s.id === id) || null;
  }

  renameSession(sessionId, newTitle) {
    const sess = this.getSession(sessionId);
    if (!sess) throw new Error(`未找到话题: ${sessionId}`);
    const clean = String(newTitle || '').trim().slice(0, 80);
    if (!clean) throw new Error('话题名称不能为空');
    sess.title = clean;
    sess.updatedAt = Date.now();
    this.flush();
    return sess;
  }

  setSessionInheritedSummary(sessionId, { sourceSessionId = '', sourceTitle = '', summary = '' } = {}) {
    const sess = this.getSession(sessionId);
    if (!sess) throw new Error(`未找到话题: ${sessionId}`);
    const clean = String(summary || '').trim();
    if (!clean) {
      sess.inheritedSummary = null;
    } else {
      sess.inheritedSummary = {
        sourceSessionId: String(sourceSessionId || sess.inheritedSummary?.sourceSessionId || ''),
        sourceTitle: String(sourceTitle || sess.inheritedSummary?.sourceTitle || '上一话题'),
        summary: clean,
        updatedAt: Date.now(),
      };
    }
    sess.updatedAt = Date.now();
    this.flush();
    return sess;
  }

  clearSessionInheritedSummary(sessionId) {
    const sess = this.getSession(sessionId);
    if (!sess) throw new Error(`未找到话题: ${sessionId}`);
    sess.inheritedSummary = null;
    sess.updatedAt = Date.now();
    this.flush();
    return sess;
  }

  setSessionLatestSummary(sessionId, summaryText, meta = {}) {
    const sess = this.getSession(sessionId);
    if (!sess) throw new Error(`未找到话题: ${sessionId}`);
    sess.latestSummary = {
      summary: String(summaryText || '').trim(),
      messageCountAtSummary: getContentMessageCount(sess),
      lastMessageId: getLastContentMessageId(sess),
      summarizerPersonaId: String(meta.summarizerPersonaId || ''),
      summarizerName: String(meta.summarizerName || ''),
      updatedAt: Date.now(),
    };
    sess.updatedAt = Date.now();
    this.flush();
    return sess.latestSummary;
  }

  clearSessionMessages(sessionId) {
    const sess = this.getSession(sessionId);
    if (!sess) throw new Error(`未找到话题: ${sessionId}`);
    const running = this.state.jobs.find((j) => j.sessionId === sessionId && j.status === 'running');
    if (running) throw new Error('该话题有任务正在运行中，请先中止后再清空');
    sess.messages = [];
    sess.openaiMessages = [];
    sess.codexThreadId = null;
    sess.latestSummary = null;
    sess.inheritedSummary = null;
    sess.contextUsage = null;
    sess.anchorState = normalizeAnchorState(null, false);
    sess.pendingDiskRollbackNotice = false;
    sess.updatedAt = Date.now();
    this.flush();
    return sess;
  }

  markSessionsRollbackNotice({ sourceDir = '', shadowId = '' } = {}) {
    const normDir = String(sourceDir || '').trim().replace(/[\\/]+$/, '').toLowerCase();
    const sid = String(shadowId || '').trim();
    let marked = 0;
    for (const sess of this.state.sessions) {
      const sessDir = String(sess.sourceDir || '').trim().replace(/[\\/]+$/, '').toLowerCase();
      if ((sid && sess.shadowId === sid) || (normDir && sessDir === normDir)) {
        sess.pendingDiskRollbackNotice = true;
        sess.updatedAt = Date.now();
        marked++;
      }
    }
    if (marked > 0) this.flush();
    return marked;
  }

  deleteSession(sessionId) {
    const idx = this.state.sessions.findIndex((s) => s.id === sessionId);
    if (idx === -1) throw new Error(`未找到话题: ${sessionId}`);
    const running = this.state.jobs.find((j) => j.sessionId === sessionId && j.status === 'running');
    if (running) throw new Error('该话题有任务正在运行中，请先中止后再删除');
    const [removed] = this.state.sessions.splice(idx, 1);
    if (this.state.drafts && this.state.drafts[sessionId]) {
      delete this.state.drafts[sessionId];
    }
    this.flush();
    return removed;
  }

  exportSessionMarkdown(sessionId) {
    const sess = this.getSession(sessionId);
    if (!sess) throw new Error(`未找到话题: ${sessionId}`);
    const persona = this.getPersona(sess.personaId);
    const profile = this.getUserProfile();
    const lines = [
      `# ${sess.title}`,
      '',
      `- 成员：${persona?.name || sess.personaId}`,
      `- 工作目录：\`${sess.sourceDir || '(未绑定)'}\``,
      `- 创建时间：${new Date(sess.createdAt).toLocaleString('zh-CN')}`,
      `- 消息数：${(sess.messages || []).length}`,
      '',
    ];
    if (sess.inheritedSummary?.summary) {
      lines.push(
        `## 继承摘要（来自「${sess.inheritedSummary.sourceTitle || '上一话题'}」）`,
        '',
        sess.inheritedSummary.summary,
        ''
      );
    }
    if (sess.latestSummary?.summary) {
      lines.push('## 最新压缩摘要', '', sess.latestSummary.summary, '');
    }
    lines.push('## 对话记录', '');
    for (const m of sess.messages || []) {
      const ts = new Date(m.createdAt || Date.now()).toLocaleString('zh-CN');
      const speaker =
        m.role === 'assistant'
          ? `${persona?.name || '副席成员'}${m.model ? ` (${m.model})` : ''}`
          : m.role === 'hakimi'
            ? `${profile.userName}（主对话派单）`
            : m.role === 'boss'
              ? profile.userName
              : '系统提示';
      lines.push(`### ${speaker} · ${ts}`, '');
      if (Array.isArray(m.attachments) && m.attachments.length > 0) {
        lines.push(`> 附图：${m.attachments.map((a) => a.name || a.id).join('、')}`, '');
      }
      lines.push(m.text || '', '');
    }
    const markdown = lines.join('\n');
    const safeTitle = String(sess.title || 'topic')
      .replace(/[\\/:*?"<>|\s]+/g, '_')
      .slice(0, 40);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `${safeTitle}_${stamp}.md`;
    const savedPath = join(this.exportsDir, filename);
    writeFileSync(savedPath, markdown, 'utf8');
    return { filename, savedPath, markdown };
  }

  appendSessionMessage(sessionId, msg) {
    const sess = this.getSession(sessionId);
    if (!sess) return null;
    const entry = {
      id: randomUUID(),
      role: msg.role, // 'boss' | 'hakimi' | 'assistant' | 'system'
      text: String(msg.text || ''),
      jobId: msg.jobId || null,
      model: msg.model || null,
      usage: msg.usage || null,
      attachments: Array.isArray(msg.attachments) && msg.attachments.length > 0 ? msg.attachments : undefined,
      createdAt: Date.now(),
    };
    sess.messages.push(entry);
    if (sess.messages.length > 200) {
      sess.messages = sess.messages.slice(-200);
    }
    sess.updatedAt = Date.now();
    this.scheduleSave();
    return entry;
  }

  appendOpenAiHistory(sessionId, userText, assistantText) {
    const sess = this.getSession(sessionId);
    if (!sess) return;
    if (!Array.isArray(sess.openaiMessages)) sess.openaiMessages = [];
    if (userText) {
      sess.openaiMessages.push({ role: 'user', content: String(userText) });
    }
    if (assistantText) {
      sess.openaiMessages.push({ role: 'assistant', content: String(assistantText) });
    }
    // Keep last 40 turns (80 messages) bounded so state.json remains compact
    if (sess.openaiMessages.length > 80) {
      sess.openaiMessages = sess.openaiMessages.slice(-80);
    }
    sess.updatedAt = Date.now();
    this.scheduleSave();
  }

  // ---- Shadows & Backups ----

  addShadow(shadow) {
    this.state.shadows.push(shadow);
    this.flush();
    return shadow;
  }

  getShadow(id) {
    return this.state.shadows.find((s) => s.id === id) || null;
  }

  addBackup(backup) {
    this.state.backups.push(backup);
    this.flush();
    return backup;
  }

  getBackup(id) {
    return this.state.backups.find((b) => b.id === id) || null;
  }

  getLatestUndoableBackup(sourceDir = '') {
    for (let i = this.state.backups.length - 1; i >= 0; i--) {
      const b = this.state.backups[i];
      if (!b.undone && (!sourceDir || b.sourceDir === sourceDir)) {
        return b;
      }
    }
    return null;
  }

  // ---- Drafts & Recent Dirs ----

  saveDraft(key, { text = '', sourceDir = '' } = {}) {
    let k = String(key || 'default').trim();
    if (!k || k === '__proto__' || k === 'constructor' || k === 'prototype') {
      k = 'default';
    }
    if (!this.state.drafts || typeof this.state.drafts !== 'object') {
      this.state.drafts = {};
    }
    this.state.drafts[k] = {
      text: String(text || ''),
      sourceDir: String(sourceDir || ''),
      updatedAt: Date.now(),
    };
    const keys = Object.keys(this.state.drafts);
    if (keys.length > 40) {
      keys
        .sort((a, b) => (this.state.drafts[a]?.updatedAt || 0) - (this.state.drafts[b]?.updatedAt || 0))
        .slice(0, keys.length - 40)
        .forEach((oldKey) => delete this.state.drafts[oldKey]);
    }
    this.scheduleSave();
    return this.state.drafts[k];
  }

  recordSourceDir(dir) {
    const clean = String(dir || '').trim();
    if (!clean) return;
    const list = Array.isArray(this.state.recentSourceDirs) ? this.state.recentSourceDirs : [];
    const next = [clean, ...list.filter((x) => x.toLowerCase() !== clean.toLowerCase())].slice(0, 12);
    this.state.recentSourceDirs = next;
    this.scheduleSave();
  }

  // ---- Jobs ----

  addJob(job) {
    this.state.jobs.push(job);
    this.flush();
    return job;
  }

  getJob(id) {
    return this.state.jobs.find((j) => j.id === id) || null;
  }

  appendJobEvent(job, kind, text, raw = null) {
    const secrets = this.getKnownSecrets();
    const safeText = redactSecrets(String(text || ''), secrets).slice(0, 400);
    const ev = {
      ts: Date.now(),
      kind,
      text: safeText,
    };
    job.events = job.events || [];
    job.events.push(ev);
    if (job.events.length > 80) {
      job.events = job.events.slice(-80);
    }
    try {
      const logFile = join(this.jobsLogDir, `${job.id}.jsonl`);
      const serialized = redactSecrets(JSON.stringify({ ...ev, raw }), secrets);
      appendFileSync(logFile, serialized + '\n', 'utf8');
    } catch {
      // ignore disk log error
    }
    this.scheduleSave();
  }
}
