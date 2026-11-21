import { spawn, spawnSync } from 'node:child_process';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_TAIL_BYTES = 128 * 1024;
export const FALLBACK_TAIL_BYTES = 512 * 1024;
const HEAD_META_BYTES = 8 * 1024;
const MAX_QUOTA_SCAN_FILES = 16;
const MAX_THREAD_SCAN_FILES = 160;
const MAX_META_FALLBACK_FILES = 24;

export function getDefaultCodexSessionsDir() {
  return join(homedir(), '.codex', 'sessions');
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function toFiniteNonNeg(val) {
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function normalizeRateWindow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rawUsed = Number(raw.used_percent ?? raw.usedPercent);
  if (!Number.isFinite(rawUsed)) return null;
  const usedPercent = clamp(round1(rawUsed), 0, 100);
  const remainingPercent = clamp(round1(100 - usedPercent), 0, 100);
  const windowMinutes = toFiniteNonNeg(raw.window_minutes ?? raw.windowDurationMins);
  const rawReset = Number(raw.resets_at ?? raw.resetsAt);
  const resetsAt = Number.isFinite(rawReset) && rawReset > 0 ? Math.floor(rawReset) : null;
  return {
    usedPercent,
    remainingPercent,
    windowMinutes,
    resetsAt,
  };
}

export function normalizeRateLimits(rawRl, snapshotAt = null, scannedAt = Date.now(), source = 'codex-sessions') {
  if (!rawRl || typeof rawRl !== 'object') {
    return makeUnavailableQuota(scannedAt);
  }
  const primary = normalizeRateWindow(rawRl.primary);
  const secondary = normalizeRateWindow(rawRl.secondary);
  if (!primary && !secondary) {
    return makeUnavailableQuota(scannedAt);
  }
  const rawPlan = rawRl.plan_type ?? rawRl.planType;
  const planType =
    typeof rawPlan === 'string' && rawPlan.trim()
      ? rawPlan.trim()
      : null;
  const credits =
    rawRl.credits && typeof rawRl.credits === 'object'
      ? {
          hasCredits: Boolean(rawRl.credits.has_credits ?? rawRl.credits.hasCredits),
          unlimited: Boolean(rawRl.credits.unlimited),
          balance: rawRl.credits.balance != null ? String(rawRl.credits.balance) : '0',
        }
      : null;
  const rawLimitId = rawRl.limit_id ?? rawRl.limitId;

  return {
    available: true,
    source,
    limitId: typeof rawLimitId === 'string' && rawLimitId.trim() ? rawLimitId.trim() : 'codex',
    planType,
    primary,
    secondary,
    credits,
    snapshotAt: Number.isFinite(Number(snapshotAt)) ? Number(snapshotAt) : null,
    scannedAt,
  };
}

export function makeUnavailableQuota(scannedAt = Date.now()) {
  return {
    available: false,
    source: 'codex-sessions',
    limitId: null,
    planType: null,
    primary: null,
    secondary: null,
    credits: null,
    snapshotAt: null,
    scannedAt,
  };
}

export function normalizeCodexContextUsage(rawInfo, snapshotAt = null) {
  if (!rawInfo || typeof rawInfo !== 'object') return null;
  const usage =
    (rawInfo.last_token_usage && typeof rawInfo.last_token_usage === 'object'
      ? rawInfo.last_token_usage
      : null) ||
    (rawInfo.total_token_usage && typeof rawInfo.total_token_usage === 'object'
      ? rawInfo.total_token_usage
      : null);
  if (!usage) return null;

  const inputTokens = Math.round(toFiniteNonNeg(usage.input_tokens));
  const cachedTokens = Math.round(toFiniteNonNeg(usage.cached_input_tokens));
  const outputTokens = Math.round(toFiniteNonNeg(usage.output_tokens));
  const reasoningTokens = Math.round(toFiniteNonNeg(usage.reasoning_output_tokens));
  const rawTotal = Math.round(toFiniteNonNeg(usage.total_tokens));
  const usedTokens = rawTotal > 0 ? rawTotal : inputTokens + outputTokens;
  const maxTokens = Math.round(toFiniteNonNeg(rawInfo.model_context_window));
  const usedPercent =
    maxTokens > 0 ? clamp(round1((usedTokens / maxTokens) * 100), 0, 100) : 0;

  return {
    usedTokens,
    inputTokens,
    outputTokens,
    cachedTokens,
    reasoningTokens,
    maxTokens,
    usedPercent,
    source: 'codex-jsonl',
    updatedAt: Number.isFinite(Number(snapshotAt)) ? Number(snapshotAt) : Date.now(),
  };
}

/**
 * Reads only the trailing `maxBytes` slice of a file asynchronously.
 * Drops the leading partial line when reading mid-file so every returned line is complete.
 */
export async function readTailTextAsync(filePath, maxBytes = DEFAULT_TAIL_BYTES) {
  let fh;
  try {
    fh = await open(filePath, 'r');
    const st = await fh.stat();
    const size = st.size || 0;
    if (size === 0) return { text: '', mtimeMs: st.mtimeMs, size: 0, truncated: false };

    const readLen = Math.min(size, maxBytes);
    const startOffset = size - readLen;
    const buf = Buffer.allocUnsafe(readLen);
    const { bytesRead } = await fh.read(buf, 0, readLen, startOffset);
    let text = buf.subarray(0, bytesRead).toString('utf8');
    const truncated = startOffset > 0;
    if (truncated) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return { text, mtimeMs: st.mtimeMs, size, truncated };
  } catch {
    return null;
  } finally {
    if (fh) {
      try {
        await fh.close();
      } catch {
        // ignore close error
      }
    }
  }
}

async function readHeadTextAsync(filePath, maxBytes = HEAD_META_BYTES) {
  let fh;
  try {
    fh = await open(filePath, 'r');
    const st = await fh.stat();
    const readLen = Math.min(st.size || 0, maxBytes);
    if (readLen === 0) return '';
    const buf = Buffer.allocUnsafe(readLen);
    const { bytesRead } = await fh.read(buf, 0, readLen, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fh) {
      try {
        await fh.close();
      } catch {
        // ignore
      }
    }
  }
}

function parseTimestampMs(rawTs, fallbackMs = null) {
  if (typeof rawTs === 'string' && rawTs.trim()) {
    const parsed = Date.parse(rawTs);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof rawTs === 'number' && Number.isFinite(rawTs)) {
    return rawTs > 1e12 ? rawTs : rawTs * 1000;
  }
  return fallbackMs;
}

/**
 * Parses lines in reverse to extract the latest Codex `rate_limits` and `info` token_count records.
 * Prefers `limit_id === "codex"` when multiple rate_limit buckets exist.
 */
export function parseTokenCountFromJsonlText(text, fallbackTsMs = null) {
  if (!text || typeof text !== 'string') {
    return { rateLimits: null, rateLimitsTs: null, contextUsage: null, contextTs: null };
  }
  const lines = text.split(/\r?\n/);
  let preferredRl = null;
  let preferredRlTs = null;
  let fallbackRl = null;
  let fallbackRlTs = null;
  let contextUsage = null;
  let contextTs = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || !line.includes('token_count')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = obj?.payload;
    if (!payload || payload.type !== 'token_count') continue;
    const evTs = parseTimestampMs(obj.timestamp, fallbackTsMs);

    if (!contextUsage && payload.info && typeof payload.info === 'object') {
      const parsedCtx = normalizeCodexContextUsage(payload.info, evTs);
      if (parsedCtx) {
        contextUsage = parsedCtx;
        contextTs = evTs;
      }
    }

    if (!preferredRl && payload.rate_limits && typeof payload.rate_limits === 'object') {
      const rl = payload.rate_limits;
      if (rl.primary || rl.secondary) {
        if (!rl.limit_id || rl.limit_id === 'codex') {
          preferredRl = rl;
          preferredRlTs = evTs;
        } else if (!fallbackRl) {
          fallbackRl = rl;
          fallbackRlTs = evTs;
        }
      }
    }

    if (preferredRl && contextUsage) break;
  }

  return {
    rateLimits: preferredRl || fallbackRl,
    rateLimitsTs: preferredRl ? preferredRlTs : fallbackRlTs,
    contextUsage,
    contextTs,
  };
}

/**
 * Walks `sessions/YYYY/MM/DD/*.jsonl` (and any flat `.jsonl` files) newest-date-first,
 * returning up to `limit` files sorted by mtime descending.
 */
async function listRecentJsonlFilesAsync(sessionsDir, limit = MAX_QUOTA_SCAN_FILES) {
  const results = [];

  async function walkNewestFirst(dir, depth) {
    if (results.length >= limit * 2 || depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const subdirs = [];
    const jsonlFiles = [];
    for (const ent of entries) {
      if (ent.isDirectory()) {
        subdirs.push(ent.name);
      } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        jsonlFiles.push(ent.name);
      }
    }

    // Stat files in this directory
    if (jsonlFiles.length > 0) {
      const statResults = await Promise.all(
        jsonlFiles.map(async (name) => {
          const full = join(dir, name);
          try {
            const st = await stat(full);
            return { path: full, name, mtimeMs: st.mtimeMs, size: st.size };
          } catch {
            return null;
          }
        })
      );
      for (const item of statResults) {
        if (item) results.push(item);
      }
    }

    // Traverse date subdirectories descending (2026 -> 11 -> 22)
    subdirs.sort((a, b) => b.localeCompare(a));
    for (const sub of subdirs) {
      if (results.length >= limit * 2) break;
      await walkNewestFirst(join(dir, sub), depth + 1);
    }
  }

  await walkNewestFirst(sessionsDir, 0);
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results.slice(0, limit);
}

/**
 * Finds the `.jsonl` file corresponding to a specific `codexThreadId`.
 * Pass 1: fast filename match (`...-<threadId>.jsonl` or contains `<threadId>`).
 * Pass 2: fallback inspection of first-line `session_meta` across recent files.
 */
async function findThreadJsonlFileAsync(sessionsDir, threadId) {
  const cleanId = String(threadId || '').trim();
  if (!cleanId) return null;

  const recent = await listRecentJsonlFilesAsync(sessionsDir, MAX_THREAD_SCAN_FILES);
  const lowerId = cleanId.toLowerCase();

  for (const f of recent) {
    if (f.name.toLowerCase().includes(lowerId)) {
      return f.path;
    }
  }

  // Fallback: inspect `session_meta` line in recent files
  for (const f of recent.slice(0, MAX_META_FALLBACK_FILES)) {
    const head = await readHeadTextAsync(f.path, HEAD_META_BYTES);
    if (!head) continue;
    const firstLine = head.split(/\r?\n/, 1)[0]?.trim();
    if (!firstLine) continue;
    try {
      const obj = JSON.parse(firstLine);
      const p = obj?.payload;
      if (obj?.type === 'session_meta' && (p?.id === cleanId || p?.session_id === cleanId)) {
        return f.path;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

async function readParsedTailWithFallback(filePath, tailBytes = DEFAULT_TAIL_BYTES) {
  const first = await readTailTextAsync(filePath, tailBytes);
  if (!first) return null;
  let parsed = parseTokenCountFromJsonlText(first.text, first.mtimeMs);
  if (first.truncated && !parsed.rateLimits && !parsed.contextUsage && tailBytes < FALLBACK_TAIL_BYTES) {
    const wider = await readTailTextAsync(filePath, FALLBACK_TAIL_BYTES);
    if (wider) {
      parsed = parseTokenCountFromJsonlText(wider.text, wider.mtimeMs);
      return { ...parsed, mtimeMs: wider.mtimeMs, size: wider.size };
    }
  }
  return { ...parsed, mtimeMs: first.mtimeMs, size: first.size };
}

export function fetchLiveRateLimitsFromAppServerAsync(codexBinPath, timeoutMs = 8000) {
  return new Promise((resolvePromise) => {
    if (!codexBinPath) {
      resolvePromise(null);
      return;
    }
    let child = null;
    let settled = false;
    let initAcked = false;
    let buf = '';

    const cleanupChild = () => {
      if (!child) return;
      const pid = child.pid;
      try {
        child.stdin?.end();
      } catch {
        // ignore
      }
      if (process.platform === 'win32' && pid) {
        try {
          spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
            windowsHide: true,
            timeout: 2000,
          });
        } catch {
          // ignore
        }
      }
      try {
        if (!child.killed) child.kill('SIGKILL');
      } catch {
        // ignore
      }
      child = null;
    };

    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupChild();
      resolvePromise(val);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    try {
      child = spawn(codexBinPath, ['-c', 'mcp_servers={}', 'app-server'], {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      finish(null);
      return;
    }

    child.on('error', () => finish(null));
    child.on('close', () => finish(null));

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg?.id === 1 && !initAcked) {
          initAcked = true;
          try {
            child.stdin.write(
              JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) +
                '\n' +
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: 2,
                  method: 'account/rateLimits/read',
                  params: {},
                }) +
                '\n'
            );
          } catch {
            finish(null);
          }
        } else if (msg?.id === 2) {
          const res = msg.result;
          const rl = res?.rateLimitsByLimitId?.codex || res?.rateLimits || null;
          const now = Date.now();
          const normalized = rl ? normalizeRateLimits(rl, now, now, 'codex-live-rpc') : null;
          finish(normalized?.available ? normalized : null);
          return;
        }
      }
    });

    try {
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { clientInfo: { name: 'sidedesk', version: '0.1.0' } },
        }) + '\n'
      );
    } catch {
      finish(null);
    }
  });
}

export class CodexQuotaReader {
  constructor({
    sessionsDir = '',
    quotaTtlMs = 15_000,
    liveTtlMs = 180_000,
    threadTtlMs = 8_000,
    tailBytes = DEFAULT_TAIL_BYTES,
    getCodexBinPath = null,
  } = {}) {
    this.sessionsDir = sessionsDir || getDefaultCodexSessionsDir();
    this.quotaTtlMs = quotaTtlMs;
    this.liveTtlMs = liveTtlMs;
    this.threadTtlMs = threadTtlMs;
    this.tailBytes = tailBytes;
    this._binResolver = typeof getCodexBinPath === 'function' ? getCodexBinPath : null;

    this._quotaCache = null;
    this._quotaFetchedAt = 0;
    this._lastLiveAt = 0;
    this._quotaPromise = null;

    this._threadFileCache = new Map(); // threadId -> filePath
    this._threadUsageCache = new Map(); // threadId -> { filePath, mtimeMs, size, checkedAt, contextUsage }
    this._threadPending = new Map(); // threadId -> Promise
  }

  setCodexBinResolver(fn) {
    this._binResolver = typeof fn === 'function' ? fn : null;
  }

  getQuotaFast() {
    if (this._quotaCache) {
      if (Date.now() - this._quotaFetchedAt > this.quotaTtlMs && !this._quotaPromise) {
        this.getQuota({ force: true }).catch(() => {});
      }
      return this._quotaCache;
    }
    if (!this._quotaPromise) {
      this.getQuota({ force: true }).catch(() => {});
    }
    return makeUnavailableQuota(Date.now());
  }

  async getQuota({ force = false, forceLive = false } = {}) {
    const now = Date.now();
    if (!force && !forceLive && this._quotaCache && now - this._quotaFetchedAt < this.quotaTtlMs) {
      return this._quotaCache;
    }
    if (this._quotaPromise && !force && !forceLive) {
      return this._quotaPromise;
    }

    const run = (async () => {
      try {
        // 1. Live 0-token OpenAI server query via `codex app-server -> account/rateLimits/read`
        //    Triggered on initial load, every `liveTtlMs` (3m), or whenever user clicks Refresh (`forceLive`).
        const shouldQueryLive =
          Boolean(this._binResolver) &&
          (forceLive || !this._lastLiveAt || Date.now() - this._lastLiveAt >= this.liveTtlMs);
        if (shouldQueryLive) {
          try {
            const binPath = await this._binResolver();
            if (binPath) {
              const liveQuota = await fetchLiveRateLimitsFromAppServerAsync(binPath);
              if (liveQuota?.available) {
                this._quotaCache = liveQuota;
                this._quotaFetchedAt = Date.now();
                this._lastLiveAt = Date.now();
                return liveQuota;
              }
            }
          } catch {
            // Fall through to local .jsonl snapshot on offline / RPC failure
          }
        }

        // If we already have a fresh live RPC snapshot and weren't forcing live, check if any local .jsonl is newer
        const files = await listRecentJsonlFilesAsync(this.sessionsDir, MAX_QUOTA_SCAN_FILES);
        const scannedAt = Date.now();
        for (const f of files) {
          const parsed = await readParsedTailWithFallback(f.path, this.tailBytes);
          if (parsed?.rateLimits) {
            const normalized = normalizeRateLimits(parsed.rateLimits, parsed.rateLimitsTs, scannedAt);
            if (normalized.available) {
              if (
                this._quotaCache?.available &&
                this._quotaCache.source === 'codex-live-rpc' &&
                (this._quotaCache.snapshotAt || 0) > (normalized.snapshotAt || 0)
              ) {
                this._quotaFetchedAt = scannedAt;
                return this._quotaCache;
              }
              this._quotaCache = normalized;
              this._quotaFetchedAt = scannedAt;
              return normalized;
            }
          }
        }
        if (this._quotaCache?.available) {
          this._quotaFetchedAt = scannedAt;
          return this._quotaCache;
        }
        const empty = makeUnavailableQuota(scannedAt);
        this._quotaCache = empty;
        this._quotaFetchedAt = scannedAt;
        return empty;
      } catch {
        if (this._quotaCache?.available) return this._quotaCache;
        const empty = makeUnavailableQuota(Date.now());
        this._quotaCache = empty;
        this._quotaFetchedAt = Date.now();
        return empty;
      }
    })();

    this._quotaPromise = run;
    try {
      return await run;
    } finally {
      if (this._quotaPromise === run) {
        this._quotaPromise = null;
      }
    }
  }

  async getThreadContextUsage(threadId, { force = false } = {}) {
    const cleanId = String(threadId || '').trim();
    if (!cleanId) return null;

    const cached = this._threadUsageCache.get(cleanId);
    const now = Date.now();
    if (!force && cached && now - cached.checkedAt < this.threadTtlMs) {
      return cached.contextUsage;
    }

    const existingPromise = this._threadPending.get(cleanId);
    if (existingPromise && !force) {
      return existingPromise;
    }

    const run = (async () => {
      try {
        let filePath = this._threadFileCache.get(cleanId) || '';
        let fileStat = null;
        if (filePath) {
          try {
            fileStat = await stat(filePath);
          } catch {
            this._threadFileCache.delete(cleanId);
            filePath = '';
          }
        }

        if (!filePath) {
          filePath = (await findThreadJsonlFileAsync(this.sessionsDir, cleanId)) || '';
          if (!filePath) {
            return cached?.contextUsage || null;
          }
          this._threadFileCache.set(cleanId, filePath);
          try {
            fileStat = await stat(filePath);
          } catch {
            return cached?.contextUsage || null;
          }
        }

        // Fast skip if file mtime + size are unchanged since last parse
        if (
          cached &&
          cached.filePath === filePath &&
          fileStat &&
          cached.mtimeMs === fileStat.mtimeMs &&
          cached.size === fileStat.size
        ) {
          cached.checkedAt = Date.now();
          return cached.contextUsage;
        }

        const parsed = await readParsedTailWithFallback(filePath, this.tailBytes);
        const contextUsage = parsed?.contextUsage || null;
        this._threadUsageCache.set(cleanId, {
          filePath,
          mtimeMs: parsed?.mtimeMs ?? fileStat?.mtimeMs ?? 0,
          size: parsed?.size ?? fileStat?.size ?? 0,
          checkedAt: Date.now(),
          contextUsage,
        });

        // Opportunistically update global quota cache if this file has a newer rate_limits snapshot
        if (parsed?.rateLimits) {
          const normalized = normalizeRateLimits(parsed.rateLimits, parsed.rateLimitsTs, Date.now());
          if (
            normalized.available &&
            (!this._quotaCache?.available ||
              (normalized.snapshotAt || 0) >= (this._quotaCache.snapshotAt || 0))
          ) {
            this._quotaCache = normalized;
            this._quotaFetchedAt = Date.now();
          }
        }

        // Keep map bounded
        if (this._threadUsageCache.size > 120) {
          const oldestKey = this._threadUsageCache.keys().next().value;
          if (oldestKey) {
            this._threadUsageCache.delete(oldestKey);
            this._threadFileCache.delete(oldestKey);
          }
        }

        return contextUsage;
      } catch {
        return cached?.contextUsage || null;
      }
    })();

    this._threadPending.set(cleanId, run);
    try {
      return await run;
    } finally {
      if (this._threadPending.get(cleanId) === run) {
        this._threadPending.delete(cleanId);
      }
    }
  }

  async refreshAll({ threadId = '', forceLive = true } = {}) {
    const [quota, contextUsage] = await Promise.all([
      this.getQuota({ force: true, forceLive }),
      threadId ? this.getThreadContextUsage(threadId, { force: true }) : Promise.resolve(null),
    ]);
    return { quota, contextUsage };
  }
}
