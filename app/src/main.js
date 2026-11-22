import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import { z } from 'zod/v4';
import { esc, isImageAvatar, renderMarkdown } from './sanitize.js';

const app = new App({ name: 'sidedesk', version: '0.1.0' }, {});

const API_PLATFORM_PRESETS = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-reasoner',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-sonnet-4',
  },
  siliconflow: {
    label: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-R1',
  },
  ollama: {
    label: 'Ollama 本地',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5-coder:14b',
  },
};

const PRESET_SAFE = { fileScope: 'shadow', commandPolicy: 'auto', networkPolicy: 'deny' };
const PRESET_TURBO = { fileScope: 'direct', commandPolicy: 'auto', networkPolicy: 'allow' };
const FALLBACK_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const FLUFF_EVENT_TEXTS = new Set([
  '正在深度思考...',
  '正在深度思考',
  '开始推理与执行...',
  '开始推理与执行',
]);

let hostCaps = {
  message: false,
  updateModelContext: false,
  toggleAuxPaneSupported: true,
};

let serverState = null;
let currentView = 'station'; // 'station' | 'review'
let activeSessionId = ''; // '' (auto) | '__none__' (member has no topics yet) | '<uuid>'
let selectedPersonaId = '';
let currentSourceDir = '';
let draftDirty = false;
let draftHydratedKey = '';
let draftTimer = null;

// Composer round overrides & pending image attachments
let composerOverrideActive = false;
let composerPerms = { ...PRESET_SAFE };
let pendingAttachments = []; // [{ id, name, dataUrl, previewDataUrl }]

// Two-stage emergency trip state
let tripArmed = false;
let tripResetTimer = null;

// Strictly serialized polling (<= 1 poll in flight)
let pollTimer = null;
let pollInFlight = false;
let lastMsgRenderKey = '';
let lastReviewShadowsKey = '';
let lastMemberStripKey = '';
const expandedFolds = new Set();
const diffCache = new Map();
const discardArmed = new Set();
const tmClearArmed = new Set();
const tmDeleteArmed = new Set();
let tmFilterMode = 'current'; // 'current' | 'all'
let tmRenamingId = null;
let lastExported = null;

// Theme state (host cached separately so manual light/dark is NEVER overwritten by host events)
let hostTheme = 'light';
let currentThemeMode = 'auto'; // 'auto' | 'light' | 'dark'
let themeSaveInFlight = false;

// Settings modal state
let settingsTab = 'personas'; // 'personas' | 'profile' | 'perms'
let modalEditingId = null;
let modalAvatarValue = '🤖';
let modalMemories = [];
let profileAvatarValue = '🧑';
let personaModalPerms = { ...PRESET_SAFE };
let globalModalPerms = { ...PRESET_SAFE };

const el = {
  memberStrip: document.getElementById('member-strip'),
  btnEmergencyTrip: document.getElementById('btn-emergency-trip'),
  btnThemeToggle: document.getElementById('btn-theme-toggle'),
  btnSettings: document.getElementById('btn-settings'),
  tabStation: document.getElementById('tab-station'),
  tabReview: document.getElementById('tab-review'),
  pendingPill: document.getElementById('pending-pill'),
  pathSummary: document.getElementById('path-summary'),
  btnDirToggle: document.getElementById('btn-dir-toggle'),
  dirDrawer: document.getElementById('dir-drawer'),
  inputSourceDir: document.getElementById('input-source-dir'),
  btnDirSave: document.getElementById('btn-dir-save'),
  recentDirs: document.getElementById('recent-dirs'),

  viewStation: document.getElementById('view-station'),
  viewReview: document.getElementById('view-review'),
  ctrlSession: document.getElementById('ctrl-session'),
  btnNewTopic: document.getElementById('btn-new-topic'),
  btnTopicMgr: document.getElementById('btn-topic-mgr'),
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),

  inheritedBar: document.getElementById('inherited-bar'),
  inheritedFold: document.getElementById('inherited-fold'),
  inheritedSummaryTitle: document.getElementById('inherited-summary-title'),
  inheritedEditor: document.getElementById('inherited-editor'),
  btnSaveInherited: document.getElementById('btn-save-inherited'),
  btnClearInherited: document.getElementById('btn-clear-inherited'),

  stationScroll: document.getElementById('station-scroll'),
  needsReviewBanner: document.getElementById('needs-review-banner'),
  stationEmpty: document.getElementById('station-empty'),
  emptyAvatar: document.getElementById('empty-avatar'),
  emptyTitle: document.getElementById('empty-title'),
  msgList: document.getElementById('msg-list'),
  liveSlot: document.getElementById('live-slot'),

  attachPopover: document.getElementById('attach-popover'),
  btnAttach: document.getElementById('btn-attach'),
  btnAttachFile: document.getElementById('btn-attach-file'),
  btnAttachClip: document.getElementById('btn-attach-clip'),
  composerImgFile: document.getElementById('composer-img-file'),
  attachStrip: document.getElementById('attach-strip'),

  paramsPopover: document.getElementById('params-popover'),
  btnParamsPop: document.getElementById('btn-params-pop'),
  btnParamsReset: document.getElementById('btn-params-reset'),
  popCodexRow: document.getElementById('pop-codex-row'),
  popCodexFastRow: document.getElementById('pop-codex-fast-row'),
  popApiRow: document.getElementById('pop-api-row'),
  popApiModel: document.getElementById('pop-api-model'),
  ctrlModel: document.getElementById('ctrl-model'),
  ctrlEffort: document.getElementById('ctrl-effort'),
  ctrlFastMode: document.getElementById('ctrl-fast-mode'),

  quotaPopover: document.getElementById('quota-popover'),
  quotaPopTitle: document.getElementById('quota-pop-title'),
  quotaPopTs: document.getElementById('quota-pop-ts'),
  quotaCodexSection: document.getElementById('quota-codex-section'),
  quotaCodexMetrics: document.getElementById('quota-codex-metrics'),
  quotaCodexEmpty: document.getElementById('quota-codex-empty'),
  quota5hBlock: document.getElementById('quota-5h-block'),
  quota5hVal: document.getElementById('quota-5h-val'),
  quota5hBar: document.getElementById('quota-5h-bar'),
  quota5hSub: document.getElementById('quota-5h-sub'),
  quota7dBlock: document.getElementById('quota-7d-block'),
  quota7dVal: document.getElementById('quota-7d-val'),
  quota7dBar: document.getElementById('quota-7d-bar'),
  quota7dSub: document.getElementById('quota-7d-sub'),
  quotaPlanLabel: document.getElementById('quota-plan-label'),
  btnQuotaRefresh: document.getElementById('btn-quota-refresh'),
  quotaContextSection: document.getElementById('quota-context-section'),
  quotaCtxLbl: document.getElementById('quota-ctx-lbl'),
  quotaCtxVal: document.getElementById('quota-ctx-val'),
  quotaCtxBar: document.getElementById('quota-ctx-bar'),
  quotaCtxSub: document.getElementById('quota-ctx-sub'),
  quotaCompressNudge: document.getElementById('quota-compress-nudge'),
  btnQuotaCompress: document.getElementById('btn-quota-compress'),
  btnQuotaPill: document.getElementById('btn-quota-pill'),
  quotaPillDot: document.getElementById('quota-pill-dot'),
  quotaPillText: document.getElementById('quota-pill-text'),
  quotaPillFill: document.getElementById('quota-pill-fill'),

  draftInput: document.getElementById('draft-input'),
  btnSend: document.getElementById('btn-send'),
  btnAbort: document.getElementById('btn-abort'),
  draftHint: document.getElementById('draft-hint'),
  shadowHint: document.getElementById('shadow-hint'),

  undoBanner: document.getElementById('undo-banner'),
  reviewRoHint: document.getElementById('review-ro-hint'),
  reviewEmpty: document.getElementById('review-empty'),
  reviewList: document.getElementById('review-list'),

  // Settings Modal (3 tabs)
  settingsModal: document.getElementById('settings-modal'),
  btnModalClose: document.getElementById('btn-modal-close'),
  stabPersonas: document.getElementById('stab-personas'),
  stabProfile: document.getElementById('stab-profile'),
  stabPerms: document.getElementById('stab-perms'),
  spanePersonas: document.getElementById('spane-personas'),
  spaneProfile: document.getElementById('spane-profile'),
  spanePerms: document.getElementById('spane-perms'),

  modalPersonaTabs: document.getElementById('modal-persona-tabs'),
  pmAvatarPreview: document.getElementById('pm-avatar-preview'),
  pmAvatarFile: document.getElementById('pm-avatar-file'),
  pmAvatarPaste: document.getElementById('pm-avatar-paste'),
  pmAvatarText: document.getElementById('pm-avatar-text'),
  pmName: document.getElementById('pm-name'),
  pmRole: document.getElementById('pm-role'),
  pmAddressAs: document.getElementById('pm-address-as'),
  pmProvider: document.getElementById('pm-provider'),
  pmCodexFields: document.getElementById('pm-codex-fields'),
  pmCodexModel: document.getElementById('pm-codex-model'),
  pmEffort: document.getElementById('pm-effort'),
  pmFastMode: document.getElementById('pm-fast-mode'),
  pmCleanConfig: document.getElementById('pm-clean-config'),
  pmCodexPath: document.getElementById('pm-codex-path'),
  pmRecheckCodex: document.getElementById('pm-recheck-codex'),
  pmCodexHint: document.getElementById('pm-codex-hint'),
  pmApiFields: document.getElementById('pm-api-fields'),
  pmApiPresets: document.getElementById('pm-api-presets'),
  pmBaseUrl: document.getElementById('pm-base-url'),
  pmApiKey: document.getElementById('pm-api-key'),
  pmClearKeyWrap: document.getElementById('pm-clear-key-wrap'),
  pmClearKey: document.getElementById('pm-clear-key'),
  pmApiModel: document.getElementById('pm-api-model'),
  pmToolMode: document.getElementById('pm-tool-mode'),
  pmContextWindow: document.getElementById('pm-context-window'),
  pmTestConn: document.getElementById('pm-test-conn'),
  pmTestResult: document.getElementById('pm-test-result'),
  pmPrompt: document.getElementById('pm-prompt'),
  pmMemCount: document.getElementById('pm-mem-count'),
  pmMemInput: document.getElementById('pm-mem-input'),
  pmMemAdd: document.getElementById('pm-mem-add'),
  pmMemList: document.getElementById('pm-mem-list'),
  pmDelete: document.getElementById('pm-delete'),
  pmCancel: document.getElementById('pm-cancel'),
  pmSave: document.getElementById('pm-save'),

  upAvatarPreview: document.getElementById('up-avatar-preview'),
  upAvatarFile: document.getElementById('up-avatar-file'),
  upAvatarPaste: document.getElementById('up-avatar-paste'),
  upAvatarText: document.getElementById('up-avatar-text'),
  upName: document.getElementById('up-name'),
  upThemeSeg: document.getElementById('up-theme-seg'),
  upSave: document.getElementById('up-save'),

  globalPermDesc: document.getElementById('global-perm-desc'),
  dpExtraPath: document.getElementById('dp-extra-path'),
  dpNodePathHint: document.getElementById('dp-node-path-hint'),
  dpSave: document.getElementById('dp-save'),

  // New Topic Modal
  newTopicModal: document.getElementById('new-topic-modal'),
  btnNtClose: document.getElementById('btn-nt-close'),
  btnNtCancel: document.getElementById('btn-nt-cancel'),
  btnNtConfirm: document.getElementById('btn-nt-confirm'),
  ntTitle: document.getElementById('nt-title'),
  ntInheritSection: document.getElementById('nt-inherit-section'),
  ntInherit: document.getElementById('nt-inherit'),
  ntSummaryDetail: document.getElementById('nt-summary-detail'),
  ntSummaryFresh: document.getElementById('nt-summary-fresh'),
  ntSummaryNeed: document.getElementById('nt-summary-need'),
  ntSummaryNeedText: document.getElementById('nt-summary-need-text'),
  ntSummarizer: document.getElementById('nt-summarizer'),

  // Topic Manager Modal
  topicMgrModal: document.getElementById('topic-mgr-modal'),
  btnTmClose: document.getElementById('btn-tm-close'),
  tmFilterCur: document.getElementById('tm-filter-cur'),
  tmFilterAll: document.getElementById('tm-filter-all'),
  tmSummarizer: document.getElementById('tm-summarizer'),
  tmExportSheet: document.getElementById('tm-export-sheet'),
  tmExportTitle: document.getElementById('tm-export-title'),
  tmExportPath: document.getElementById('tm-export-path'),
  tmExportMd: document.getElementById('tm-export-md'),
  tmExportClose: document.getElementById('tm-export-close'),
  tmExportCopy: document.getElementById('tm-export-copy'),
  tmExportDl: document.getElementById('tm-export-dl'),
  tmExportOpen: document.getElementById('tm-export-open'),
  tmList: document.getElementById('tm-list'),

  toast: document.getElementById('toast'),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let toastTimer = null;
function showToast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 2600);
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtTimeSec(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function fmtDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getFullYear()}-${mo}-${da} ${hh}:${mm}`;
}

function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m${String(r).padStart(2, '0')}s` : `${r}s`;
}

function fmtCompactTokens(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v < 1000) return String(Math.round(v));
  if (v < 1_000_000) {
    const k = v / 1000;
    return `${(k >= 100 ? k.toFixed(0) : k.toFixed(1)).replace(/\.0$/, '')}K`;
  }
  return `${(v / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
}

function fmtPctText(n) {
  const v = Math.min(100, Math.max(0, Math.round((Number(n) || 0) * 10) / 10));
  return `${v}%`;
}

function fmtPlanLabel(planType, credits) {
  const raw = String(planType || '').trim();
  const base = raw ? `Plan: ${raw.charAt(0).toUpperCase()}${raw.slice(1)}` : 'Codex 本地快照';
  if (credits?.hasCredits && credits.balance && credits.balance !== '0') {
    return `${base} · Credits ${credits.balance}`;
  }
  return base;
}

function formatFiveHourReset(resetsAtSec, nowMs = Date.now()) {
  if (!resetsAtSec) return '重置时间待同步';
  const targetMs = resetsAtSec * 1000;
  const hhmm = fmtTime(targetMs);
  const diffMs = targetMs - nowMs;
  if (diffMs <= 0) return `已到重置时间（${hhmm}）· 下次调用刷新`;
  const totalMins = Math.ceil(diffMs / 60_000);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours > 0 && mins > 0) return `${hours}小时${mins}分后重置 · ${hhmm}`;
  if (hours > 0) return `${hours}小时后重置 · ${hhmm}`;
  return `${Math.max(1, mins)}分钟后重置 · ${hhmm}`;
}

function formatWeeklyReset(resetsAtSec, nowMs = Date.now()) {
  if (!resetsAtSec) return '重置时间待同步';
  const targetMs = resetsAtSec * 1000;
  const hhmm = fmtTime(targetMs);
  const diffMs = targetMs - nowMs;
  if (diffMs <= 0) return '已到重置时间 · 下次调用刷新';
  const d = new Date(targetMs);
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  if (diffMs <= 7 * 24 * 3600 * 1000) {
    return `${weekdays[d.getDay()]} ${hhmm} 重置`;
  }
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm} 重置`;
}

function quotaLevelClass(remainingPct) {
  const r = Number(remainingPct);
  if (!Number.isFinite(r)) return '';
  if (r < 5) return 'is-danger';
  if (r < 20) return 'is-warn';
  return '';
}

function contextLevelClass(usedPct) {
  const u = Number(usedPct);
  if (!Number.isFinite(u)) return '';
  if (u >= 85) return 'is-danger';
  if (u >= 65) return 'is-warn';
  return '';
}

function worstLevelClass(...levels) {
  if (levels.includes('is-danger')) return 'is-danger';
  if (levels.includes('is-warn')) return 'is-warn';
  return '';
}

function applyLevelClass(node, cls) {
  if (!node) return;
  node.classList.toggle('is-warn', cls === 'is-warn');
  node.classList.toggle('is-danger', cls === 'is-danger');
}

function pathBasename(p) {
  if (!p) return '未绑定文件夹';
  const cleaned = String(p).replace(/[\\/]+$/, '');
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] || cleaned;
}

function toFileUri(winOrPosixPath) {
  const normalized = String(winOrPosixPath || '').replace(/\\/g, '/');
  if (!normalized) return '';
  const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return `file://${encodeURI(withSlash)}`;
}

function joinPath(baseDir, relPosix) {
  const sep = baseDir.includes('\\') ? '\\' : '/';
  const cleanBase = baseDir.replace(/[\\/]+$/, '');
  const rel = relPosix.split('/').join(sep);
  return `${cleanBase}${sep}${rel}`;
}

function renderAvatarInner(val, fallback = '🧪') {
  const v = String(val || fallback).trim() || fallback;
  if (isImageAvatar(v)) {
    return `<img src="${esc(v)}" alt="" />`;
  }
  return esc(v.slice(0, 2));
}

function providerShortBadge(provider) {
  return provider === 'openai-compatible' ? 'API' : 'Codex';
}

function normalizePermsClient(p, fallbackSandbox = 'workspace-write') {
  const base =
    fallbackSandbox === 'turbo-direct'
      ? { ...PRESET_TURBO }
      : fallbackSandbox === 'read-only'
        ? { fileScope: 'read-only', commandPolicy: 'disabled', networkPolicy: 'deny' }
        : { ...PRESET_SAFE };
  if (!p || typeof p !== 'object') return base;
  return {
    fileScope: ['read-only', 'shadow', 'direct'].includes(p.fileScope) ? p.fileScope : base.fileScope,
    commandPolicy: ['auto', 'disabled'].includes(p.commandPolicy) ? p.commandPolicy : base.commandPolicy,
    networkPolicy: ['allow', 'deny'].includes(p.networkPolicy) ? p.networkPolicy : base.networkPolicy,
  };
}

function permsEqual(a, b) {
  return (
    a?.fileScope === b?.fileScope &&
    a?.commandPolicy === b?.commandPolicy &&
    a?.networkPolicy === b?.networkPolicy
  );
}

function permsToSandboxClient(p) {
  if (p?.fileScope === 'direct') return 'turbo-direct';
  if (p?.fileScope === 'read-only') return 'read-only';
  return 'workspace-write';
}

async function copyTextReliable(text) {
  const str = String(text ?? '');
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(str);
      return true;
    }
  } catch {
    // fallback below
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = str;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function renderUnifiedDiffLines(patch) {
  if (!patch) return '<span class="dl dl-meta">（无文本差异内容）</span>';
  return patch
    .split(/\r?\n/)
    .map((line) => {
      let cls = 'dl-ctx';
      if (
        line.startsWith('+++') ||
        line.startsWith('---') ||
        line.startsWith('diff --git') ||
        line.startsWith('new file') ||
        line.startsWith('deleted file') ||
        line.startsWith('index ')
      ) {
        cls = 'dl-meta';
      } else if (line.startsWith('@@')) {
        cls = 'dl-hunk';
      } else if (line.startsWith('+')) {
        cls = 'dl-add';
      } else if (line.startsWith('-')) {
        cls = 'dl-del';
      }
      if (cls === 'dl-add' || cls === 'dl-del') {
        return `<span class="dl ${cls}"><span class="dl-sign">${esc(line.slice(0, 1))}</span>${esc(line.slice(1))}</span>`;
      }
      return `<span class="dl ${cls}">${esc(line)}</span>`;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Server Tool Calls & Host Interactions
// ---------------------------------------------------------------------------

async function callAppTool(name, args = {}) {
  const res = await app.callServerTool({ name, arguments: args });
  if (res?.isError) {
    const errText = res.content?.map((c) => c.text || '').join('\n') || '工具调用失败';
    throw new Error(errText);
  }
  if (res?.structuredContent) return res.structuredContent;
  const text = res?.content?.[0]?.text || '{}';
  try {
    return JSON.parse(text);
  } catch {
    return { ok: true, text };
  }
}

async function sendToMainChat(text) {
  if (!hostCaps.message) {
    showToast('当前视图不支持直接发送到主对话');
    return;
  }
  const res = await app.sendMessage({
    role: 'user',
    content: [{ type: 'text', text }],
  });
  if (res?.isError) showToast('主对话拒绝了该消息');
  else showToast('已转交到左侧主对话');
}

async function attachAsNextContext(text) {
  if (!hostCaps.updateModelContext) {
    showToast('当前视图不支持附加下轮上下文');
    return;
  }
  await app.updateModelContext({ content: [{ type: 'text', text }] });
  showToast('已附为左侧下轮消息上下文');
}

async function openFileInHostAuxPane(absPath) {
  const uri = toFileUri(absPath);
  if (!uri) return;
  try {
    const res = await app.request(
      {
        method: 'com.google.antigravity/toggle-aux-pane',
        params: { tabType: 'fileView', uri },
      },
      z.looseObject({ isError: z.boolean().optional() })
    );
    if (res?.isError) showToast('无法在侧栏打开该文件');
  } catch (err) {
    if (err?.code === -32601 || String(err?.message || '').includes('-32601')) {
      hostCaps.toggleAuxPaneSupported = false;
      showToast('当前宿主不支持侧栏打开文件');
    } else {
      showToast(`打开文件失败: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Permission Capsule UI Synchronization (Composer / Persona / Global)
// ---------------------------------------------------------------------------

function getPermState(scope) {
  if (scope === 'persona') return personaModalPerms;
  if (scope === 'global') return globalModalPerms;
  return composerPerms;
}

function setPermState(scope, next) {
  const norm = normalizePermsClient(next);
  if (scope === 'persona') personaModalPerms = norm;
  else if (scope === 'global') globalModalPerms = norm;
  else composerPerms = norm;
  renderPermGroup(scope);
  if (scope === 'composer') syncWorkstationStatusBars();
  if (scope === 'global') renderGlobalPermDescription();
}

function renderPermGroup(scope) {
  const root = document.querySelector(`[data-perm-group="${scope}"]`);
  if (!root) return;
  const st = getPermState(scope);
  root.querySelectorAll('.seg-group').forEach((grp) => {
    const key = grp.dataset.permKey;
    const curVal = st[key];
    grp.querySelectorAll('.seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.val === curVal);
    });
  });
  const isSafe = permsEqual(st, PRESET_SAFE);
  const isTurbo = permsEqual(st, PRESET_TURBO);
  document.querySelectorAll(`[data-preset-scope="${scope}"]`).forEach((btn) => {
    const isActive =
      (btn.dataset.preset === 'safe' && isSafe) ||
      (btn.dataset.preset === 'turbo' && isTurbo);
    btn.classList.toggle('active', isActive);
  });
}

function renderGlobalPermDescription() {
  const p = globalModalPerms;
  const fileTxt =
    p.fileScope === 'direct'
      ? '⚡ 直接在原目录读写（跳过影子副本与容量熔断）'
      : p.fileScope === 'read-only'
        ? '只读分析（不修改任何文件）'
        : '影子副本隔离（验收红绿 Diff 后写回）';
  const cmdTxt = p.commandPolicy === 'auto' ? '允许自动执行命令' : '禁止执行终端命令';
  const netTxt = p.networkPolicy === 'allow' ? '允许联网' : '禁止联网';
  el.globalPermDesc.textContent = `当前组合：${fileTxt} · ${cmdTxt} · ${netTxt}`;
}

function wirePermissionControls() {
  document.querySelectorAll('[data-preset-scope]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const scope = btn.dataset.presetScope;
      const preset = btn.dataset.preset === 'turbo' ? PRESET_TURBO : PRESET_SAFE;
      if (scope === 'composer') composerOverrideActive = true;
      setPermState(scope, preset);
    });
  });

  document.querySelectorAll('[data-perm-group]').forEach((grpRoot) => {
    const scope = grpRoot.dataset.permGroup;
    grpRoot.querySelectorAll('.seg-group').forEach((seg) => {
      const key = seg.dataset.permKey;
      seg.querySelectorAll('.seg-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const cur = { ...getPermState(scope) };
          cur[key] = btn.dataset.val;
          if (scope === 'composer') composerOverrideActive = true;
          setPermState(scope, cur);
        });
      });
    });
  });
}

function syncWorkstationStatusBars() {
  const p = composerPerms;
  const dirLabel = pathBasename(currentSourceDir);
  const fullPath = currentSourceDir || '点击右侧「切换文件夹」绑定工作目录';
  const persona = getPersonaById(serverState, selectedPersonaId);
  const personaPerms = normalizePermsClient(persona?.permissions, persona?.defaultSandbox);

  // Top plain-language path subtitle
  el.pathSummary.title = fullPath;
  el.pathSummary.classList.remove('is-turbo', 'is-readonly');
  if (p.fileScope === 'direct') {
    el.pathSummary.textContent = `⚡ 直接读写：${dirLabel} · 改动直接保存到原目录`;
    el.pathSummary.classList.add('is-turbo');
  } else if (p.fileScope === 'read-only') {
    el.pathSummary.textContent = `只读分析：${dirLabel} · 不修改任何文件`;
    el.pathSummary.classList.add('is-readonly');
  } else {
    el.pathSummary.textContent = `影子隔离：${dirLabel} · 验收后写回`;
  }

  // Composer minimal hint
  el.shadowHint.classList.toggle('is-turbo', p.fileScope === 'direct');
  if (p.fileScope === 'direct') {
    el.shadowHint.textContent = '⚡ 直接读写当前文件夹';
  } else if (p.fileScope === 'read-only') {
    el.shadowHint.textContent = '只读分析中';
  } else {
    el.shadowHint.textContent = '影子副本隔离中';
  }

  // Params capsule button label
  const isPermsDiff = !permsEqual(p, personaPerms);
  const isCodex = persona && persona.provider !== 'openai-compatible';
  const isFastOn = Boolean(isCodex && el.ctrlFastMode.checked);
  const isModelDiff =
    isCodex &&
    ((el.ctrlModel.value && el.ctrlModel.value !== persona.model) ||
      (el.ctrlEffort.value && el.ctrlEffort.value !== persona.reasoningEffort) ||
      Boolean(el.ctrlFastMode.checked) !== Boolean(persona.fastMode));
  const hasOverride = composerOverrideActive && (isPermsDiff || isModelDiff);

  el.btnParamsPop.classList.toggle('is-turbo', p.fileScope === 'direct');
  el.btnParamsPop.classList.toggle('is-override', (hasOverride || isFastOn) && p.fileScope !== 'direct');

  const paramsIconSvg =
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/><circle cx="5.5" cy="4.5" r="1.3" fill="currentColor"/><circle cx="10.5" cy="8" r="1.3" fill="currentColor"/><circle cx="6.5" cy="11.5" r="1.3" fill="currentColor"/></svg>';
  const fastMark = isFastOn ? '·极速' : '';
  let labelText = '成员默认';
  if (p.fileScope === 'direct') {
    labelText = `⚡ 直通${fastMark}${hasOverride ? '*' : ''}`;
  } else if (hasOverride) {
    const scopeTag = p.fileScope === 'read-only' ? '只读' : '影子';
    const extra = isCodex ? `·${el.ctrlEffort.value}${fastMark}` : '';
    labelText = `${scopeTag}${extra}`;
  } else if (isFastOn) {
    labelText = '成员默认·极速';
  }
  el.btnParamsPop.innerHTML = `${paramsIconSvg}<span>${esc(labelText)}</span>`;
}

// ---------------------------------------------------------------------------
// Backend-Synced Drafts & Auto-grow Textarea
// ---------------------------------------------------------------------------

function syncSendButtonState() {
  const isEmpty = el.draftInput.value.trim().length === 0 && pendingAttachments.length === 0;
  el.btnSend.classList.toggle('is-empty', isEmpty);
}

function currentDraftKey() {
  if (activeSessionId && activeSessionId !== '__none__') return activeSessionId;
  return `new:${selectedPersonaId || 'default'}`;
}

function autoResizeTextarea() {
  el.draftInput.style.height = 'auto';
  const next = Math.min(Math.max(el.draftInput.scrollHeight, 38), 116);
  el.draftInput.style.height = `${next}px`;
}

let pendingDraftSnapshot = null;

function flushPendingDraftSave() {
  if (!draftTimer || !pendingDraftSnapshot) return;
  clearTimeout(draftTimer);
  draftTimer = null;
  const snap = pendingDraftSnapshot;
  pendingDraftSnapshot = null;
  callAppTool('app_save_draft', snap).catch(() => {});
}

function scheduleDraftSave() {
  draftDirty = true;
  el.draftHint.textContent = '···';
  autoResizeTextarea();
  syncSendButtonState();
  clearTimeout(draftTimer);
  const snap = {
    key: currentDraftKey(),
    text: el.draftInput.value,
    sourceDir: currentSourceDir,
  };
  pendingDraftSnapshot = snap;
  draftTimer = setTimeout(async () => {
    draftTimer = null;
    pendingDraftSnapshot = null;
    try {
      await callAppTool('app_save_draft', snap);
      if (currentDraftKey() === snap.key) {
        draftDirty = false;
        el.draftHint.textContent = snap.text ? '已存' : '';
      }
    } catch {
      if (currentDraftKey() === snap.key) el.draftHint.textContent = '';
    }
  }, 420);
}

function hydrateDraftFromState(st) {
  const key = currentDraftKey();
  if (draftHydratedKey === key || draftDirty) return;
  const saved = st.drafts?.[key];
  if (saved && typeof saved.text === 'string') {
    el.draftInput.value = saved.text;
    el.draftHint.textContent = saved.text ? '已恢复' : '';
  } else {
    el.draftInput.value = '';
    el.draftHint.textContent = '';
  }
  autoResizeTextarea();
  syncSendButtonState();
  draftHydratedKey = key;
}

// ---------------------------------------------------------------------------
// Composer Image Attachments
// ---------------------------------------------------------------------------

function makeThumbnailDataUrl(srcDataUrl, maxSide = 160) {
  return new Promise((resolveThumb) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width || 1, img.height || 1));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      resolveThumb(c.toDataURL('image/webp', 0.78));
    };
    img.onerror = () => resolveThumb(srcDataUrl.slice(0, 80000));
    img.src = srcDataUrl;
  });
}

async function addPendingAttachmentDataUrl(dataUrl, name = 'screenshot.png') {
  if (!dataUrl || !isImageAvatar(dataUrl)) {
    showToast('图片格式不支持');
    return;
  }
  if (pendingAttachments.length >= 6) {
    showToast('单条消息最多附带 6 张图片');
    return;
  }
  const previewDataUrl = await makeThumbnailDataUrl(dataUrl, 160);
  pendingAttachments.push({
    id: `pa-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: String(name || 'image.png').slice(0, 48),
    dataUrl,
    previewDataUrl,
  });
  renderAttachStrip();
}

function addPendingAttachmentFile(file) {
  if (!file || !file.type?.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = () => {
    addPendingAttachmentDataUrl(String(reader.result || ''), file.name || 'image.png');
  };
  reader.readAsDataURL(file);
}

function renderAttachStrip() {
  if (pendingAttachments.length === 0) {
    el.attachStrip.classList.add('hidden');
    el.attachStrip.innerHTML = '';
    syncSendButtonState();
    return;
  }
  el.attachStrip.classList.remove('hidden');
  el.attachStrip.innerHTML = pendingAttachments
    .map((a) => {
      const safeSrc = isImageAvatar(a.previewDataUrl)
        ? a.previewDataUrl
        : isImageAvatar(a.dataUrl)
          ? a.dataUrl
          : '';
      return `
      <div class="attach-thumb-card" title="${esc(a.name)}">
        ${safeSrc ? `<img src="${esc(safeSrc)}" alt="" />` : `<span class="msg-att-chip">🖼️</span>`}
        <button type="button" class="attach-remove" data-rm-att="${esc(a.id)}" aria-label="移除图片">×</button>
      </div>`;
    })
    .join('');
  el.attachStrip.querySelectorAll('[data-rm-att]').forEach((btn) => {
    btn.addEventListener('click', () => {
      pendingAttachments = pendingAttachments.filter((x) => x.id !== btn.dataset.rmAtt);
      renderAttachStrip();
    });
  });
  syncSendButtonState();
}

async function pasteComposerImageFromSystemClipboard() {
  el.attachPopover.classList.add('hidden');
  try {
    const res = await callAppTool('app_paste_clipboard_image', { mode: 'attachment' });
    if (res?.ok && res.dataUrl) {
      await addPendingAttachmentDataUrl(res.dataUrl, 'clipboard.png');
      showToast('已添加剪贴板截图');
    } else {
      showToast(res?.error || '剪贴板里没有检测到图片');
    }
  } catch (err) {
    showToast(`粘贴截图失败: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Topbar, Member Strip & Engine State
// ---------------------------------------------------------------------------

function setView(view) {
  currentView = view;
  el.tabStation.classList.toggle('active', view === 'station');
  el.tabReview.classList.toggle('active', view === 'review');
  el.viewStation.classList.toggle('hidden', view !== 'station');
  el.viewReview.classList.toggle('hidden', view !== 'review');
  closePopovers();
  if (view === 'review' && serverState) {
    renderReviewView(serverState, true);
  }
}

// ---------------------------------------------------------------------------
// Universal Custom Select Component (Warm Parchment Listbox, Zero OS Blue)
// ---------------------------------------------------------------------------

const customSelectMap = new WeakMap();
let openCustomSelect = null;

const CSELECT_CHEVRON_SVG =
  '<svg class="cselect-chevron" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6.5 8 10l3.5-3.5"/></svg>';
const CSELECT_CHECK_SVG =
  '<svg class="cselect-check" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5 6.5 11.5 12.5 5"/></svg>';

function parseTopicLabel(rawLabel, isTopic) {
  const txt = String(rawLabel || '');
  if (isTopic && /^历史[：:]\s*/.test(txt)) {
    return { isHistory: true, text: txt.replace(/^历史[：:]\s*/, '') };
  }
  return { isHistory: false, text: txt };
}

function closeOpenCustomSelect(restoreFocus = false) {
  if (!openCustomSelect) return;
  const inst = openCustomSelect;
  openCustomSelect = null;
  inst.wrap.classList.remove('is-open');
  inst.trigger.setAttribute('aria-expanded', 'false');
  inst.menu.classList.add('hidden');
  inst.focusedIdx = -1;
  if (restoreFocus) inst.trigger.focus();
}

function syncCustomSelectUI(selectEl) {
  const inst = customSelectMap.get(selectEl);
  if (!inst) return;
  const opts = Array.from(selectEl.options);
  const selected = opts.find((o) => o.value === selectEl.value) || opts[0] || null;
  const parsed = parseTopicLabel(selected?.textContent || '', inst.isTopic);
  inst.labelEl.innerHTML = parsed.isHistory
    ? `<span class="cselect-hist-tag">历史</span><span class="cselect-label-text">${esc(parsed.text)}</span>`
    : `<span class="cselect-label-text">${esc(parsed.text || '请选择')}</span>`;
  inst.trigger.title = selected?.textContent || '';
  if (openCustomSelect === inst) {
    inst.renderMenuOptions();
    inst.positionMenu();
  }
}

function enhanceCustomSelect(selectEl) {
  if (!selectEl || customSelectMap.has(selectEl)) return;
  const isTopic = selectEl.id === 'ctrl-session';
  const wrap = document.createElement('div');
  wrap.className = `cselect${isTopic ? ' cselect-topic' : ''}`;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'cselect-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  const ariaLabel = selectEl.getAttribute('aria-label');
  if (ariaLabel) trigger.setAttribute('aria-label', ariaLabel);

  const labelEl = document.createElement('span');
  labelEl.className = 'cselect-label';
  trigger.appendChild(labelEl);
  trigger.insertAdjacentHTML('beforeend', CSELECT_CHEVRON_SVG);

  const menu = document.createElement('div');
  menu.className = 'cselect-menu hidden';
  menu.setAttribute('role', 'listbox');
  if (ariaLabel) menu.setAttribute('aria-label', ariaLabel);
  menu.dataset.forSelect = selectEl.id || '';
  document.body.appendChild(menu);

  selectEl.parentNode.insertBefore(wrap, selectEl);
  wrap.appendChild(selectEl);
  wrap.appendChild(trigger);
  selectEl.classList.add('sr-only-select');
  selectEl.tabIndex = -1;
  selectEl.setAttribute('aria-hidden', 'true');

  if (selectEl.id) {
    document.querySelectorAll(`label[for="${CSS.escape(selectEl.id)}"]`).forEach((lbl) => {
      lbl.addEventListener('click', (e) => {
        e.preventDefault();
        trigger.focus();
      });
    });
  }

  const inst = {
    selectEl,
    wrap,
    trigger,
    labelEl,
    menu,
    isTopic,
    optionBtns: [],
    focusedIdx: -1,
    contains(node) {
      return wrap.contains(node) || menu.contains(node);
    },
    setFocusIndex(nextIdx) {
      if (this.optionBtns.length === 0) return;
      const len = this.optionBtns.length;
      const idx = ((nextIdx % len) + len) % len;
      this.focusedIdx = idx;
      this.optionBtns.forEach((b, i) => b.classList.toggle('is-focused', i === idx));
      const target = this.optionBtns[idx];
      if (target) target.scrollIntoView({ block: 'nearest' });
    },
    selectOptionValue(val) {
      const changed = selectEl.value !== val;
      selectEl.value = val;
      syncCustomSelectUI(selectEl);
      closeOpenCustomSelect(true);
      if (changed) {
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
    },
    renderMenuOptions() {
      const rawOpts = Array.from(selectEl.options).map((o) => ({
        value: o.value,
        raw: o.textContent || '',
        ...parseTopicLabel(o.textContent || '', isTopic),
      }));
      const curVal = selectEl.value;
      menu.innerHTML = '';
      this.optionBtns = [];

      const appendOpt = (item) => {
        const isSel = item.value === curVal;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cselect-opt';
        btn.setAttribute('role', 'option');
        btn.setAttribute('aria-selected', isSel ? 'true' : 'false');
        btn.dataset.val = item.value;
        btn.title = item.raw;
        btn.innerHTML = `
          <span class="cselect-opt-main">
            <span class="cselect-opt-text">${esc(item.text)}</span>
          </span>
          ${isSel ? CSELECT_CHECK_SVG : ''}
        `;
        const idx = this.optionBtns.length;
        btn.addEventListener('mouseenter', () => this.setFocusIndex(idx));
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.selectOptionValue(item.value);
        });
        this.optionBtns.push(btn);
        menu.appendChild(btn);
      };

      if (isTopic) {
        const regular = rawOpts.filter((o) => !o.isHistory);
        const history = rawOpts.filter((o) => o.isHistory);
        regular.forEach(appendOpt);
        if (history.length > 0) {
          const grp = document.createElement('div');
          grp.className = 'cselect-group-lbl';
          grp.setAttribute('role', 'presentation');
          grp.textContent = '历史话题';
          menu.appendChild(grp);
          history.forEach(appendOpt);
        }
      } else {
        rawOpts.forEach(appendOpt);
      }

      const selIdx = this.optionBtns.findIndex((b) => b.getAttribute('aria-selected') === 'true');
      this.focusedIdx = selIdx >= 0 ? selIdx : 0;
      if (this.optionBtns.length > 0) {
        this.optionBtns.forEach((b, i) => b.classList.toggle('is-focused', i === this.focusedIdx));
      }
    },
    positionMenu() {
      const rect = trigger.getBoundingClientRect();
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const vh = window.innerHeight;
      const minW = isTopic ? Math.min(230, vw - 16) : rect.width;
      const width = Math.min(Math.max(rect.width, minW), vw - 16);
      const left = Math.min(Math.max(8, rect.left), Math.max(8, vw - width - 8));

      menu.style.width = `${Math.round(width)}px`;
      menu.style.left = `${Math.round(left)}px`;
      menu.style.top = '0px';
      menu.style.bottom = 'auto';
      menu.style.maxHeight = '240px';

      const naturalH = Math.min(menu.scrollHeight + 4, 240);
      const spaceBelow = vh - rect.bottom - 8;
      const spaceAbove = rect.top - 8;
      if (spaceBelow >= Math.min(naturalH, 140) || spaceBelow >= spaceAbove) {
        menu.style.top = `${Math.round(rect.bottom + 4)}px`;
        menu.style.bottom = 'auto';
        menu.style.maxHeight = `${Math.max(96, Math.min(240, Math.floor(spaceBelow)))}px`;
      } else {
        menu.style.top = 'auto';
        menu.style.bottom = `${Math.round(vh - rect.top + 4)}px`;
        menu.style.maxHeight = `${Math.max(96, Math.min(240, Math.floor(spaceAbove)))}px`;
      }
    },
    open() {
      if (openCustomSelect && openCustomSelect !== this) {
        closeOpenCustomSelect(false);
      }
      this.renderMenuOptions();
      menu.classList.remove('hidden');
      this.positionMenu();
      wrap.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      openCustomSelect = this;
      const activeBtn = this.optionBtns[this.focusedIdx];
      if (activeBtn) activeBtn.scrollIntoView({ block: 'nearest' });
    },
    toggle() {
      if (openCustomSelect === this) closeOpenCustomSelect(true);
      else this.open();
    },
  };

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    inst.toggle();
  });

  trigger.addEventListener('keydown', (e) => {
    const isOpen = openCustomSelect === inst;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!isOpen) inst.open();
      else inst.setFocusIndex(inst.focusedIdx + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen) inst.open();
      else inst.setFocusIndex(inst.focusedIdx - 1);
    } else if (e.key === 'Home' && isOpen) {
      e.preventDefault();
      inst.setFocusIndex(0);
    } else if (e.key === 'End' && isOpen) {
      e.preventDefault();
      inst.setFocusIndex(inst.optionBtns.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!isOpen) inst.open();
      else if (inst.focusedIdx >= 0 && inst.optionBtns[inst.focusedIdx]) {
        inst.selectOptionValue(inst.optionBtns[inst.focusedIdx].dataset.val);
      }
    } else if (e.key === 'Escape' && isOpen) {
      e.preventDefault();
      e.stopPropagation();
      closeOpenCustomSelect(true);
    } else if (e.key === 'Tab' && isOpen) {
      closeOpenCustomSelect(false);
    }
  });

  selectEl.addEventListener('change', () => syncCustomSelectUI(selectEl));
  customSelectMap.set(selectEl, inst);
  syncCustomSelectUI(selectEl);
}

function initAllCustomSelects() {
  document.querySelectorAll('select').forEach(enhanceCustomSelect);
}

function closePopovers() {
  closeOpenCustomSelect(false);
  el.attachPopover.classList.add('hidden');
  el.paramsPopover.classList.add('hidden');
  if (el.quotaPopover) el.quotaPopover.classList.add('hidden');
  if (el.btnQuotaPill) el.btnQuotaPill.setAttribute('aria-expanded', 'false');
}

function syncSelect(selectEl, options, desiredValue) {
  const curSig = Array.from(selectEl.options)
    .map((o) => `${o.value}::${o.textContent}`)
    .join('|');
  const nextSig = options.map((o) => `${o.value}::${o.label}`).join('|');
  if (curSig !== nextSig) {
    const prev = selectEl.value;
    selectEl.innerHTML = options
      .map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`)
      .join('');
    if (desiredValue !== undefined && options.some((o) => o.value === desiredValue)) {
      selectEl.value = desiredValue;
    } else if (prev && options.some((o) => o.value === prev)) {
      selectEl.value = prev;
    }
  } else if (
    desiredValue !== undefined &&
    selectEl.value !== desiredValue &&
    options.some((o) => o.value === desiredValue)
  ) {
    selectEl.value = desiredValue;
  }
  syncCustomSelectUI(selectEl);
}

function getPersonaById(st, id) {
  return (st?.personas || []).find((p) => p.id === id) || (st?.personas || [])[0] || null;
}

function renderMemberStrip(st) {
  const personas = st?.personas || [];
  const key =
    selectedPersonaId +
    '|' +
    personas.map((p) => `${p.id}:${p.name}:${p.role || ''}:${p.avatar?.slice(0, 24)}`).join(',');
  if (key === lastMemberStripKey) return;
  lastMemberStripKey = key;

  if (personas.length === 0) {
    el.memberStrip.innerHTML = `<button type="button" class="member-chip active" id="btn-create-first-member"><span class="member-chip-label">+ 新建人物卡</span></button>`;
    el.memberStrip.querySelector('#btn-create-first-member')?.addEventListener('click', () => {
      openSettingsModal('personas', '__new__');
    });
    return;
  }

  el.memberStrip.innerHTML = personas
    .map((p) => {
      const active = p.id === selectedPersonaId;
      return `
        <button
          type="button"
          class="member-chip ${active ? 'active' : ''}"
          data-member-pick="${esc(p.id)}"
          title="${esc(p.name)}${p.role ? ` · ${esc(p.role)}` : ''}"
        >
          <span class="avatar-circle">${renderAvatarInner(p.avatar)}</span>
          ${active ? `<span class="member-chip-label">${esc(p.name)} 的工位</span>` : ''}
        </button>`;
    })
    .join('');

  el.memberStrip.querySelectorAll('[data-member-pick]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const nextId = btn.dataset.memberPick;
      if (!nextId || nextId === selectedPersonaId) return;
      switchToMemberWorkstation(nextId);
    });
  });
}

function switchToMemberWorkstation(personaId) {
  flushPendingDraftSave();
  selectedPersonaId = personaId;
  composerOverrideActive = false;
  lastMemberStripKey = '';
  lastMsgRenderKey = '';
  draftDirty = false;
  draftHydratedKey = '';

  const p = getPersonaById(serverState, personaId);
  applyPersonaDefaults(p, serverState);

  const memberSessions = (serverState?.sessions || []).filter((s) => s.personaId === personaId);
  activeSessionId = memberSessions.length > 0 ? memberSessions[0].id : '__none__';
  if (serverState) renderQuotaUI(serverState);
  syncState();
}

function getModelEffortLevels(modelSlug) {
  const map = serverState?.modelReasoningLevels;
  const lv = map && modelSlug ? map[modelSlug] : null;
  return Array.isArray(lv) && lv.length > 0 ? lv : FALLBACK_EFFORTS;
}

function syncEffortSelect(selectEl, modelSlug, desiredValue) {
  const levels = getModelEffortLevels(modelSlug);
  const pick =
    desiredValue && levels.includes(desiredValue)
      ? desiredValue
      : levels.includes(selectEl.value)
        ? selectEl.value
        : levels.includes('high')
          ? 'high'
          : levels[0];
  syncSelect(
    selectEl,
    levels.map((v) => ({ value: v, label: v })),
    pick
  );
}

function filterMeaningfulEvents(events) {
  if (!Array.isArray(events)) return [];
  return events.filter((ev) => {
    if (!ev) return false;
    if (ev.kind === 'system' || ev.kind === 'message') return false;
    const txt = String(ev.text || '').trim();
    if (!txt) return false;
    if (ev.kind === 'reasoning' && FLUFF_EVENT_TEXTS.has(txt)) return false;
    return true;
  });
}

function renderEmergencyTripButton(runningCount) {
  if (runningCount <= 0) {
    tripArmed = false;
    clearTimeout(tripResetTimer);
    tripResetTimer = null;
    el.btnEmergencyTrip.classList.add('hidden');
    el.btnEmergencyTrip.classList.remove('is-armed');
    return;
  }
  el.btnEmergencyTrip.classList.remove('hidden');
  el.btnEmergencyTrip.classList.toggle('is-armed', tripArmed);
  el.btnEmergencyTrip.textContent = tripArmed
    ? '⚠️ 再点立即全停'
    : `🛑 急停 (${runningCount})`;
}

function syncEngineStatusIndicator(persona, st) {
  if (!persona) return;
  const isApi = persona.provider === 'openai-compatible';
  el.popCodexRow.classList.toggle('hidden', isApi);
  el.popCodexFastRow.classList.toggle('hidden', isApi);
  el.popApiRow.classList.toggle('hidden', !isApi);
  if (isApi) {
    const modeTag = persona.toolMode === 'chat' ? '纯对话' : 'Agent 工具';
    el.popApiModel.textContent = `${persona.model || '未填模型'} · ${modeTag}`;
    el.statusDot.className = persona.baseUrl ? 'dot ok' : 'dot err';
    el.statusText.textContent = persona.baseUrl ? 'API' : '未配';
  } else {
    if (st?.codex?.available) {
      el.statusDot.className = 'dot ok';
      el.statusText.textContent = '就绪';
      el.statusText.title = st.codex.version || 'codex';
    } else if (st?.codex?.checking) {
      el.statusDot.className = 'dot pulse';
      el.statusText.textContent = '检测';
    } else {
      el.statusDot.className = 'dot err';
      el.statusText.textContent = '离线';
    }
  }
}

function applyPersonaDefaults(persona, st) {
  if (!persona) return;
  syncEngineStatusIndicator(persona, st);
  if (persona.provider !== 'openai-compatible') {
    if (persona.model && Array.from(el.ctrlModel.options).some((o) => o.value === persona.model)) {
      el.ctrlModel.value = persona.model;
      syncCustomSelectUI(el.ctrlModel);
    }
    syncEffortSelect(el.ctrlEffort, el.ctrlModel.value || persona.model, persona.reasoningEffort || 'high');
    el.ctrlFastMode.checked = Boolean(persona.fastMode);
  }
  composerPerms = normalizePermsClient(persona.permissions, persona.defaultSandbox);
  renderPermGroup('composer');
  syncWorkstationStatusBars();
}

// ---------------------------------------------------------------------------
// 1v1 Chatroom Station View
// ---------------------------------------------------------------------------

function renderEventsRows(events) {
  if (!events || events.length === 0) {
    return '<div class="proc-row"><span class="proc-txt">等待过程事件...</span></div>';
  }
  return events
    .map(
      (ev) => `
    <div class="proc-row kind-${esc(ev.kind)}">
      <span class="proc-ts">${fmtTimeSec(ev.ts)}</span>
      <span class="proc-txt">${esc(ev.text)}</span>
    </div>`
    )
    .join('');
}

function renderInheritedBar(sess) {
  const inh = sess?.inheritedSummary;
  if (inh && inh.summary) {
    el.inheritedBar.classList.remove('hidden');
    el.inheritedSummaryTitle.textContent = `延续「${inh.sourceTitle || '上一话题'}」的摘要`;
    if (document.activeElement !== el.inheritedEditor) {
      el.inheritedEditor.value = inh.summary;
    }
  } else {
    el.inheritedBar.classList.add('hidden');
  }
}

function renderQuotaUI(st) {
  if (!el.btnQuotaPill || !el.quotaPopover) return;
  const sess = st?.activeSession || null;
  const effectivePersona = getPersonaById(st, selectedPersonaId || sess?.personaId);
  const isApi = effectivePersona?.provider === 'openai-compatible';
  const quota = st?.quota || null;
  const sessionMatchesMember =
    Boolean(sess) && (!selectedPersonaId || sess.personaId === selectedPersonaId);
  const ctx = sessionMatchesMember ? sess?.contextUsage || null : null;
  const defaultApiMax = Number(effectivePersona?.contextWindow) || 128000;

  const ctxMax = ctx?.maxTokens || (isApi ? defaultApiMax : 0);
  const ctxUsed = ctx?.usedTokens || 0;
  const ctxPct =
    ctx && ctxMax > 0
      ? Math.min(100, Math.max(0, Math.round((ctxUsed / ctxMax) * 1000) / 10))
      : ctx?.usedPercent || 0;
  const ctxCls = ctxUsed > 0 ? contextLevelClass(ctxPct) : '';

  // 1. Compact 1-line status micro-capsule
  let pillText = '';
  let pillLevel = '';
  let pillMuted = false;
  let fillPct = 0;

  if (isApi) {
    if (ctxUsed > 0) {
      pillText = `上下文 ${fmtCompactTokens(ctxUsed)} (${Math.round(ctxPct)}%)`;
      fillPct = ctxPct;
    } else {
      pillText = '上下文 0 (0%)';
      pillMuted = true;
      fillPct = 0;
    }
    pillLevel = ctxCls;
  } else {
    if (quota?.available) {
      const parts = [];
      const remVals = [];
      let pCls = '';
      let sCls = '';
      if (quota.primary) {
        parts.push(`5h ${Math.round(quota.primary.remainingPercent)}%`);
        remVals.push(quota.primary.remainingPercent);
        pCls = quotaLevelClass(quota.primary.remainingPercent);
      }
      if (quota.secondary) {
        parts.push(`周 ${Math.round(quota.secondary.remainingPercent)}%`);
        remVals.push(quota.secondary.remainingPercent);
        sCls = quotaLevelClass(quota.secondary.remainingPercent);
      }
      if (ctx && ctxMax > 0) {
        parts.push(`上下文 ${Math.round(ctxPct)}%`);
      } else if (ctxUsed > 0) {
        parts.push(`上下文 ${fmtCompactTokens(ctxUsed)}`);
      } else {
        parts.push('上下文 0%');
      }
      pillText = parts.join(' · ');
      pillLevel = worstLevelClass(pCls, sCls, ctxCls);
      const minRem = remVals.length > 0 ? Math.min(...remVals) : 100;
      fillPct = pillLevel && ctxCls === pillLevel && ctxCls ? ctxPct : minRem;
    } else {
      pillText =
        ctx && ctxMax > 0
          ? `额度待同步 · 上下文 ${Math.round(ctxPct)}%`
          : '额度与上下文 · 暂无快照';
      pillLevel = ctxCls;
      pillMuted = !ctxCls;
      fillPct = ctxCls ? ctxPct : 0;
    }
  }

  el.quotaPillText.textContent = pillText;
  el.btnQuotaPill.classList.toggle('is-muted', pillMuted);
  applyLevelClass(el.btnQuotaPill, pillLevel);
  if (el.quotaPillFill) {
    el.quotaPillFill.style.width = `${Math.min(100, Math.max(0, fillPct))}%`;
  }

  // 2. Details Popover (#quota-popover)
  el.quotaPopTitle.textContent = isApi ? '当前话题上下文' : '配额与上下文';
  if (isApi) {
    el.quotaPopTs.textContent = ctx?.updatedAt ? `更新 ${fmtTime(ctx.updatedAt)}` : 'API 统计';
  } else {
    const srcTag = quota?.source === 'codex-live-rpc' ? '实时' : '快照';
    el.quotaPopTs.textContent = quota?.snapshotAt ? `${srcTag} ${fmtTime(quota.snapshotAt)}` : '待同步';
  }

  el.quotaCodexSection.classList.toggle('hidden', isApi);
  if (!isApi) {
    const hasQuota = Boolean(quota?.available);
    el.quotaCodexMetrics.classList.toggle('hidden', !hasQuota);
    el.quotaCodexEmpty.classList.toggle('hidden', hasQuota);

    if (hasQuota) {
      const p = quota.primary;
      el.quota5hBlock.classList.toggle('hidden', !p);
      if (p) {
        const cls = quotaLevelClass(p.remainingPercent);
        el.quota5hVal.textContent = `剩余 ${fmtPctText(p.remainingPercent)}（已用 ${fmtPctText(p.usedPercent)}）`;
        applyLevelClass(el.quota5hVal, cls);
        el.quota5hBar.style.width = `${p.remainingPercent}%`;
        applyLevelClass(el.quota5hBar, cls);
        el.quota5hSub.textContent = formatFiveHourReset(p.resetsAt);
      }

      const s = quota.secondary;
      el.quota7dBlock.classList.toggle('hidden', !s);
      if (s) {
        const cls = quotaLevelClass(s.remainingPercent);
        el.quota7dVal.textContent = `剩余 ${fmtPctText(s.remainingPercent)}（已用 ${fmtPctText(s.usedPercent)}）`;
        applyLevelClass(el.quota7dVal, cls);
        el.quota7dBar.style.width = `${s.remainingPercent}%`;
        applyLevelClass(el.quota7dBar, cls);
        el.quota7dSub.textContent = formatWeeklyReset(s.resetsAt);
      }

      el.quotaPlanLabel.textContent = fmtPlanLabel(quota.planType, quota.credits);
    } else {
      el.quotaPlanLabel.textContent = '本地快照（暂无记录）';
    }
  }

  // Context window section (shared across Codex & API)
  if (el.quotaCtxLbl) {
    el.quotaCtxLbl.textContent = isApi ? '窗口占用' : '当前话题上下文';
  }
  if (ctx && (ctxUsed > 0 || ctxMax > 0)) {
    el.quotaCtxVal.textContent =
      ctxMax > 0
        ? `已用 ${fmtCompactTokens(ctxUsed)} / ${fmtCompactTokens(ctxMax)} (${fmtPctText(ctxPct)})`
        : `已用 ${fmtCompactTokens(ctxUsed)}`;
    applyLevelClass(el.quotaCtxVal, ctxCls);
    el.quotaCtxBar.style.width = `${Math.min(100, Math.max(0, ctxPct))}%`;
    applyLevelClass(el.quotaCtxBar, ctxCls);

    const subParts = [];
    if (ctx.cachedTokens > 0) {
      subParts.push(`缓存命中 ${fmtCompactTokens(ctx.cachedTokens)}`);
    }
    if (ctx.inputTokens > 0 || ctx.outputTokens > 0) {
      subParts.push(
        `输入 ${fmtCompactTokens(ctx.inputTokens)} · 输出 ${fmtCompactTokens(ctx.outputTokens)}`
      );
    }
    el.quotaCtxSub.textContent = subParts.join(' · ') || '已统计当前话题上下文水位';
  } else {
    el.quotaCtxVal.textContent = isApi
      ? `已用 0 / ${fmtCompactTokens(defaultApiMax)} (0%)`
      : '暂无本轮统计';
    applyLevelClass(el.quotaCtxVal, '');
    el.quotaCtxBar.style.width = '0%';
    applyLevelClass(el.quotaCtxBar, '');
    el.quotaCtxSub.textContent = '发送消息后自动统计本话题上下文水位';
  }

  const canCompress =
    sessionMatchesMember &&
    ctxPct >= 65 &&
    Boolean(sess && ((sess.contentMessageCount ?? (sess.messages || []).length) > 0));
  el.quotaCompressNudge.classList.toggle('hidden', !canCompress);
}

function renderStationView(st) {
  const sess = st.activeSession;
  const persona = getPersonaById(st, sess?.personaId || selectedPersonaId);
  const profile = st.userProfile || { userName: '我', userAvatar: '🧑' };

  const allRunning = st.runningJobs || [];
  renderEmergencyTripButton(allRunning.length);

  const activeRun =
    allRunning.find((j) =>
      sess ? j.sessionId === sess.id : j.personaId === selectedPersonaId
    ) || null;

  el.btnSend.classList.toggle('hidden', Boolean(activeRun));
  el.btnAbort.classList.toggle('hidden', !activeRun);
  el.btnAbort.dataset.jobId = activeRun ? activeRun.id : '';

  renderInheritedBar(sess);
  syncWorkstationStatusBars();
  renderQuotaUI(st);

  // Empty state personalization
  if (persona) {
    el.emptyAvatar.innerHTML = renderAvatarInner(persona.avatar);
    el.emptyTitle.textContent = `${persona.name} 的 1v1 工位已就位`;
  }

  const needsReviewJob = (st.recentJobs || []).find(
    (j) => j.status === 'needs_review' && (!sess || j.sessionId === sess.id)
  );
  if (needsReviewJob) {
    el.needsReviewBanner.classList.remove('hidden');
    el.needsReviewBanner.innerHTML = `
      <div><b>⚠️ 结果待核对</b>（任务 ${esc(needsReviewJob.id.slice(0, 10))}）</div>
      <div>${esc(needsReviewJob.error || '上次任务因服务重启中断，已按安全策略停止且绝不自动重发。')}</div>
    `;
  } else {
    el.needsReviewBanner.classList.add('hidden');
  }

  const messages = sess?.messages || [];
  el.stationEmpty.classList.toggle('hidden', messages.length > 0 || Boolean(activeRun));

  const jobDetails = st.jobDetailsById || {};
  const msgKey = [
    sess?.id || 'none',
    persona?.id || '',
    persona?.name || '',
    persona?.avatar?.slice(0, 20) || '',
    profile.userName,
    profile.userAvatar?.slice(0, 20) || '',
    messages.length,
    messages
      .map(
        (m) =>
          `${m.id}:${jobDetails[m.jobId]?.status || ''}:${filterMeaningfulEvents(jobDetails[m.jobId]?.events).length}:${jobDetails[m.jobId]?.diffSummary?.stats?.totalFiles || 0}:${jobDetails[m.jobId]?.directMode ? 1 : 0}:${jobDetails[m.jobId]?.directSummary?.changedCount || 0}`
      )
      .join(','),
    hostCaps.message ? 'm1' : 'm0',
    hostCaps.updateModelContext ? 'c1' : 'c0',
  ].join('|');

  if (msgKey !== lastMsgRenderKey) {
    lastMsgRenderKey = msgKey;
    const wasAtBottom =
      el.stationScroll.scrollHeight - el.stationScroll.scrollTop - el.stationScroll.clientHeight < 60;

    el.msgList.innerHTML = '';

    for (const m of messages) {
      const j = m.jobId ? jobDetails[m.jobId] : null;
      const row = document.createElement('div');

      if (m.role === 'system') {
        row.className = 'chat-row is-system';
        row.innerHTML = `
          <div class="sys-pill">
            <div>${esc(m.text)}</div>
            ${
              hostCaps.message && j && (j.status === 'failed' || j.status === 'aborted' || j.status === 'needs_review')
                ? `<div class="sys-pill-actions"><button class="act-pill" type="button" data-forward-msg="${esc(m.id)}">转交主对话</button></div>`
                : ''
            }
          </div>`;
      } else if (m.role === 'boss' || m.role === 'hakimi') {
        row.className = 'chat-row is-user';
        const attHtml =
          Array.isArray(m.attachments) && m.attachments.length > 0
            ? `<div class="msg-atts">${m.attachments
                .map((a) =>
                  isImageAvatar(a.previewDataUrl)
                    ? `<img class="msg-att-thumb" src="${esc(a.previewDataUrl)}" alt="${esc(a.name || '图片')}" />`
                    : `<span class="msg-att-chip">🖼️ ${esc(a.name || '图片')}</span>`
                )
                .join('')}</div>`
            : '';

        row.innerHTML = `
          <span class="avatar-circle u32">${renderAvatarInner(profile.userAvatar, '🧑')}</span>
          <div class="chat-col">
            <div class="chat-caption">
              ${m.role === 'hakimi' ? '<span class="micro-badge">主对话派单</span>' : ''}
              <span>${fmtTime(m.createdAt)}</span>
              <span class="chat-caption-name">${esc(profile.userName || '我')}</span>
            </div>
            <div class="bubble-wrap">
              <div class="bubble">
                ${attHtml}
                <div class="msg-body">${renderMarkdown(m.text)}</div>
              </div>
            </div>
          </div>`;
      } else {
        row.className = 'chat-row is-assistant';
        const foldKey = `proc:${m.jobId || m.id}`;
        const meaningfulEvents = filterMeaningfulEvents(j?.events);
        const diffStats = j?.diffSummary?.hasChanges ? j.diffSummary.stats : null;
        const tampered = j?.sourceIntegrity && !j.sourceIntegrity.untouched;
        const modelText = m.model ? ` · ${esc(m.model)}` : '';

        row.innerHTML = `
          <span class="avatar-circle a36">${renderAvatarInner(persona?.avatar)}</span>
          <div class="chat-col">
            <div class="chat-caption">
              <span class="chat-caption-name">${esc(persona?.name || '副席成员')}</span>
              <span>${fmtTime(m.createdAt)}${modelText}</span>
            </div>
            <div class="bubble-wrap" data-bwrap="${esc(m.id)}">
              <div class="bubble">
                ${
                  meaningfulEvents.length > 0
                    ? `<details class="proc-fold" data-fold="${esc(foldKey)}" ${expandedFolds.has(foldKey) ? 'open' : ''}>
                        <summary><span>执行过程 (${meaningfulEvents.length})</span></summary>
                        <div class="proc-list">${renderEventsRows(meaningfulEvents)}</div>
                      </details>`
                    : ''
                }
                <div class="msg-body">${renderMarkdown(m.text)}</div>
                ${
                  tampered
                    ? `<div class="banner err" style="margin-top:6px;">⚠️ 原目录基线告警：检测到外部变动</div>`
                    : ''
                }
                ${
                  j?.directMode
                    ? `<div class="bubble-status-row"><span class="tag warn">⚡ ${esc(j.directSummary?.summary || '已在原目录直接执行')}</span></div>`
                    : diffStats
                      ? `<div class="bubble-status-row">
                           <span class="diff-chip-group">
                             <span class="diff-chip-label">影子改动 ${diffStats.totalFiles} 文件</span>
                             <span class="stat-pill add">+${diffStats.insertions}</span>
                             <span class="stat-pill del">-${diffStats.deletions}</span>
                           </span>
                           <button class="act-pill act-pill-accent" type="button" data-goto-review="${esc(j.shadowId)}">查看红绿 Diff</button>
                         </div>`
                      : ''
                }
              </div>
              <div class="hover-actions">
                <button class="act-pill" type="button" data-copy-msg="${esc(m.id)}">复制</button>
                ${
                  hostCaps.message
                    ? `<button class="act-pill" type="button" data-forward-msg="${esc(m.id)}">转交主对话</button>`
                    : ''
                }
                ${
                  hostCaps.updateModelContext
                    ? `<button class="act-pill" type="button" data-attach-ctx="${esc(m.id)}">附为上下文</button>`
                    : ''
                }
              </div>
            </div>
          </div>`;
      }

      row.querySelectorAll('details[data-fold]').forEach((det) => {
        det.addEventListener('toggle', () => {
          if (det.open) expandedFolds.add(det.dataset.fold);
          else expandedFolds.delete(det.dataset.fold);
        });
      });

      row.querySelector('[data-copy-msg]')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const ok = await copyTextReliable(m.text || '');
        showToast(ok ? '已复制回复内容' : '复制失败');
        if (ok && btn) {
          btn.textContent = '已复制 ✓';
          setTimeout(() => {
            btn.textContent = '复制';
          }, 1400);
        }
      });

      row.querySelector('[data-goto-review]')?.addEventListener('click', (e) => {
        setView('review');
        fetchDiffForShadow(e.currentTarget.dataset.gotoReview, true);
      });

      row.querySelector('[data-forward-msg]')?.addEventListener('click', async () => {
        await sendToMainChat(buildForwardPayload(persona, sess, m, j));
      });

      row.querySelector('[data-attach-ctx]')?.addEventListener('click', async () => {
        await attachAsNextContext(buildForwardPayload(persona, sess, m, j));
      });

      el.msgList.appendChild(row);
    }

    if (wasAtBottom) {
      el.stationScroll.scrollTop = el.stationScroll.scrollHeight;
    }
  }

  // Incremental live running bubble (left-aligned with 36px member avatar)
  if (activeRun) {
    let liveRow = el.liveSlot.querySelector(`[data-live-job="${CSS.escape(activeRun.id)}"]`);
    const elapsed = fmtDur(Date.now() - (activeRun.startedAt || Date.now()));
    const foldKey = `live:${activeRun.id}`;

    if (!liveRow) {
      el.liveSlot.innerHTML = '';
      liveRow = document.createElement('div');
      liveRow.className = 'chat-row is-assistant';
      liveRow.dataset.liveJob = activeRun.id;
      liveRow.innerHTML = `
        <span class="avatar-circle a36">${renderAvatarInner(persona?.avatar)}</span>
        <div class="chat-col">
          <div class="chat-caption">
            <span class="chat-caption-name">${esc(activeRun.personaName || persona?.name || '副席成员')}</span>
            <span>${esc(activeRun.model)} · <span data-live-elapsed>${elapsed}</span></span>
          </div>
          <div class="bubble-wrap">
            <div class="bubble">
              <div class="live-stage-bar">
                <span class="dot pulse"></span>
                <span class="tag ${activeRun.directMode ? 'warn' : ''}" data-live-stage>${esc(activeRun.stageLabel || '执行中')}</span>
              </div>
              <details class="proc-fold hidden" data-live-fold data-fold="${esc(foldKey)}" ${expandedFolds.has(foldKey) ? 'open' : ''}>
                <summary><span data-live-step-summary>执行过程</span></summary>
                <div class="proc-list" data-live-events></div>
              </details>
              <div class="msg-body hidden" data-live-reply></div>
            </div>
          </div>
        </div>`;
      const det = liveRow.querySelector('details');
      det.addEventListener('toggle', () => {
        if (det.open) expandedFolds.add(foldKey);
        else expandedFolds.delete(foldKey);
      });
      el.liveSlot.appendChild(liveRow);
    }

    const stageEl = liveRow.querySelector('[data-live-stage]');
    if (stageEl) stageEl.textContent = activeRun.stageLabel || '思考与执行中';

    const elapsedEl = liveRow.querySelector('[data-live-elapsed]');
    if (elapsedEl) elapsedEl.textContent = elapsed;

    const evs = filterMeaningfulEvents(activeRun.events || []);
    const liveFold = liveRow.querySelector('[data-live-fold]');
    if (liveFold) {
      liveFold.classList.toggle('hidden', evs.length === 0);
    }
    const lastEv = evs[evs.length - 1];
    const sumEl = liveRow.querySelector('[data-live-step-summary]');
    if (sumEl && evs.length > 0) {
      sumEl.textContent = `执行过程 (${evs.length})`;
    }

    const evBox = liveRow.querySelector('[data-live-events]');
    const evSig = `${evs.length}:${lastEv?.ts || 0}`;
    if (evBox && evs.length > 0 && evBox.dataset.sig !== evSig) {
      evBox.dataset.sig = evSig;
      evBox.innerHTML = renderEventsRows(evs);
      evBox.scrollTop = evBox.scrollHeight;
    }

    const replyBox = liveRow.querySelector('[data-live-reply]');
    if (replyBox) {
      if (activeRun.liveReply) {
        replyBox.classList.remove('hidden');
        if (replyBox.dataset.len !== String(activeRun.liveReply.length)) {
          replyBox.dataset.len = String(activeRun.liveReply.length);
          replyBox.innerHTML = renderMarkdown(activeRun.liveReply);
        }
      } else {
        replyBox.classList.add('hidden');
      }
    }
  } else if (el.liveSlot.children.length > 0) {
    el.liveSlot.innerHTML = '';
  }
}

function buildForwardPayload(persona, sess, msg, job) {
  const lines = [
    `[来自 SideDesk · 副席 (${persona?.name || '成员'} / ${providerShortBadge(job?.provider || persona?.provider)})]`,
    `目标目录：${sess?.sourceDir || currentSourceDir || '(未指定)'}`,
  ];
  if (job?.directMode) {
    lines.push(
      `运行模式：⚡ Turbo 直通（直接在原目录执行，未建影子副本）` +
        (job.directSummary?.summary ? ` · ${job.directSummary.summary}` : '')
    );
    if (job.directSummary?.files?.length) {
      lines.push(
        `当前 Git 变更摘要：` +
          job.directSummary.files
            .slice(0, 15)
            .map((f) => `${f.status || f.code || 'M'} ${f.path}`)
            .join('、')
      );
    }
  } else if (job?.diffSummary?.hasChanges) {
    const fs = job.diffSummary.files || [];
    lines.push(
      `影子副本变更（${fs.length} 个文件，未自动写入原目录）：` +
        fs.map((f) => `${f.status}:${f.path} (+${f.additions}/-${f.deletions})`).join('、')
    );
  }
  if (job?.error) lines.push(`报错信息：${job.error}`);
  lines.push('', msg.text || '');
  lines.push('', '请左侧主对话结合以上汇报帮我继续判断或处理下一步。');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Review / Diff View
// ---------------------------------------------------------------------------

async function fetchDiffForShadow(shadowId, force = false) {
  const existing = diffCache.get(shadowId);
  if (existing?.loading) return;
  if (!force && existing?.diff && Date.now() - existing.fetchedAt < 4000) return;

  diffCache.set(shadowId, { ...(existing || {}), loading: true, error: null });
  if (serverState && currentView === 'review') renderReviewView(serverState, true);

  try {
    const res = await callAppTool('app_get_diff', { shadowId });
    if (!res.ok) throw new Error(res.error || '获取 Diff 失败');
    const shMeta = serverState?.pendingShadows?.find((x) => x.id === shadowId);
    diffCache.set(shadowId, {
      diff: res.diff,
      fetchedAt: Date.now(),
      shadowUpdatedAt: shMeta?.updatedAt || Date.now(),
      loading: false,
      error: null,
      conflicts: null,
    });
  } catch (err) {
    diffCache.set(shadowId, { ...(existing || {}), loading: false, error: err.message });
  }

  if (serverState && currentView === 'review') renderReviewView(serverState, true);
}

function renderReviewView(st, force = false) {
  const backups = st.undoableBackups || [];
  const latestBackup = backups[0] || null;
  if (latestBackup) {
    el.undoBanner.classList.remove('hidden');
    el.undoBanner.innerHTML = `
      <div class="banner-row">
        <div>
          <b>可撤销快照</b> · 最近已应用到 <code>${esc(pathBasename(latestBackup.sourceDir))}</code>
          （改 ${latestBackup.modifiedCount} / 增 ${latestBackup.addedCount} / 删 ${latestBackup.deletedCount}）
        </div>
        <button id="btn-global-undo" class="btn btn-xs" type="button">撤销上次应用</button>
      </div>
    `;
    el.undoBanner.querySelector('#btn-global-undo').addEventListener('click', () => {
      handleUndo(latestBackup.id);
    });
  } else {
    el.undoBanner.classList.add('hidden');
  }

  const pending = st.pendingShadows || [];
  el.reviewEmpty.classList.toggle('hidden', pending.length > 0);
  if (el.reviewRoHint) {
    const showRoHint = composerPerms.fileScope === 'read-only' && pending.length > 0;
    el.reviewRoHint.classList.toggle('hidden', !showRoHint);
    if (showRoHint) {
      el.reviewRoHint.textContent =
        '当前工位处于「只读分析」模式；下方待验收改动来自之前执行的影子隔离任务，核对无误后仍可手动应用写回原目录。';
    }
  }

  const sig = pending
    .map((p) => {
      const c = diffCache.get(p.id);
      return `${p.id}:${p.updatedAt}:${c?.fetchedAt || 0}:${c?.loading ? 1 : 0}:${c?.conflicts?.length || 0}:${discardArmed.has(p.id) ? 1 : 0}`;
    })
    .join('|');
  if (!force && sig === lastReviewShadowsKey) return;
  lastReviewShadowsKey = sig;

  el.reviewList.innerHTML = '';
  for (const sh of pending) {
    const entry = diffCache.get(sh.id);
    if (!entry || (sh.updatedAt && sh.updatedAt > (entry.shadowUpdatedAt || 0) && !entry.loading)) {
      fetchDiffForShadow(sh.id, Boolean(entry));
    }

    const card = document.createElement('div');
    card.className = 'review-card';

    const diff = entry?.diff;
    const stats = diff?.stats;
    const matchingBackup = backups.find((b) => b.sourceDir === sh.sourceDir);

    let filesHtml = '';
    if (entry?.loading && !diff) {
      filesHtml = `<div class="empty-sub" style="padding:10px 0;">正在计算红绿 Diff...</div>`;
    } else if (entry?.error) {
      filesHtml = `<div class="banner err">${esc(entry.error)}</div>`;
    } else if (diff && diff.files.length > 0) {
      filesHtml = diff.files
        .map((f, idx) => {
          const fKey = `diff:${sh.id}:${f.path}`;
          const openByDefault = diff.files.length <= 2 && idx === 0 && !expandedFolds.has(`closed:${fKey}`);
          const isOpen = expandedFolds.has(fKey) || openByDefault;
          const badgeCls = f.status === 'added' ? 'ok' : f.status === 'deleted' ? 'err' : 'warn';
          const badgeTxt = f.status === 'added' ? '新增' : f.status === 'deleted' ? '删除' : '修改';
          const absOrig = joinPath(sh.sourceDir, f.path);

          return `
            <details class="diff-file" data-dfold="${esc(fKey)}" ${isOpen ? 'open' : ''}>
              <summary>
                <div class="diff-file-top">
                  <span class="tag ${badgeCls}">${badgeTxt}</span>
                  <span class="diff-fname" title="${esc(f.path)}">${esc(f.path)}</span>
                </div>
                <div class="diff-file-meta">
                  <span class="diff-file-counts">
                    <span class="stat-add">+${f.additions}</span>
                    <span class="stat-del">-${f.deletions}</span>
                  </span>
                  ${
                    hostCaps.toggleAuxPaneSupported && f.status !== 'added'
                      ? `<button class="btn-link" type="button" data-open-orig="${esc(absOrig)}">打开原文件</button>`
                      : ''
                  }
                </div>
              </summary>
              <pre class="diff-code">${renderUnifiedDiffLines(f.patch)}</pre>
            </details>`;
        })
        .join('');
    } else {
      filesHtml = `<div class="empty-sub">当前影子副本暂无差异。</div>`;
    }

    const conflictHtml = entry?.conflicts?.length
      ? `<div class="banner err">
           <div><b>⚠️ 冲突拦截（未写入原目录）</b></div>
           ${entry.conflicts.map((c) => `<div>• <code>${esc(c.path)}</code>：${esc(c.reason)}</div>`).join('')}
           <div class="action-bar">
             <button class="btn btn-danger btn-xs" type="button" data-force-apply="${esc(sh.id)}">确认忽略冲突并强制覆盖</button>
           </div>
         </div>`
      : '';

    const showPerCardUndo = Boolean(matchingBackup && matchingBackup.id !== latestBackup?.id);

    card.innerHTML = `
      <div class="review-head">
        <div class="banner-row">
          <span class="review-title">${esc(pathBasename(sh.sourceDir))}</span>
          <button class="btn btn-xs" type="button" data-refresh-diff="${esc(sh.id)}">刷新 Diff</button>
        </div>
        <div class="review-path">${esc(sh.sourceDir)}</div>
        <div class="diff-stats">
          <span class="tag">副本 ${esc(sh.id)}</span>
          ${
            stats
              ? `<span>共 ${stats.totalFiles} 文件（+${stats.added} / ~${stats.modified} / -${stats.deleted}）</span>
                 <span class="stat-add">+${stats.insertions}</span>
                 <span class="stat-del">-${stats.deletions}</span>`
              : `<span>${sh.changedCount} 个改动文件</span>`
          }
        </div>
      </div>
      ${conflictHtml}
      <div class="review-files">${filesHtml}</div>
      <div class="review-actions">
        <button class="btn btn-apply" type="button" data-apply="${esc(sh.id)}">应用到原目录</button>
        ${
          showPerCardUndo
            ? `<button class="btn" type="button" data-undo="${esc(matchingBackup.id)}">撤销上次应用</button>`
            : ''
        }
        ${
          hostCaps.message
            ? `<button class="btn" type="button" data-forward-diff="${esc(sh.id)}">转交主对话</button>`
            : ''
        }
        <button class="btn btn-danger-outline" type="button" data-discard="${esc(sh.id)}">
          ${discardArmed.has(sh.id) ? '再点一次确认丢弃' : '丢弃此副本'}
        </button>
      </div>
    `;

    card.querySelectorAll('details[data-dfold]').forEach((det) => {
      det.addEventListener('toggle', () => {
        const k = det.dataset.dfold;
        if (det.open) {
          expandedFolds.add(k);
          expandedFolds.delete(`closed:${k}`);
        } else {
          expandedFolds.delete(k);
          expandedFolds.add(`closed:${k}`);
        }
      });
    });

    card.querySelectorAll('[data-open-orig]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openFileInHostAuxPane(btn.dataset.openOrig);
      });
    });

    card.querySelector('[data-refresh-diff]')?.addEventListener('click', () => {
      fetchDiffForShadow(sh.id, true);
    });
    card.querySelector('[data-apply]')?.addEventListener('click', () => handleApply(sh.id, false));
    card.querySelector('[data-force-apply]')?.addEventListener('click', () => handleApply(sh.id, true));
    card.querySelector('[data-undo]')?.addEventListener('click', (e) => handleUndo(e.currentTarget.dataset.undo));

    card.querySelector('[data-discard]')?.addEventListener('click', async () => {
      if (!discardArmed.has(sh.id)) {
        discardArmed.add(sh.id);
        renderReviewView(serverState, true);
        setTimeout(() => {
          discardArmed.delete(sh.id);
          if (serverState && currentView === 'review') renderReviewView(serverState, true);
        }, 4000);
        return;
      }
      discardArmed.delete(sh.id);
      try {
        await callAppTool('app_discard_shadow', { shadowId: sh.id });
        diffCache.delete(sh.id);
        showToast('已丢弃该影子副本，原目录零变动');
        await syncState();
      } catch (err) {
        showToast(`丢弃失败: ${err.message}`);
      }
    });

    card.querySelector('[data-forward-diff]')?.addEventListener('click', async () => {
      const d = diffCache.get(sh.id)?.diff;
      const fileLines = (d?.files || [])
        .map((f) => `- [${f.status}] ${f.path} (+${f.additions}/-${f.deletions})`)
        .join('\n');
      const snippet = (d?.fullPatch || '').slice(0, 6000);
      const msg = [
        `[来自 SideDesk · 副席 · 待验收 Diff 交接]`,
        `目标目录：${sh.sourceDir}`,
        `影子副本：${sh.id}`,
        `改动文件：\n${fileLines || '（点击刷新查看）'}`,
        snippet ? `\nDiff 预览：\n\`\`\`diff\n${snippet}\n\`\`\`` : '',
        `\n请帮我把关这份改动，看看有没有遗漏或隐患再决定是否应用到原目录。`,
      ].join('\n');
      await sendToMainChat(msg);
    });

    el.reviewList.appendChild(card);
  }
}

async function handleApply(shadowId, force) {
  try {
    const res = await callAppTool('app_apply_shadow', { shadowId, force });
    if (res.conflict) {
      const prev = diffCache.get(shadowId) || {};
      diffCache.set(shadowId, { ...prev, conflicts: res.conflicts || [] });
      showToast('检测到原目录冲突，已安全阻断写入');
      renderReviewView(serverState, true);
      return;
    }
    if (!res.applied) {
      showToast(res.message || '无可应用的改动');
      return;
    }
    diffCache.delete(shadowId);
    showToast('已应用到原目录（已自动备份，可随时撤销）');
    await syncState();
  } catch (err) {
    showToast(`应用失败: ${err.message}`);
  }
}

const undoForceArmed = new Set();

async function handleUndo(backupId) {
  try {
    const force = undoForceArmed.has(backupId);
    const res = await callAppTool('app_undo_last_apply', { backupId, force });
    if (res.conflict && !force) {
      undoForceArmed.add(backupId);
      setTimeout(() => undoForceArmed.delete(backupId), 6000);
      showToast(`${res.message}（6 秒内再点一次「撤销上次应用」将强制还原）`);
      return;
    }
    undoForceArmed.delete(backupId);
    if (!res.undone) {
      showToast(res.message || '没有可撤销的备份');
      return;
    }
    showToast(`已撤销：还原 ${res.restoredCount} 个文件，清理 ${res.removedAddedCount} 个新增文件`);
    await syncState();
  } catch (err) {
    showToast(`撤销失败: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Settings Modal (3 Tabs: 成员人物卡 | 我的资料 | 默认权限)
// PRESERVES #pm-avatar-paste & modalAvatarValue clipboard paste workflow!
// ---------------------------------------------------------------------------

function syncAvatarControls(val) {
  const v = String(val || '🤖').trim() || '🤖';
  modalAvatarValue = v;
  el.pmAvatarPreview.innerHTML = renderAvatarInner(v, '🤖');
  if (isImageAvatar(v)) {
    el.pmAvatarText.value = '';
    el.pmAvatarText.placeholder = '已设图片头像（按 Ctrl+V 换图，或输入 Emoji 替换）';
  } else {
    el.pmAvatarText.value = v;
    el.pmAvatarText.placeholder = '输入 Emoji（如 🐱），或按 Ctrl+V 粘贴截图/图片';
  }
}

function syncProfileAvatarControls(val) {
  const v = String(val || '🧑').trim() || '🧑';
  profileAvatarValue = v;
  el.upAvatarPreview.innerHTML = renderAvatarInner(v, '🧑');
  if (isImageAvatar(v)) {
    el.upAvatarText.value = '';
    el.upAvatarText.placeholder = '已设图片头像（按 Ctrl+V 换图，或输入 Emoji 替换）';
  } else {
    el.upAvatarText.value = v;
    el.upAvatarText.placeholder = '输入 Emoji（如 🧑‍💻），或按 Ctrl+V 粘贴截图';
  }
}

function cropAvatarImageDataUrl(srcDataUrl, onDone) {
  if (!srcDataUrl) return;
  const img = new Image();
  img.onload = () => {
    const size = 96;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const minSide = Math.min(img.width, img.height);
    const sx = (img.width - minSide) / 2;
    const sy = (img.height - minSide) / 2;
    ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, size, size);
    const dataUrl = canvas.toDataURL('image/webp', 0.85);
    onDone(dataUrl);
  };
  img.onerror = () => {
    showToast('图片格式无法解析，请换一张 PNG/JPG/WebP');
  };
  img.src = String(srcDataUrl);
}

function applyImageDataUrlToAvatar(srcDataUrl) {
  cropAvatarImageDataUrl(srcDataUrl, (dataUrl) => {
    syncAvatarControls(dataUrl);
    showToast('图片头像已载入，记得点「保存人物卡」');
  });
}

function applyImageFileToAvatar(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => applyImageDataUrlToAvatar(String(reader.result || ''));
  reader.readAsDataURL(file);
}

function applyImageDataUrlToProfileAvatar(srcDataUrl) {
  cropAvatarImageDataUrl(srcDataUrl, (dataUrl) => {
    syncProfileAvatarControls(dataUrl);
    showToast('我的头像已载入，记得点「保存我的资料」');
  });
}

function applyImageFileToProfileAvatar(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => applyImageDataUrlToProfileAvatar(String(reader.result || ''));
  reader.readAsDataURL(file);
}

async function pasteAvatarFromSystemClipboard(target = 'persona') {
  const btn = target === 'profile' ? el.upAvatarPaste : el.pmAvatarPaste;
  if (btn) btn.disabled = true;
  try {
    const res = await callAppTool('app_paste_clipboard_image', { mode: 'avatar' });
    if (res?.ok && res.dataUrl) {
      if (target === 'profile') applyImageDataUrlToProfileAvatar(res.dataUrl);
      else applyImageDataUrlToAvatar(res.dataUrl);
    } else {
      showToast(res?.error || '剪贴板里没有检测到图片');
    }
  } catch (err) {
    showToast(`粘贴失败: ${err.message}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function setSettingsTab(tab) {
  closeOpenCustomSelect(false);
  settingsTab = tab;
  el.stabPersonas.classList.toggle('active', tab === 'personas');
  el.stabProfile.classList.toggle('active', tab === 'profile');
  el.stabPerms.classList.toggle('active', tab === 'perms');
  el.spanePersonas.classList.toggle('hidden', tab !== 'personas');
  el.spaneProfile.classList.toggle('hidden', tab !== 'profile');
  el.spanePerms.classList.toggle('hidden', tab !== 'perms');
}

function syncModalProviderFields() {
  const isApi = el.pmProvider.value === 'openai-compatible';
  el.pmCodexFields.classList.toggle('hidden', isApi);
  el.pmApiFields.classList.toggle('hidden', !isApi);
}

function openSettingsModal(initialTab = 'personas', targetPersonaId = '') {
  if (!serverState) return;
  closePopovers();
  const models = serverState.availableModels || [];
  syncSelect(
    el.pmCodexModel,
    (models.length ? models : ['gpt-6.2-sol']).map((m) => ({ value: m, label: m })),
    ''
  );
  modalEditingId = targetPersonaId || selectedPersonaId || serverState.personas?.[0]?.id || null;
  renderPersonaModalBody();

  // Populate User Profile tab
  const prof = serverState.userProfile || { userName: '我', userAvatar: '🧑', themeMode: 'auto' };
  el.upName.value = prof.userName || '我';
  syncProfileAvatarControls(prof.userAvatar || '🧑');
  if (prof.themeMode && !themeSaveInFlight) {
    currentThemeMode = prof.themeMode;
  }
  syncThemeToggleUI(resolveEffectiveTheme());

  // Populate Global Settings tab (Default Permissions + Extra PATH)
  setPermState('global', serverState.defaultPermissions || PRESET_SAFE);
  if (el.dpExtraPath) {
    el.dpExtraPath.value = serverState.extraPath || '';
  }
  if (el.dpNodePathHint) {
    el.dpNodePathHint.textContent = serverState.autoNodeDir
      ? `✓ 已自动补入当前 Node 路径：${serverState.autoNodeDir}（上方填写的路径优先级最高，Codex CLI 与 API 命令工具均生效）`
      : '上方填写的路径会优先注入子进程 PATH，Codex CLI 与 API 命令工具均生效';
  }

  setSettingsTab(initialTab);
  el.settingsModal.classList.remove('hidden');
}

function closeSettingsModal() {
  closeOpenCustomSelect(false);
  el.settingsModal.classList.add('hidden');
}

function renderPersonaModalBody() {
  const personas = serverState?.personas || [];
  el.modalPersonaTabs.innerHTML =
    personas
      .map((p) => {
        const badge = providerShortBadge(p.provider);
        return `<button type="button" class="pchip ${p.id === modalEditingId ? 'active' : ''}" data-pick-p="${esc(p.id)}">
          <span>${esc(p.name)}</span>
          <span class="engine-badge ${badge === 'API' ? 'api' : 'codex'}">${badge}</span>
        </button>`;
      })
      .join('') +
    `<button type="button" class="pchip ${modalEditingId === null ? 'active' : ''}" data-pick-p="__new__">+ 新建人物卡</button>`;

  el.modalPersonaTabs.querySelectorAll('[data-pick-p]').forEach((b) => {
    b.addEventListener('click', () => {
      modalEditingId = b.dataset.pickP === '__new__' ? null : b.dataset.pickP;
      renderPersonaModalBody();
    });
  });

  const p = modalEditingId ? personas.find((x) => x.id === modalEditingId) : null;
  const avatar = p?.avatar || '🤖';
  const provider = p?.provider || 'codex-cli';

  syncAvatarControls(avatar);
  el.pmName.value = p?.name || '';
  el.pmRole.value = p?.role || '';
  el.pmAddressAs.value = p?.addressUserAs || '';
  el.pmProvider.value = provider;
  modalMemories = Array.isArray(p?.memories)
    ? p.memories.map((m) => ({
        id: String(m.id || `mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`),
        text: String(m.text || ''),
        enabled: m.enabled !== false,
      }))
    : [];
  el.pmMemInput.value = '';
  renderModalMemories();

  const initPerms = p
    ? normalizePermsClient(p.permissions, p.defaultSandbox)
    : normalizePermsClient(serverState?.defaultPermissions, 'workspace-write');
  setPermState('persona', initPerms);

  if (p?.model && provider !== 'openai-compatible') {
    el.pmCodexModel.value = p.model;
  }
  syncEffortSelect(el.pmEffort, el.pmCodexModel.value || p?.model || '', p?.reasoningEffort || 'high');
  el.pmFastMode.checked = Boolean(p?.fastMode);
  el.pmCleanConfig.checked = p ? p.cleanCodexConfig !== false : true;
  if (el.pmCodexPath) el.pmCodexPath.value = p?.customCodexPath || '';

  // OpenAI-compatible API fields (NEVER prefill raw key; show masked hint!)
  el.pmBaseUrl.value = p?.baseUrl || '';
  el.pmApiKey.value = '';
  el.pmClearKey.checked = false;
  if (p?.hasApiKey) {
    el.pmApiKey.placeholder = `已保存 (${p.apiKeyHint || '****'})，留空保持不变`;
    el.pmClearKeyWrap.classList.remove('hidden');
  } else {
    el.pmApiKey.placeholder = '留空表示免鉴权（如本地 Ollama / LM Studio）';
    el.pmClearKeyWrap.classList.add('hidden');
  }
  el.pmApiModel.value = provider === 'openai-compatible' ? (p?.model || '') : '';
  el.pmToolMode.value = p?.toolMode || 'agent';
  if (el.pmContextWindow) {
    el.pmContextWindow.value =
      provider === 'openai-compatible' && p?.contextWindow ? String(p.contextWindow) : '';
  }
  syncCustomSelectUI(el.pmProvider);
  syncCustomSelectUI(el.pmCodexModel);
  syncCustomSelectUI(el.pmEffort);
  syncCustomSelectUI(el.pmToolMode);

  el.pmPrompt.value = p?.systemPrompt || '';
  el.pmDelete.disabled = !p;
  el.pmTestResult.classList.add('hidden');
  el.pmTestResult.textContent = '';

  syncModalProviderFields();
}

function renderModalMemories() {
  const activeCount = modalMemories.filter((m) => m.enabled).length;
  el.pmMemCount.textContent =
    modalMemories.length > 0 ? `${activeCount}/${modalMemories.length} 生效` : '0 条';
  if (modalMemories.length === 0) {
    el.pmMemList.innerHTML = `<div class="field-hint" style="padding:2px 0;">暂无长期记忆条，添加后会自动锚定到该成员对话中。</div>`;
    return;
  }
  el.pmMemList.innerHTML = modalMemories
    .map(
      (m) => `
      <div class="mem-item ${m.enabled ? '' : 'is-off'}">
        <input type="checkbox" data-mem-toggle="${esc(m.id)}" ${m.enabled ? 'checked' : ''} aria-label="启用该条记忆" />
        <span class="mem-text">${esc(m.text)}</span>
        <button type="button" class="mem-del" data-mem-del="${esc(m.id)}" title="删除" aria-label="删除记忆">×</button>
      </div>`
    )
    .join('');

  el.pmMemList.querySelectorAll('[data-mem-toggle]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const target = modalMemories.find((x) => x.id === cb.dataset.memToggle);
      if (target) target.enabled = cb.checked;
      renderModalMemories();
    });
  });

  el.pmMemList.querySelectorAll('[data-mem-del]').forEach((btn) => {
    btn.addEventListener('click', () => {
      modalMemories = modalMemories.filter((x) => x.id !== btn.dataset.memDel);
      renderModalMemories();
    });
  });
}

function addModalMemoryFromInput() {
  const text = el.pmMemInput.value.trim();
  if (!text) return;
  if (modalMemories.length >= 50) {
    showToast('单张人物卡最多保存 50 条记忆');
    return;
  }
  modalMemories.push({
    id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    text: text.slice(0, 300),
    enabled: true,
  });
  el.pmMemInput.value = '';
  renderModalMemories();
}

// ---------------------------------------------------------------------------
// New Topic Modal (+ 开新话题 · 压缩摘要继承)
// ---------------------------------------------------------------------------

function getDefaultNewTopicTitle() {
  const persona = getPersonaById(serverState, selectedPersonaId);
  const shortName = String(persona?.name || '').split(/[·\s]/)[0].trim();
  return shortName ? `${shortName} · 新话题` : '新话题';
}

function openNewTopicModal() {
  if (!currentSourceDir) {
    el.dirDrawer.classList.remove('hidden');
    el.inputSourceDir.focus();
    showToast('请先绑定工作文件夹');
    return;
  }
  closePopovers();

  const sess = serverState?.activeSession;
  const personas = serverState?.personas || [];
  el.ntTitle.value = '';
  el.ntTitle.placeholder = getDefaultNewTopicTitle();

  const hasMsgs = Boolean(sess && (sess.contentMessageCount || 0) > 0);
  el.ntInheritSection.classList.toggle('hidden', !hasMsgs);

  if (hasMsgs) {
    el.ntInherit.checked = true;
    el.ntSummaryDetail.classList.remove('hidden');
    if (sess.hasFreshSummary) {
      el.ntSummaryFresh.classList.remove('hidden');
      el.ntSummaryNeed.classList.add('hidden');
    } else {
      el.ntSummaryFresh.classList.add('hidden');
      el.ntSummaryNeed.classList.remove('hidden');
      el.ntSummaryNeedText.textContent = `✨ 会先把「${sess.title}」压缩成摘要，这需要使用一次成员额度`;
      syncSelect(
        el.ntSummarizer,
        personas.map((p) => ({
          value: p.id,
          label: `${p.name} (${providerShortBadge(p.provider)})`,
        })),
        selectedPersonaId || personas[0]?.id || ''
      );
    }
  }

  el.newTopicModal.classList.remove('hidden');
  el.ntTitle.focus();
}

function closeNewTopicModal() {
  closeOpenCustomSelect(false);
  el.newTopicModal.classList.add('hidden');
}

async function confirmCreateNewTopic() {
  const sess = serverState?.activeSession;
  const hasMsgs = Boolean(sess && (sess.contentMessageCount || 0) > 0);
  const inheritSummary = hasMsgs && el.ntInherit.checked;
  const title = el.ntTitle.value.trim() || el.ntTitle.placeholder || getDefaultNewTopicTitle();

  el.btnNtConfirm.disabled = true;
  el.btnNtConfirm.textContent =
    inheritSummary && !sess?.hasFreshSummary ? '正在压缩摘要...' : '创建中...';

  try {
    const res = await callAppTool('app_new_session', {
      personaId: selectedPersonaId || serverState?.personas?.[0]?.id || 'codex-default',
      sourceDir: currentSourceDir,
      title,
      sourceSessionId: inheritSummary && sess ? sess.id : undefined,
      inheritSummary,
      summarizerPersonaId: inheritSummary ? el.ntSummarizer.value : undefined,
    });
    activeSessionId = res.session?.id || '';
    draftDirty = false;
    draftHydratedKey = '';
    lastMsgRenderKey = '';
    closeNewTopicModal();
    if (inheritSummary) {
      showToast(res.reusedSummary ? '已开启新话题（零额度复用已有摘要）' : '已压缩摘要并开启新话题');
    } else {
      showToast('已开启新话题（旧话题已归档）');
    }
    await syncState();
    el.draftInput.focus();
  } catch (err) {
    showToast(`开新话题失败: ${err.message}`);
  } finally {
    el.btnNtConfirm.disabled = false;
    el.btnNtConfirm.textContent = '开始新话题';
  }
}

// ---------------------------------------------------------------------------
// Topic Manager Modal (⋯)
// ---------------------------------------------------------------------------

function openTopicMgrModal() {
  closePopovers();
  tmRenamingId = null;
  el.tmExportSheet.classList.add('hidden');
  const personas = serverState?.personas || [];
  syncSelect(
    el.tmSummarizer,
    personas.map((p) => ({
      value: p.id,
      label: `${p.name} (${providerShortBadge(p.provider)})`,
    })),
    selectedPersonaId || personas[0]?.id || ''
  );
  renderTopicManagerList();
  el.topicMgrModal.classList.remove('hidden');
}

function closeTopicMgrModal() {
  closeOpenCustomSelect(false);
  el.topicMgrModal.classList.add('hidden');
}

function renderTopicManagerList() {
  const all = serverState?.sessions || [];
  const filtered =
    tmFilterMode === 'current'
      ? all.filter((s) => s.personaId === selectedPersonaId)
      : all;
  const curId = serverState?.activeSession?.id || activeSessionId;

  if (filtered.length === 0) {
    el.tmList.innerHTML = `<div class="empty-sub" style="text-align:center;padding:18px 0;">暂无话题记录</div>`;
    return;
  }

  el.tmList.innerHTML = '';
  for (const s of filtered) {
    const isCurrent = s.id === curId;
    const p = getPersonaById(serverState, s.personaId);
    const card = document.createElement('div');
    card.className = `tm-card ${isCurrent ? 'is-current' : ''}`;

    const isRenaming = tmRenamingId === s.id;
    card.innerHTML = `
      <div class="tm-head">
        ${
          isRenaming
            ? `<div class="tm-rename-row" style="flex:1;">
                 <input class="input-compact" data-tm-rename-input value="${esc(s.title)}" />
                 <button class="btn btn-xs btn-primary" type="button" data-tm-rename-save="${esc(s.id)}">保存</button>
                 <button class="btn btn-xs" type="button" data-tm-rename-cancel>取消</button>
               </div>`
            : `<span class="tm-title" title="${esc(s.title)}">${esc(s.title)}</span>
               ${isCurrent ? '<span class="tag ok">当前</span>' : ''}`
        }
      </div>
      <div class="tm-meta">
        <span>${esc(p?.name || s.personaId)}</span>
        <span>${s.contentMessageCount ?? s.messageCount} 条消息</span>
        <span>${fmtDateTime(s.createdAt || s.updatedAt)}</span>
        ${s.hasFreshSummary ? '<span class="tag ok">有最新摘要</span>' : ''}
      </div>
      <div class="tm-actions">
        <div class="tm-actions-main">
          ${!isCurrent ? `<button class="btn btn-xs btn-primary" type="button" data-tm-switch="${esc(s.id)}" data-tm-persona="${esc(s.personaId)}">切换</button>` : ''}
          <button class="btn btn-xs btn-ghost-xs" type="button" data-tm-rename="${esc(s.id)}">改名</button>
          <button class="btn btn-xs btn-ghost-xs" type="button" data-tm-compress="${esc(s.id)}" ${(s.contentMessageCount ?? s.messageCount) === 0 ? 'disabled' : ''}>压缩</button>
          <button class="btn btn-xs btn-ghost-xs" type="button" data-tm-export="${esc(s.id)}">导出</button>
        </div>
        <div class="tm-actions-danger">
          <button class="btn btn-xs btn-ghost-danger ${tmClearArmed.has(s.id) ? 'is-armed' : ''}" type="button" data-tm-clear="${esc(s.id)}">${tmClearArmed.has(s.id) ? '确认清空' : '清空'}</button>
          <button class="btn btn-xs btn-ghost-danger ${tmDeleteArmed.has(s.id) ? 'is-armed' : ''}" type="button" data-tm-delete="${esc(s.id)}">${tmDeleteArmed.has(s.id) ? '确认删除' : '删除'}</button>
        </div>
      </div>
    `;

    card.querySelector('[data-tm-switch]')?.addEventListener('click', (e) => {
      flushPendingDraftSave();
      const sid = e.currentTarget.dataset.tmSwitch;
      const pid = e.currentTarget.dataset.tmPersona;
      if (pid && pid !== selectedPersonaId) {
        selectedPersonaId = pid;
        lastMemberStripKey = '';
      }
      activeSessionId = sid;
      draftDirty = false;
      draftHydratedKey = '';
      lastMsgRenderKey = '';
      closeTopicMgrModal();
      syncState();
    });

    card.querySelector('[data-tm-rename]')?.addEventListener('click', () => {
      tmRenamingId = s.id;
      renderTopicManagerList();
      const inp = el.tmList.querySelector('[data-tm-rename-input]');
      if (inp) {
        inp.focus();
        inp.select();
      }
    });

    card.querySelector('[data-tm-rename-input]')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        card.querySelector('[data-tm-rename-save]')?.click();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        tmRenamingId = null;
        renderTopicManagerList();
      }
    });

    card.querySelector('[data-tm-rename-cancel]')?.addEventListener('click', () => {
      tmRenamingId = null;
      renderTopicManagerList();
    });

    card.querySelector('[data-tm-rename-save]')?.addEventListener('click', async () => {
      const val = card.querySelector('[data-tm-rename-input]')?.value?.trim();
      if (!val) {
        showToast('话题名称不能为空');
        return;
      }
      try {
        await callAppTool('app_rename_session', { sessionId: s.id, title: val });
        tmRenamingId = null;
        showToast('已重命名话题');
        await syncState();
        renderTopicManagerList();
      } catch (err) {
        showToast(`改名失败: ${err.message}`);
      }
    });

    card.querySelector('[data-tm-compress]')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = '压缩中...';
      try {
        await callAppTool('app_compress_session', {
          sessionId: s.id,
          summarizerPersonaId: el.tmSummarizer.value || undefined,
        });
        showToast('已原地压缩上下文并重置长线程');
        lastMsgRenderKey = '';
        await syncState();
        renderTopicManagerList();
      } catch (err) {
        showToast(`压缩失败: ${err.message}`);
        btn.disabled = false;
        btn.textContent = '压缩';
      }
    });

    card.querySelector('[data-tm-export]')?.addEventListener('click', async () => {
      try {
        const res = await callAppTool('app_export_session', { sessionId: s.id });
        lastExported = res;
        el.tmExportTitle.textContent = `导出：${res.filename}`;
        el.tmExportPath.textContent = `已保存至：${res.savedPath}`;
        el.tmExportMd.value = res.markdown || '';
        el.tmExportSheet.classList.remove('hidden');
        showToast('已生成 Markdown 导出文件');
      } catch (err) {
        showToast(`导出失败: ${err.message}`);
      }
    });

    card.querySelector('[data-tm-clear]')?.addEventListener('click', async () => {
      if (!tmClearArmed.has(s.id)) {
        tmClearArmed.add(s.id);
        renderTopicManagerList();
        setTimeout(() => {
          tmClearArmed.delete(s.id);
          if (!el.topicMgrModal.classList.contains('hidden')) renderTopicManagerList();
        }, 4000);
        return;
      }
      tmClearArmed.delete(s.id);
      try {
        await callAppTool('app_clear_session', { sessionId: s.id });
        lastMsgRenderKey = '';
        showToast('已清空该话题对话记录');
        await syncState();
        renderTopicManagerList();
      } catch (err) {
        showToast(`清空失败: ${err.message}`);
      }
    });

    card.querySelector('[data-tm-delete]')?.addEventListener('click', async () => {
      if (!tmDeleteArmed.has(s.id)) {
        tmDeleteArmed.add(s.id);
        renderTopicManagerList();
        setTimeout(() => {
          tmDeleteArmed.delete(s.id);
          if (!el.topicMgrModal.classList.contains('hidden')) renderTopicManagerList();
        }, 4000);
        return;
      }
      tmDeleteArmed.delete(s.id);
      try {
        await callAppTool('app_delete_session', { sessionId: s.id });
        if (activeSessionId === s.id) {
          activeSessionId = '';
          lastMsgRenderKey = '';
        }
        showToast('已删除话题');
        await syncState();
        renderTopicManagerList();
      } catch (err) {
        showToast(`删除失败: ${err.message}`);
      }
    });

    el.tmList.appendChild(card);
  }
}

// ---------------------------------------------------------------------------
// Core Event Wiring
// ---------------------------------------------------------------------------

wirePermissionControls();

el.tabStation.addEventListener('click', () => setView('station'));
el.tabReview.addEventListener('click', () => setView('review'));
el.btnSettings.addEventListener('click', () => openSettingsModal('personas', selectedPersonaId));

el.btnThemeToggle?.addEventListener('click', () => {
  const next = resolveEffectiveTheme() === 'dark' ? 'light' : 'dark';
  setThemeModeAndPersist(next, false);
});

el.upThemeSeg?.querySelectorAll('[data-theme-val]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const val = btn.dataset.themeVal;
    if (val === 'auto' || val === 'light' || val === 'dark') {
      setThemeModeAndPersist(val, false);
    }
  });
});

// Settings tabs
el.stabPersonas.addEventListener('click', () => setSettingsTab('personas'));
el.stabProfile.addEventListener('click', () => setSettingsTab('profile'));
el.stabPerms.addEventListener('click', () => setSettingsTab('perms'));
el.btnModalClose.addEventListener('click', closeSettingsModal);
el.pmCancel.addEventListener('click', closeSettingsModal);
el.settingsModal.addEventListener('click', (e) => {
  if (e.target === el.settingsModal) closeSettingsModal();
});

// Persona modal events (PRESERVED clipboard paste & avatar editor)
el.pmProvider.addEventListener('change', () => {
  syncModalProviderFields();
  el.pmTestResult.classList.add('hidden');
});

el.pmCodexModel.addEventListener('change', () => {
  syncEffortSelect(el.pmEffort, el.pmCodexModel.value, el.pmEffort.value);
});

el.pmMemAdd.addEventListener('click', addModalMemoryFromInput);
el.pmMemInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    addModalMemoryFromInput();
  }
});

el.pmAvatarText.addEventListener('input', () => {
  const raw = el.pmAvatarText.value.trim();
  if (isImageAvatar(raw)) {
    applyImageDataUrlToAvatar(raw);
    return;
  }
  if (raw) {
    modalAvatarValue = raw;
    el.pmAvatarPreview.innerHTML = renderAvatarInner(raw, '🤖');
  } else if (!isImageAvatar(modalAvatarValue)) {
    modalAvatarValue = '🤖';
    el.pmAvatarPreview.innerHTML = renderAvatarInner('🤖', '🤖');
  }
});

el.pmAvatarFile.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) applyImageFileToAvatar(file);
  e.target.value = '';
});

el.pmAvatarPaste?.addEventListener('click', () => {
  pasteAvatarFromSystemClipboard('persona');
});

el.pmAvatarPreview.addEventListener('dragover', (e) => e.preventDefault());
el.pmAvatarPreview.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = Array.from(e.dataTransfer?.files || []).find((f) => f.type?.startsWith('image/'));
  if (file) applyImageFileToAvatar(file);
});

// Profile avatar events
el.upAvatarText.addEventListener('input', () => {
  const raw = el.upAvatarText.value.trim();
  if (isImageAvatar(raw)) {
    applyImageDataUrlToProfileAvatar(raw);
    return;
  }
  if (raw) {
    profileAvatarValue = raw;
    el.upAvatarPreview.innerHTML = renderAvatarInner(raw, '🧑');
  } else if (!isImageAvatar(profileAvatarValue)) {
    profileAvatarValue = '🧑';
    el.upAvatarPreview.innerHTML = renderAvatarInner('🧑', '🧑');
  }
});

el.upAvatarFile.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) applyImageFileToProfileAvatar(file);
  e.target.value = '';
});

el.upAvatarPaste?.addEventListener('click', () => {
  pasteAvatarFromSystemClipboard('profile');
});

el.upAvatarPreview.addEventListener('dragover', (e) => e.preventDefault());
el.upAvatarPreview.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = Array.from(e.dataTransfer?.files || []).find((f) => f.type?.startsWith('image/'));
  if (file) applyImageFileToProfileAvatar(file);
});

// Modal-wide Ctrl+V paste handler (supports both Persona tab and Profile tab!)
el.settingsModal.addEventListener('paste', (e) => {
  if (el.settingsModal.classList.contains('hidden')) return;
  if (settingsTab !== 'personas' && settingsTab !== 'profile') return;
  const target = settingsTab === 'profile' ? 'profile' : 'persona';
  const applyFile = target === 'profile' ? applyImageFileToProfileAvatar : applyImageFileToAvatar;
  const avatarTextInput = target === 'profile' ? el.upAvatarText : el.pmAvatarText;

  const cd = e.clipboardData;
  if (cd) {
    const items = Array.from(cd.items || []);
    const imgItem = items.find((it) => it.type && it.type.startsWith('image/'));
    if (imgItem) {
      const blob = imgItem.getAsFile();
      if (blob) {
        e.preventDefault();
        applyFile(blob);
        return;
      }
    }
    const files = Array.from(cd.files || []);
    const imgFile = files.find((f) => f.type && f.type.startsWith('image/'));
    if (imgFile) {
      e.preventDefault();
      applyFile(imgFile);
      return;
    }
  }
  const tag = e.target?.tagName;
  const isOtherTextInput =
    (tag === 'INPUT' || tag === 'TEXTAREA') && e.target !== avatarTextInput;
  const plainText = cd?.getData?.('text/plain') || '';
  if (!isOtherTextInput && !plainText) {
    e.preventDefault();
    pasteAvatarFromSystemClipboard(target);
  }
});

el.pmRecheckCodex.addEventListener('click', async () => {
  el.pmRecheckCodex.disabled = true;
  const customCodexPath = el.pmCodexPath?.value?.trim() || '';
  el.pmCodexHint.textContent = customCodexPath
    ? '正在验证自定义 Codex 路径...'
    : '正在异步探测本机 Codex CLI...';
  try {
    const res = await callAppTool('app_test_provider', {
      provider: 'codex-cli',
      customCodexPath: customCodexPath || undefined,
    });
    if (res.ok) {
      el.pmCodexHint.textContent = `已就绪 · ${res.codexVersion || 'codex'} (${res.latencyMs}ms)`;
      showToast(`已检测到 ${res.codexVersion || 'Codex CLI'}`);
    } else {
      el.pmCodexHint.textContent = res.error || '未检测到 Codex CLI';
      showToast(res.error || '未检测到 Codex CLI');
    }
    await syncState();
  } catch (err) {
    el.pmCodexHint.textContent = `探测失败: ${err.message}`;
  } finally {
    el.pmRecheckCodex.disabled = false;
  }
});

el.pmApiPresets?.querySelectorAll('[data-api-preset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const preset = API_PLATFORM_PRESETS[btn.dataset.apiPreset];
    if (!preset) return;
    el.pmBaseUrl.value = preset.baseUrl;
    el.pmApiModel.value = preset.model;
    el.pmTestResult.classList.add('hidden');
    showToast(`已填入 ${preset.label} 标准地址与示例模型（未改动 API Key）`);
  });
});

el.pmTestConn.addEventListener('click', async () => {
  const baseUrl = el.pmBaseUrl.value.trim();
  const model = el.pmApiModel.value.trim();
  if (!baseUrl || !model) {
    el.pmTestResult.className = 'test-result err';
    el.pmTestResult.textContent = '请先填写 Base URL 和 Model 模型名';
    return;
  }
  el.pmTestConn.disabled = true;
  el.pmTestResult.className = 'test-result';
  el.pmTestResult.textContent = '正在通过后端探测连接...';
  try {
    const res = await callAppTool('app_test_provider', {
      provider: 'openai-compatible',
      baseUrl,
      apiKey: el.pmApiKey.value.trim() || undefined,
      model,
      existingPersonaId: modalEditingId || undefined,
      clearApiKey: el.pmClearKey.checked,
    });
    if (res.ok) {
      el.pmTestResult.className = 'test-result ok';
      el.pmTestResult.textContent = `连接成功 · ${res.latencyMs}ms · ${res.model}`;
    } else {
      el.pmTestResult.className = 'test-result err';
      el.pmTestResult.textContent = `连接失败 (${res.latencyMs}ms)：${res.error || '未知错误'}`;
    }
  } catch (err) {
    el.pmTestResult.className = 'test-result err';
    el.pmTestResult.textContent = `探测异常：${err.message}`;
  } finally {
    el.pmTestConn.disabled = false;
  }
});

el.pmSave.addEventListener('click', async () => {
  const name = el.pmName.value.trim();
  if (!name) {
    showToast('请填写角色名字');
    return;
  }
  const provider = el.pmProvider.value;
  const isApi = provider === 'openai-compatible';
  const model = isApi ? el.pmApiModel.value.trim() : el.pmCodexModel.value;
  if (isApi && !el.pmBaseUrl.value.trim()) {
    showToast('请填写 OpenAI 兼容 API 的 Base URL');
    return;
  }
  if (isApi && !model) {
    showToast('请填写 Model 模型名');
    return;
  }

  el.pmSave.disabled = true;
  try {
    const res = await callAppTool('app_save_persona', {
      id: modalEditingId || undefined,
      name,
      role: el.pmRole.value.trim(),
      avatar: el.pmAvatarText.value.trim() || modalAvatarValue || '🤖',
      addressUserAs: el.pmAddressAs.value.trim(),
      memories: modalMemories,
      provider,
      model,
      reasoningEffort: el.pmEffort.value,
      fastMode: isApi ? false : el.pmFastMode.checked,
      cleanCodexConfig: isApi ? true : el.pmCleanConfig.checked,
      customCodexPath: isApi ? '' : el.pmCodexPath?.value?.trim() || '',
      defaultSandbox: permsToSandboxClient(personaModalPerms),
      permissions: personaModalPerms,
      baseUrl: isApi ? el.pmBaseUrl.value.trim() : '',
      apiKey: isApi ? el.pmApiKey.value.trim() : '',
      clearApiKey: isApi ? el.pmClearKey.checked : false,
      toolMode: isApi ? el.pmToolMode.value : 'agent',
      contextWindow:
        isApi && el.pmContextWindow?.value?.trim()
          ? Math.max(0, Math.round(Number(el.pmContextWindow.value.trim()) || 0))
          : 0,
      systemPrompt: el.pmPrompt.value,
    });
    const nextPid = res.persona?.id || selectedPersonaId;
    if (nextPid !== selectedPersonaId) {
      flushPendingDraftSave();
      selectedPersonaId = nextPid;
      const memberSessions = (serverState?.sessions || []).filter((s) => s.personaId === nextPid);
      activeSessionId = memberSessions.length > 0 ? memberSessions[0].id : '__none__';
      draftDirty = false;
      draftHydratedKey = '';
    }
    composerOverrideActive = false;
    lastMemberStripKey = '';
    lastMsgRenderKey = '';
    closeSettingsModal();
    showToast(`已保存人物卡「${name}」`);
    await syncState();
    applyPersonaDefaults(res.persona, serverState);
  } catch (err) {
    showToast(`保存失败: ${err.message}`);
  } finally {
    el.pmSave.disabled = false;
  }
});

el.pmDelete.addEventListener('click', async () => {
  if (!modalEditingId) return;
  try {
    await callAppTool('app_delete_persona', { id: modalEditingId });
    selectedPersonaId = '';
    activeSessionId = '';
    lastMemberStripKey = '';
    lastMsgRenderKey = '';
    closeSettingsModal();
    showToast('已删除该人物卡');
    await syncState();
  } catch (err) {
    showToast(`删除失败: ${err.message}`);
  }
});

el.upSave.addEventListener('click', async () => {
  el.upSave.disabled = true;
  try {
    const userName = el.upName.value.trim() || '我';
    const userAvatar = el.upAvatarText.value.trim() || profileAvatarValue || '🧑';
    await callAppTool('app_save_user_profile', {
      userName,
      userAvatar,
      themeMode: currentThemeMode,
    });
    lastMsgRenderKey = '';
    showToast(`已保存资料（称呼：${userName}）`);
    await syncState();
  } catch (err) {
    showToast(`保存资料失败: ${err.message}`);
  } finally {
    el.upSave.disabled = false;
  }
});

el.dpSave.addEventListener('click', async () => {
  el.dpSave.disabled = true;
  try {
    await callAppTool('app_save_default_permissions', {
      ...globalModalPerms,
      extraPath: el.dpExtraPath ? el.dpExtraPath.value.trim() : undefined,
    });
    showToast('已保存全局设置');
    await syncState();
  } catch (err) {
    showToast(`保存全局设置失败: ${err.message}`);
  } finally {
    el.dpSave.disabled = false;
  }
});

// Folder drawer events
el.btnDirToggle.addEventListener('click', () => {
  el.dirDrawer.classList.toggle('hidden');
  if (!el.dirDrawer.classList.contains('hidden')) {
    el.inputSourceDir.value = currentSourceDir;
    el.inputSourceDir.focus();
  }
});

el.btnDirSave.addEventListener('click', async () => {
  currentSourceDir = el.inputSourceDir.value.trim();
  syncWorkstationStatusBars();
  el.dirDrawer.classList.add('hidden');
  if (currentSourceDir) {
    await callAppTool('app_save_draft', {
      key: currentDraftKey(),
      text: el.draftInput.value,
      sourceDir: currentSourceDir,
    });
    showToast(`已切换文件夹：${pathBasename(currentSourceDir)}`);
    await syncState();
  }
});

// Topic switcher, New Topic modal & Topic Manager modal
el.ctrlSession.addEventListener('change', () => {
  flushPendingDraftSave();
  activeSessionId = el.ctrlSession.value || '__none__';
  draftDirty = false;
  draftHydratedKey = '';
  lastMsgRenderKey = '';
  syncState();
});

el.btnNewTopic.addEventListener('click', openNewTopicModal);
el.btnNtClose.addEventListener('click', closeNewTopicModal);
el.btnNtCancel.addEventListener('click', closeNewTopicModal);
el.newTopicModal.addEventListener('click', (e) => {
  if (e.target === el.newTopicModal) closeNewTopicModal();
});
el.ntInherit.addEventListener('change', () => {
  el.ntSummaryDetail.classList.toggle('hidden', !el.ntInherit.checked);
});
el.ntTitle.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    if (!el.btnNtConfirm.disabled) confirmCreateNewTopic();
  }
});
el.btnNtConfirm.addEventListener('click', confirmCreateNewTopic);

el.btnTopicMgr.addEventListener('click', openTopicMgrModal);
el.btnTmClose.addEventListener('click', closeTopicMgrModal);
el.topicMgrModal.addEventListener('click', (e) => {
  if (e.target === el.topicMgrModal) closeTopicMgrModal();
});
el.tmFilterCur.addEventListener('click', () => {
  tmFilterMode = 'current';
  el.tmFilterCur.classList.add('active');
  el.tmFilterAll.classList.remove('active');
  renderTopicManagerList();
});
el.tmFilterAll.addEventListener('click', () => {
  tmFilterMode = 'all';
  el.tmFilterAll.classList.add('active');
  el.tmFilterCur.classList.remove('active');
  renderTopicManagerList();
});
el.tmExportClose.addEventListener('click', () => el.tmExportSheet.classList.add('hidden'));
el.tmExportCopy.addEventListener('click', async () => {
  const ok = await copyTextReliable(el.tmExportMd.value);
  showToast(ok ? '已复制 Markdown 记录' : '复制失败');
});
el.tmExportDl.addEventListener('click', () => {
  if (!lastExported) return;
  try {
    const blob = new Blob([lastExported.markdown || ''], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = lastExported.filename || 'topic.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    showToast('当前视图请点「复制 Markdown」或「侧栏打开」');
  }
});
el.tmExportOpen.addEventListener('click', () => {
  if (lastExported?.savedPath) openFileInHostAuxPane(lastExported.savedPath);
});

// Inherited summary strip actions
el.btnClearInherited.addEventListener('click', async () => {
  const sid = serverState?.activeSession?.id;
  if (!sid) return;
  try {
    await callAppTool('app_clear_inherited_summary', { sessionId: sid });
    showToast('已解绑前序摘要，后续轮次不再注入');
    await syncState();
  } catch (err) {
    showToast(`解绑失败: ${err.message}`);
  }
});

el.btnSaveInherited.addEventListener('click', async () => {
  const sid = serverState?.activeSession?.id;
  if (!sid) return;
  try {
    await callAppTool('app_update_inherited_summary', {
      sessionId: sid,
      summary: el.inheritedEditor.value,
    });
    showToast('已更新延续摘要内容');
    await syncState();
  } catch (err) {
    showToast(`保存失败: ${err.message}`);
  }
});

// Composer popovers & image attachments
el.btnAttach.addEventListener('click', (e) => {
  e.stopPropagation();
  el.paramsPopover.classList.add('hidden');
  if (el.quotaPopover) el.quotaPopover.classList.add('hidden');
  if (el.btnQuotaPill) el.btnQuotaPill.setAttribute('aria-expanded', 'false');
  el.attachPopover.classList.toggle('hidden');
});

el.btnAttachFile.addEventListener('click', () => {
  el.attachPopover.classList.add('hidden');
  el.composerImgFile.click();
});

el.btnAttachClip.addEventListener('click', pasteComposerImageFromSystemClipboard);

el.composerImgFile.addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []);
  for (const f of files) addPendingAttachmentFile(f);
  e.target.value = '';
});

el.btnParamsPop.addEventListener('click', (e) => {
  e.stopPropagation();
  el.attachPopover.classList.add('hidden');
  if (el.quotaPopover) el.quotaPopover.classList.add('hidden');
  if (el.btnQuotaPill) el.btnQuotaPill.setAttribute('aria-expanded', 'false');
  el.paramsPopover.classList.toggle('hidden');
});

el.btnQuotaPill?.addEventListener('click', (e) => {
  e.stopPropagation();
  el.attachPopover.classList.add('hidden');
  el.paramsPopover.classList.add('hidden');
  const willOpen = el.quotaPopover.classList.contains('hidden');
  el.quotaPopover.classList.toggle('hidden', !willOpen);
  el.btnQuotaPill.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  if (willOpen && serverState) {
    renderQuotaUI(serverState);
  }
});

el.btnQuotaRefresh?.addEventListener('click', async () => {
  el.btnQuotaRefresh.disabled = true;
  el.btnQuotaRefresh.textContent = '刷新中...';
  try {
    const res = await callAppTool('app_refresh_quota', {
      sessionId: serverState?.activeSession?.id || undefined,
    });
    if (serverState) {
      if (res?.quota) serverState.quota = res.quota;
      if (res?.contextUsage && serverState.activeSession) {
        serverState.activeSession.contextUsage = res.contextUsage;
      }
      renderQuotaUI(serverState);
    }
    showToast(
      res?.quota?.available
        ? res.quota.source === 'codex-live-rpc'
          ? '已同步官方实时配额'
          : '已刷新本地配额快照'
        : '暂未获取到 Codex 配额信息'
    );
  } catch (err) {
    showToast(`刷新失败: ${err.message}`);
  } finally {
    el.btnQuotaRefresh.disabled = false;
    el.btnQuotaRefresh.textContent = '刷新实时配额';
  }
});

el.btnQuotaCompress?.addEventListener('click', () => {
  if (!currentSourceDir && serverState?.activeSession?.sourceDir) {
    currentSourceDir = serverState.activeSession.sourceDir;
  }
  closePopovers();
  openNewTopicModal();
});

el.btnParamsReset.addEventListener('click', () => {
  composerOverrideActive = false;
  const p = getPersonaById(serverState, selectedPersonaId);
  applyPersonaDefaults(p, serverState);
  showToast('已恢复为成员默认参数');
});

el.ctrlModel.addEventListener('change', () => {
  composerOverrideActive = true;
  syncEffortSelect(el.ctrlEffort, el.ctrlModel.value, el.ctrlEffort.value);
  syncWorkstationStatusBars();
});

el.ctrlEffort.addEventListener('change', () => {
  composerOverrideActive = true;
  syncWorkstationStatusBars();
});

el.ctrlFastMode.addEventListener('change', () => {
  composerOverrideActive = true;
  syncWorkstationStatusBars();
});

// Two-stage Global Emergency Trip (click 1 arms for 3s, click 2 trips all running jobs & downgrades Turbo)
el.btnEmergencyTrip.addEventListener('click', async () => {
  const count = (serverState?.runningJobs || []).length;
  if (count <= 0) {
    renderEmergencyTripButton(0);
    return;
  }
  if (!tripArmed) {
    tripArmed = true;
    renderEmergencyTripButton(count);
    clearTimeout(tripResetTimer);
    tripResetTimer = setTimeout(() => {
      tripArmed = false;
      tripResetTimer = null;
      renderEmergencyTripButton((serverState?.runningJobs || []).length);
    }, 3000);
    return;
  }

  clearTimeout(tripResetTimer);
  tripResetTimer = null;
  tripArmed = false;
  el.btnEmergencyTrip.disabled = true;
  try {
    const res = await callAppTool('app_emergency_trip', {
      reason: '用户触发顶栏全局急停熔断',
    });
    let downgradedLocal = false;
    if (composerPerms.fileScope === 'direct') {
      composerOverrideActive = true;
      setPermState('composer', { ...composerPerms, fileScope: 'shadow' });
      downgradedLocal = true;
    }
    const downgraded = Boolean(res?.downgradedGlobalToShadow || downgradedLocal);
    showToast(
      `🛑 已急停 ${res?.abortedCount ?? count} 个任务${downgraded ? '，并自动降级回影子隔离' : ''}`
    );
    await syncState();
  } catch (err) {
    showToast(`急停失败: ${err.message}`);
  } finally {
    el.btnEmergencyTrip.disabled = false;
    renderEmergencyTripButton((serverState?.runningJobs || []).length);
  }
});

document.addEventListener('click', (e) => {
  if (openCustomSelect && !openCustomSelect.contains(e.target)) {
    closeOpenCustomSelect(false);
  }
  if (e.target.closest?.('.cselect-menu')) return;
  if (!el.attachPopover.contains(e.target) && !el.btnAttach.contains(e.target)) {
    el.attachPopover.classList.add('hidden');
  }
  if (!el.paramsPopover.contains(e.target) && !el.btnParamsPop.contains(e.target)) {
    el.paramsPopover.classList.add('hidden');
  }
  if (
    el.quotaPopover &&
    el.btnQuotaPill &&
    !el.quotaPopover.contains(e.target) &&
    !el.btnQuotaPill.contains(e.target)
  ) {
    el.quotaPopover.classList.add('hidden');
    el.btnQuotaPill.setAttribute('aria-expanded', 'false');
  }
});

window.addEventListener(
  'scroll',
  (e) => {
    if (openCustomSelect && !openCustomSelect.menu.contains(e.target)) {
      closeOpenCustomSelect(false);
    }
  },
  true
);

window.addEventListener('resize', () => closeOpenCustomSelect(false));

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (openCustomSelect) {
    closeOpenCustomSelect(true);
  } else if (!el.settingsModal.classList.contains('hidden')) {
    closeSettingsModal();
  } else if (!el.newTopicModal.classList.contains('hidden')) {
    closeNewTopicModal();
  } else if (!el.topicMgrModal.classList.contains('hidden')) {
    closeTopicMgrModal();
  } else if (!el.dirDrawer.classList.contains('hidden')) {
    el.dirDrawer.classList.add('hidden');
  } else {
    closePopovers();
  }
});

// Composer draft input: Enter sends, Shift+Enter newline, Ctrl+V attaches image
el.draftInput.addEventListener('input', scheduleDraftSave);

el.draftInput.addEventListener('paste', (e) => {
  const cd = e.clipboardData;
  if (!cd) return;
  const imgItem = Array.from(cd.items || []).find((it) => it.type?.startsWith('image/'));
  if (imgItem) {
    const blob = imgItem.getAsFile();
    if (blob) {
      e.preventDefault();
      addPendingAttachmentFile(blob);
      return;
    }
  }
  const imgFile = Array.from(cd.files || []).find((f) => f.type?.startsWith('image/'));
  if (imgFile) {
    e.preventDefault();
    addPendingAttachmentFile(imgFile);
  }
});

async function handleSend() {
  const text = el.draftInput.value.trim();
  if (!text && pendingAttachments.length === 0) return;
  if (!currentSourceDir) {
    el.dirDrawer.classList.remove('hidden');
    el.inputSourceDir.focus();
    showToast(
      composerPerms.fileScope === 'direct'
        ? '请先绑定目标文件夹（Turbo 直通将直接在此目录执行）'
        : '请先绑定目标文件夹'
    );
    return;
  }

  closePopovers();
  const persona = getPersonaById(serverState, selectedPersonaId);
  const isApi = persona?.provider === 'openai-compatible';
  const sendSessionId = activeSessionId && activeSessionId !== '__none__' ? activeSessionId : undefined;
  const payloadAtts = pendingAttachments.map((a) => ({
    name: a.name,
    dataUrl: a.dataUrl,
    previewDataUrl: a.previewDataUrl,
  }));

  clearTimeout(draftTimer);
  el.btnSend.disabled = true;
  try {
    const res = await callAppTool('app_boss_send', {
      sourceDir: currentSourceDir,
      prompt: text || '请查看我发送的图片并回复。',
      personaId: selectedPersonaId || undefined,
      sessionId: sendSessionId,
      sandbox: permsToSandboxClient(composerPerms),
      permissions: composerPerms,
      model: isApi ? persona.model : el.ctrlModel.value,
      reasoningEffort: isApi ? undefined : el.ctrlEffort.value,
      fastMode: isApi ? undefined : el.ctrlFastMode.checked,
      attachments: payloadAtts.length > 0 ? payloadAtts : undefined,
    });
    activeSessionId = res.sessionId || activeSessionId;
    el.draftInput.value = '';
    autoResizeTextarea();
    pendingAttachments = [];
    renderAttachStrip();
    syncSendButtonState();
    draftDirty = false;
    draftHydratedKey = activeSessionId;
    el.draftHint.textContent = '';
    lastMsgRenderKey = '';
    await syncState();
  } catch (err) {
    showToast(`发送失败: ${err.message}`);
  } finally {
    el.btnSend.disabled = false;
  }
}

el.btnSend.addEventListener('click', handleSend);

el.draftInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!el.btnSend.classList.contains('hidden')) handleSend();
  }
});

el.btnAbort.addEventListener('click', async () => {
  const jobId = el.btnAbort.dataset.jobId;
  if (!jobId) return;
  el.btnAbort.disabled = true;
  try {
    await callAppTool('app_abort_job', { jobId, reason: '用户在副席面板点击停止' });
    showToast('已中止当前任务（绝不自动重发）');
    await syncState();
  } catch (err) {
    showToast(`中止失败: ${err.message}`);
  } finally {
    el.btnAbort.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// State Sync & Serialized Polling
// ---------------------------------------------------------------------------

async function syncState() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const st = await callAppTool('app_get_state', {
      sessionId: activeSessionId || undefined,
      personaId: selectedPersonaId || undefined,
    });
    serverState = st;

    if (!themeSaveInFlight && st.userProfile?.themeMode) {
      currentThemeMode = st.userProfile.themeMode;
      applyEffectiveTheme();
    }

    const personas = st.personas || [];
    if (!selectedPersonaId || !personas.some((p) => p.id === selectedPersonaId)) {
      selectedPersonaId = st.activeSession?.personaId || personas[0]?.id || '';
    }
    const activePersona = getPersonaById(st, selectedPersonaId);

    const models = st.availableModels || [];
    syncSelect(
      el.ctrlModel,
      (models.length ? models : ['gpt-6.2-sol']).map((m) => ({ value: m, label: m })),
      composerOverrideActive
        ? undefined
        : activePersona?.provider !== 'openai-compatible'
          ? st.activeSession?.model || activePersona?.model || ''
          : undefined
    );
    if (!composerOverrideActive && activePersona) {
      if (activePersona.provider !== 'openai-compatible') {
        syncEffortSelect(
          el.ctrlEffort,
          el.ctrlModel.value || activePersona.model,
          st.activeSession?.reasoningEffort || activePersona.reasoningEffort || 'high'
        );
        el.ctrlFastMode.checked = Boolean(activePersona.fastMode);
      }
      composerPerms = normalizePermsClient(activePersona.permissions, activePersona.defaultSandbox);
      renderPermGroup('composer');
    } else if (activePersona && activePersona.provider !== 'openai-compatible') {
      syncEffortSelect(el.ctrlEffort, el.ctrlModel.value || activePersona.model, el.ctrlEffort.value);
    }

    renderMemberStrip(st);
    syncEngineStatusIndicator(activePersona, st);

    // Scope topic switcher cleanly to the current 1v1 member
    const memberSessions = (st.sessions || []).filter((s) => s.personaId === selectedPersonaId);
    if (!activeSessionId && st.activeSession?.id && st.activeSession.personaId === selectedPersonaId) {
      activeSessionId = st.activeSession.id;
    } else if (
      activeSessionId &&
      activeSessionId !== '__none__' &&
      !st.sessions.some((s) => s.id === activeSessionId)
    ) {
      activeSessionId = memberSessions[0]?.id || '__none__';
    }

    syncSelect(
      el.ctrlSession,
      memberSessions.length
        ? memberSessions.map((s) => ({
            value: s.id,
            label: `${s.title} (${s.contentMessageCount ?? s.messageCount})`,
          }))
        : [{ value: '__none__', label: '新对话（发消息自动建话题）' }],
      activeSessionId === '__none__' ? '__none__' : activeSessionId
    );

    if (!currentSourceDir) {
      currentSourceDir =
        st.activeSession?.sourceDir ||
        st.drafts?.[currentDraftKey()]?.sourceDir ||
        st.recentSourceDirs?.[0] ||
        '';
    }
    if (document.activeElement !== el.inputSourceDir) {
      el.inputSourceDir.value = currentSourceDir;
    }

    const recents = st.recentSourceDirs || [];
    el.recentDirs.innerHTML = recents
      .map(
        (d) =>
          `<button type="button" class="dir-chip" data-pick-dir="${esc(d)}" title="${esc(d)}">${esc(d)}</button>`
      )
      .join('');
    el.recentDirs.querySelectorAll('[data-pick-dir]').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentSourceDir = btn.dataset.pickDir;
        el.inputSourceDir.value = currentSourceDir;
        syncWorkstationStatusBars();
        el.dirDrawer.classList.add('hidden');
        showToast(`已切换文件夹：${pathBasename(currentSourceDir)}`);
      });
    });

    const pendingCount = (st.pendingShadows || []).length;
    el.pendingPill.textContent = String(pendingCount);
    el.pendingPill.classList.toggle('has-pending', pendingCount > 0);

    hydrateDraftFromState(st);
    renderStationView(st);
    if (currentView === 'review') {
      renderReviewView(st, false);
    }
    if (!el.topicMgrModal.classList.contains('hidden')) {
      renderTopicManagerList();
    }
  } catch (err) {
    if (err?.name !== 'AbortError') {
      el.statusDot.className = 'dot err';
      el.statusText.textContent = '重连';
    }
  } finally {
    pollInFlight = false;
    scheduleNextPoll();
  }
}

function scheduleNextPoll() {
  clearTimeout(pollTimer);
  const hasRunning = (serverState?.runningJobs || []).length > 0;
  const delay = document.hidden ? 6000 : hasRunning ? 1200 : 4000;
  pollTimer = setTimeout(syncState, delay);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) syncState();
});

// ---------------------------------------------------------------------------
// MCP Apps SDK Bootstrap (register ALL handlers BEFORE connect())
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Theme Resolution & Persistence (Manual light/dark NEVER overridden by host)
// ---------------------------------------------------------------------------

function resolveEffectiveTheme() {
  if (currentThemeMode === 'light' || currentThemeMode === 'dark') return currentThemeMode;
  return hostTheme === 'dark' ? 'dark' : 'light';
}

function syncThemeToggleUI(effective) {
  const isDark = effective === 'dark';
  if (el.btnThemeToggle) {
    el.btnThemeToggle.querySelector('.icon-moon')?.classList.toggle('hidden', isDark);
    el.btnThemeToggle.querySelector('.icon-sun')?.classList.toggle('hidden', !isDark);
    const modeNote =
      currentThemeMode === 'auto'
        ? `跟随宿主(${isDark ? '深色' : '浅色'})`
        : isDark
          ? '深色（暖炭）'
          : '浅色（羊皮纸）';
    el.btnThemeToggle.title = `当前：${modeNote} · 点击切换至${isDark ? '浅色' : '深色'}`;
  }
  el.upThemeSeg?.querySelectorAll('[data-theme-val]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.themeVal === currentThemeMode);
  });
}

function applyEffectiveTheme() {
  const effective = resolveEffectiveTheme();
  applyDocumentTheme(effective);
  document.documentElement.setAttribute('data-theme', effective);
  syncThemeToggleUI(effective);
}

async function setThemeModeAndPersist(nextMode, silent = false) {
  if (nextMode !== 'auto' && nextMode !== 'light' && nextMode !== 'dark') return;
  currentThemeMode = nextMode;
  applyEffectiveTheme();
  if (serverState?.userProfile) {
    serverState.userProfile.themeMode = nextMode;
  }
  themeSaveInFlight = true;
  try {
    await callAppTool('app_set_theme', { themeMode: nextMode });
    if (!silent) {
      const label =
        nextMode === 'auto'
          ? `已设为跟随宿主（当前${resolveEffectiveTheme() === 'dark' ? '深色' : '浅色'}）`
          : nextMode === 'dark'
            ? '已切至深色主题（暖炭）'
            : '已切至浅色主题（羊皮纸）';
      showToast(label);
    }
  } catch (err) {
    showToast(`保存主题失败: ${err.message}`);
  } finally {
    themeSaveInFlight = false;
  }
}

function applyHostCtx(ctx) {
  if (!ctx) return;
  if (ctx.theme === 'dark' || ctx.theme === 'light') {
    hostTheme = ctx.theme;
  }
  if (currentThemeMode === 'auto') {
    applyEffectiveTheme();
  } else {
    syncThemeToggleUI(resolveEffectiveTheme());
  }
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
}

app.onhostcontextchanged = (ctx) => applyHostCtx(ctx);

app.ontoolinput = ({ arguments: args } = {}) => {
  if (args?.sessionId) {
    activeSessionId = args.sessionId;
    draftHydratedKey = '';
  }
  if (args?.sourceDir) {
    currentSourceDir = args.sourceDir;
    syncWorkstationStatusBars();
  }
};

app.ontoolresult = (result) => {
  const sc = result?.structuredContent;
  if (sc?.sessionId) {
    activeSessionId = sc.sessionId;
    draftHydratedKey = '';
  } else if (sc?.activeSessionId) {
    activeSessionId = sc.activeSessionId;
  }
  syncState();
};

async function boot() {
  try {
    await app.connect();
    const caps = app.getHostCapabilities() || {};
    hostCaps.message = Boolean(caps.message);
    hostCaps.updateModelContext = Boolean(caps.updateModelContext);
    applyHostCtx(app.getHostContext());
    await syncState();
  } catch (err) {
    el.statusDot.className = 'dot err';
    el.statusText.textContent = '失败';
    showToast(`初始化失败: ${err.message}`);
  }
}

initAllCustomSelects();
boot();
