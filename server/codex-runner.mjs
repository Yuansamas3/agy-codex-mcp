import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  composeOutboundUserPayload,
  composePersonaProfileBlock,
  composeTurnGuidanceHeader,
  evaluateAnchorSync,
} from './prompt-composer.mjs';
import { atomicWriteFileSync, redactSecrets } from './security.mjs';
import {
  computeShadowDiff,
  createShadowCopyAsync,
  inspectDirectGitStatus,
  verifySourceUntouched,
} from './shadow-engine.mjs';
import {
  normalizePermissions,
  permissionsFromSandbox,
  permissionsToSandbox,
  readCodexUserDefaults,
  VALID_SANDBOXES,
} from './store.mjs';

const execFileAsync = promisify(execFile);

export const DEFAULT_COLD_START_TIMEOUT_MS = 45_000;

export const ANTI_ESCAPE_GUARDRAIL = [
  '【绝对工作目录与安全红线】',
  '1. 你当前运行在隔离的影子副本工作目录中。严禁读写、修改、删除或触碰当前工作目录（.）以外的任何外部绝对路径（包括原工程目录、用户主目录、桌面、系统盘或其他盘符路径）。',
  '2. 一切文件读写、搜索和命令执行（包括 PowerShell / Python / Node 脚本）必须严格限制在当前相对工作目录内。',
  '3. 严禁访问上级目录（..）或尝试修改外部任何配置文件与源码目录。',
].join('\n');

export function buildDirectModeInstructions(absSourceDir) {
  return [
    '【Turbo 直通模式说明】',
    `你当前直接在真实工程目录（${absSourceDir}）下执行，无影子副本隔离与沙箱限制。`,
    '允许按任务需要直接读写当前工程文件、读取外部参考路径，以及调用本机 Python / Node / Git / 编译器等工具链运行测试与脚本。',
    '修改原工程文件前请保持克制精准，改完后务必核查验证。',
  ].join('\n');
}

export function buildUserProfileInstruction(userProfile) {
  const name = typeof userProfile?.userName === 'string' ? userProfile.userName.trim() : '';
  if (!name || name === '我') return '';
  return `用户的名字/称呼是「${name}」，请在交流中自然地这样称呼用户。`;
}

export function buildInheritedSummaryInstruction(inheritedSummary) {
  const summary = typeof inheritedSummary?.summary === 'string' ? inheritedSummary.summary.trim() : '';
  if (!summary) return '';
  const srcTitle = String(inheritedSummary?.sourceTitle || '上一话题').trim();
  return [
    `【延续自话题「${srcTitle}」的压缩上下文摘要】`,
    summary,
    '（以上为前序话题的浓缩上下文，请在此基础上直接衔接交流，无需让用户从头讲起。）',
  ].join('\n');
}

function toTomlBasicString(text) {
  return JSON.stringify(String(text || ''));
}

export function buildDeveloperInstructions(
  persona,
  { isDirect = false, absSourceDir = '', permissions = null, userProfile = null, inheritedSummary = null } = {}
) {
  const effectivePerms = normalizePermissions(
    permissions,
    isDirect ? 'turbo-direct' : 'workspace-write'
  );
  const direct = Boolean(isDirect || effectivePerms.fileScope === 'direct');
  const parts = [];

  // Security & workspace rules + structured 5-part persona profile block
  if (direct) {
    parts.push(buildDirectModeInstructions(absSourceDir || '.'));
  } else {
    parts.push(ANTI_ESCAPE_GUARDRAIL);
  }
  if (effectivePerms.commandPolicy === 'disabled') {
    parts.push('【命令执行策略】当前已设为禁止执行 Shell/终端命令，请勿调用任何命令行工具。');
  }
  if (direct && effectivePerms.networkPolicy === 'deny') {
    parts.push('【联网策略】当前已设为禁止联网，请仅使用本地工作区文件与已有知识完成任务。');
  }

  parts.push(composePersonaProfileBlock(persona, userProfile));

  const inheritedInst = buildInheritedSummaryInstruction(inheritedSummary);
  if (inheritedInst) parts.push(inheritedInst);

  return parts.join('\n\n');
}

export function buildCodexArgs({
  isDirect = false,
  isResume = false,
  sandbox = 'workspace-write',
  permissions = null,
  workDir,
  effectiveModel = '',
  effectiveEffort = 'high',
  fastMode = false,
  cleanCodexConfig = true,
  windowsSandbox = '',
  devInst = '',
  validImages = [],
  lastMsgFile,
  codexThreadId = '',
}) {
  const effectivePerms = normalizePermissions(
    permissions,
    isDirect ? 'turbo-direct' : sandbox
  );
  const direct = Boolean(isDirect || effectivePerms.fileScope === 'direct');
  const resolvedSandbox = permissionsToSandbox(effectivePerms);

  const commonFlags = ['--skip-git-repo-check', '--json'];
  if (cleanCodexConfig !== false) {
    commonFlags.push('--ignore-user-config');
    if (process.platform === 'win32' && !direct && windowsSandbox) {
      commonFlags.push('-c', `windows.sandbox="${windowsSandbox}"`);
    }
  }
  if (direct) {
    commonFlags.push(
      '--dangerously-bypass-approvals-and-sandbox',
      '-c',
      'shell_environment_policy.inherit="all"'
    );
  } else {
    commonFlags.push('-c', 'approval_policy="never"');
    if (effectivePerms.fileScope === 'shadow') {
      commonFlags.push(
        '-c',
        `sandbox_workspace_write.network_access=${effectivePerms.networkPolicy === 'allow' ? 'true' : 'false'}`
      );
    }
  }
  if (effectivePerms.commandPolicy === 'disabled') {
    commonFlags.push(
      '-c',
      'features.shell_tool=false',
      '-c',
      'features.unified_exec=false'
    );
  }
  if (fastMode === true) {
    commonFlags.push('-c', 'service_tier="fast"');
  } else {
    commonFlags.push('-c', 'service_tier="default"');
  }
  commonFlags.push(
    '-c',
    `model_reasoning_effort="${effectiveEffort}"`,
    '-c',
    `developer_instructions=${toTomlBasicString(devInst)}`,
    '-o',
    lastMsgFile
  );
  if (effectiveModel) commonFlags.push('-m', effectiveModel);
  for (const img of validImages) commonFlags.push('-i', img);

  if (isResume && codexThreadId) {
    if (direct) {
      return ['exec', 'resume', '--all', ...commonFlags, codexThreadId, '-'];
    }
    return [
      'exec',
      'resume',
      ...commonFlags,
      '-c',
      `sandbox_mode="${resolvedSandbox}"`,
      codexThreadId,
      '-',
    ];
  }

  if (direct) {
    return ['exec', '-C', workDir, ...commonFlags, '-'];
  }
  return ['exec', '-s', resolvedSandbox, '-C', workDir, ...commonFlags, '-'];
}

export class CodexRunner {
  constructor(store, quotaReader = null) {
    this.store = store;
    this.quotaReader = quotaReader;
    this.runningJobs = new Map(); // jobId -> { controller, child, pid, lastMsgFile, coldStartTimer }
    this.waiters = new Map(); // jobId -> Set<resolveFn>
    this.cacheFile = join(store.dataDir, 'codex-cache.json');
    this._binCache = this._loadDiskCache();
    this._probePromise = null;

    // Non-blocking startup warm-up only if cache is missing or cached binary path disappeared
    if (!this._binCache.path || !existsSync(this._binCache.path)) {
      this.refreshCodexBinaryAsync().catch(() => {});
    }
  }

  _loadDiskCache() {
    try {
      if (existsSync(this.cacheFile)) {
        const raw = JSON.parse(readFileSync(this.cacheFile, 'utf8'));
        // Require non-empty `version` so broken/ACL-locked WindowsApps paths are re-probed cleanly
        if (raw?.path && raw?.version && existsSync(raw.path)) {
          return {
            path: String(raw.path),
            version: String(raw.version),
            detectedAt: Number(raw.detectedAt) || Date.now(),
          };
        }
      }
    } catch {
      // ignore corrupt cache
    }
    return { path: null, version: null, detectedAt: 0 };
  }

  _saveDiskCache(info) {
    try {
      atomicWriteFileSync(this.cacheFile, JSON.stringify(info, null, 2));
    } catch {
      // ignore
    }
  }

  /**
   * Strictly 0ms non-blocking lookup for hot paths (app_get_state / sidedesk_open / list_personas).
   * NEVER spawns PowerShell or codex --version synchronously!
   */
  getCodexBinaryFast() {
    if (this._binCache.path && existsSync(this._binCache.path)) {
      return {
        path: this._binCache.path,
        version: this._binCache.version,
        checking: Boolean(this._probePromise),
      };
    }
    // Cached path vanished (e.g. Store app auto-updated) -> kick off async probe in background
    if (!this._probePromise) {
      this.refreshCodexBinaryAsync().catch(() => {});
    }
    return {
      path: null,
      version: null,
      checking: Boolean(this._probePromise),
    };
  }

  async _probeBinaryVersion(binPath) {
    try {
      const { stdout } = await execFileAsync(binPath, ['--version'], {
        encoding: 'utf8',
        timeout: 5_000,
        windowsHide: true,
      });
      return (stdout || '').trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Async non-blocking cross-platform probe (deduplicated for auto-probe).
   * Supports optional `customPath` override (if provided, validates and probes it first).
   */
  async refreshCodexBinaryAsync(customPath = '') {
    const cleanedCustom = String(customPath || '').trim();
    if (cleanedCustom) {
      if (existsSync(cleanedCustom) && statSync(cleanedCustom).isFile()) {
        const version = await this._probeBinaryVersion(cleanedCustom);
        return { path: cleanedCustom, version, detectedAt: Date.now(), custom: true };
      }
      return { path: null, version: null, detectedAt: Date.now(), custom: true };
    }

    if (this._probePromise) return this._probePromise;
    this._probePromise = (async () => {
      const candidates = [];
      const pushCandidate = (p) => {
        const s = String(p || '').trim();
        if (s && !candidates.includes(s) && existsSync(s)) {
          candidates.push(s);
        }
      };

      if (process.platform === 'win32') {
        const addNpmVendorCandidatesFromPrefix = (prefixDir) => {
          if (!prefixDir) return;
          const pkgRoot = join(prefixDir, 'node_modules', '@openai', 'codex');
          const triples = ['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc'];
          for (const t of triples) {
            pushCandidate(join(pkgRoot, 'vendor', t, 'codex', 'codex.exe'));
            // Newer @openai/codex optional platform subpackages
            pushCandidate(
              join(prefixDir, 'node_modules', '@openai', `codex-win32-${t.startsWith('aarch64') ? 'arm64' : 'x64'}`, 'vendor', t, 'codex', 'codex.exe')
            );
            pushCandidate(
              join(pkgRoot, 'node_modules', '@openai', `codex-win32-${t.startsWith('aarch64') ? 'arm64' : 'x64'}`, 'vendor', t, 'codex', 'codex.exe')
            );
          }
        };

        // 1. Prefer standalone CLI (`npm i -g @openai/codex` native vendor binary or direct codex.exe on PATH)
        try {
          const { stdout } = await execFileAsync('where.exe', ['codex'], {
            encoding: 'utf8',
            timeout: 4_000,
            windowsHide: true,
          });
          const lines = (stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
          for (const hit of lines) {
            if (/\.exe$/i.test(hit)) {
              pushCandidate(hit);
            } else {
              addNpmVendorCandidatesFromPrefix(dirname(hit));
            }
          }
        } catch {
          // ignore
        }

        const appData = process.env.APPDATA || '';
        const localAppData = process.env.LOCALAPPDATA || '';
        addNpmVendorCandidatesFromPrefix(dirname(process.execPath));
        if (appData) {
          addNpmVendorCandidatesFromPrefix(join(appData, 'npm'));
          pushCandidate(join(appData, 'npm', 'codex.exe'));
        }
        if (localAppData) {
          pushCandidate(join(localAppData, 'Programs', 'codex', 'codex.exe'));
        }

        // 2. Microsoft Store `OpenAI.Codex` package (`WindowsApps\...\codex.exe`)
        try {
          const { stdout } = await execFileAsync(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              '(Get-AppxPackage OpenAI.Codex | Select-Object -First 1).InstallLocation',
            ],
            { encoding: 'utf8', timeout: 10_000, windowsHide: true }
          );
          const loc = (stdout || '').trim();
          if (loc) {
            pushCandidate(join(loc, 'app', 'resources', 'codex.exe'));
          }
        } catch {
          // ignore
        }
      } else {
        try {
          const { stdout } = await execFileAsync('which', ['codex'], {
            encoding: 'utf8',
            timeout: 4_000,
          });
          const first = (stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
          pushCandidate(first);
        } catch {
          // ignore
        }

        const home = homedir();
        for (const c of [
          '/opt/homebrew/bin/codex',
          '/usr/local/bin/codex',
          '/usr/bin/codex',
          join(home, '.local', 'bin', 'codex'),
          join(home, '.npm-global', 'bin', 'codex'),
          '/Applications/Codex.app/Contents/Resources/codex',
        ]) {
          pushCandidate(c);
        }
      }

      // Verify candidate actually executes `--version` (skips ACL-locked WindowsApps binaries!)
      let found = null;
      let version = null;
      for (const cand of candidates) {
        const ver = await this._probeBinaryVersion(cand);
        if (ver) {
          found = cand;
          version = ver;
          break;
        }
      }

      const next = { path: found, version, detectedAt: Date.now() };
      this._binCache = next;
      if (found && version) this._saveDiskCache(next);
      return next;
    })().finally(() => {
      this._probePromise = null;
    });
    return this._probePromise;
  }

  async ensureCodexBinaryAsync(customPath = '') {
    const cleanedCustom = String(customPath || '').trim();
    if (cleanedCustom) {
      if (!existsSync(cleanedCustom) || !statSync(cleanedCustom).isFile()) {
        throw new Error(`自定义的 Codex 路径不存在或不是可执行文件: ${cleanedCustom}`);
      }
      return { path: cleanedCustom, version: null, custom: true };
    }
    const fast = this.getCodexBinaryFast();
    if (fast.path) return fast;
    return this.refreshCodexBinaryAsync();
  }

  hasRunningJob(jobId) {
    return this.runningJobs.has(jobId);
  }

  _setStage(job, stage, stageLabel) {
    job.stage = stage;
    job.stageLabel = stageLabel;
    this.store.scheduleSave();
  }

  _notifyWaiters(jobId, job) {
    const set = this.waiters.get(jobId);
    if (!set) return;
    this.waiters.delete(jobId);
    for (const fn of set) {
      try {
        fn(job);
      } catch {
        // ignore
      }
    }
  }

  waitForJob(jobId, timeoutSec = 0) {
    const job = this.store.getJob(jobId);
    if (!job) return Promise.resolve(null);
    if (job.status !== 'running' || timeoutSec <= 0) {
      return Promise.resolve(job);
    }
    return new Promise((resolveDone) => {
      let set = this.waiters.get(jobId);
      if (!set) {
        set = new Set();
        this.waiters.set(jobId, set);
      }
      const timer = setTimeout(() => {
        set.delete(onDone);
        resolveDone(this.store.getJob(jobId));
      }, Math.min(timeoutSec, 180) * 1000);

      const onDone = (finishedJob) => {
        clearTimeout(timer);
        resolveDone(finishedJob);
      };
      set.add(onDone);
    });
  }

  _killProcessTree(pid, child) {
    if (process.platform === 'win32') {
      try {
        if (pid) {
          spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
            windowsHide: true,
            timeout: 5000,
          });
        }
      } catch {
        // ignore
      }
    } else if (pid) {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        // ignore
      }
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
    try {
      if (child && !child.killed) {
        child.kill('SIGKILL');
      }
    } catch {
      // ignore
    }
  }

  _clearColdStartTimer(jobId) {
    const active = this.runningJobs.get(jobId);
    if (active?.coldStartTimer) {
      clearTimeout(active.coldStartTimer);
      active.coldStartTimer = null;
    }
  }

  _handleCodexEvent(job, session, evt) {
    if (!evt || typeof evt !== 'object') return;
    const type = evt.type;

    if (type === 'thread.started' && evt.thread_id) {
      this._clearColdStartTimer(job.id);
      job.codexThreadId = evt.thread_id;
      if (session) {
        session.codexThreadId = evt.thread_id;
        session.updatedAt = Date.now();
      }
      this._setStage(job, 'executing', '思考与执行中');
      this.store.appendJobEvent(job, 'system', `已建立 Codex 会话 ${evt.thread_id.slice(0, 8)}...`, evt);
      return;
    }

    if (type === 'turn.started') {
      this._clearColdStartTimer(job.id);
      this._setStage(job, 'executing', '思考与执行中');
      this.store.appendJobEvent(job, 'system', '开始推理与执行...', evt);
      return;
    }

    if (type === 'turn.completed') {
      this._clearColdStartTimer(job.id);
      if (evt.usage) job.usage = evt.usage;
      this.store.scheduleSave();
      return;
    }

    if (type === 'turn.failed' || type === 'error') {
      this._clearColdStartTimer(job.id);
      const msg = evt.error?.message || evt.message || JSON.stringify(evt);
      job.error = msg;
      this.store.appendJobEvent(job, 'error', `执行异常: ${msg}`, evt);
      return;
    }

    if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
      this._clearColdStartTimer(job.id);
      const item = evt.item;
      if (!item || typeof item !== 'object') return;

      if (item.type === 'reasoning') {
        if (type === 'item.started') {
          this._setStage(job, 'thinking', '正在深度思考...');
          this.store.appendJobEvent(job, 'reasoning', '正在深度思考...', evt);
        } else if (type === 'item.completed' && typeof item.text === 'string' && item.text.trim()) {
          this.store.appendJobEvent(job, 'reasoning', item.text.slice(0, 260), evt);
        }
        return;
      }

      if (item.type === 'agent_message') {
        const txt = typeof item.text === 'string' ? item.text : '';
        if (txt) {
          this._setStage(job, 'executing', '正在输出回复...');
          job.liveReply = txt;
          if (type === 'item.completed') {
            job.finalReply = txt;
            this.store.appendJobEvent(job, 'message', txt.slice(0, 260), evt);
          } else {
            this.store.scheduleSave();
          }
        }
        return;
      }

      if (item.type === 'command_execution') {
        const cmd = item.command || item.cmd || '(command)';
        if (type === 'item.started') {
          this._setStage(job, 'executing', '执行命令中...');
          this.store.appendJobEvent(job, 'command', `执行命令: ${cmd}`, evt);
        } else if (type === 'item.completed') {
          const exitCode = item.exit_code ?? item.exitCode ?? null;
          job.commandsRun = job.commandsRun || [];
          job.commandsRun.push({
            command: String(cmd).slice(0, 300),
            exitCode,
          });
          this.store.appendJobEvent(job, 'command', `命令结束 (exit ${exitCode ?? '?'}): ${cmd}`, evt);
        }
        return;
      }

      if (item.type === 'file_change' && type === 'item.completed') {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        if (changes.length > 0) {
          const summary = changes.map((c) => `${c.kind || 'edit'} ${c.path || ''}`).join(', ');
          this.store.appendJobEvent(job, 'file', `文件变更事件: ${summary}`, evt);
        }
        return;
      }

      if (item.type === 'mcp_tool_call') {
        const name = item.tool || item.name || 'mcp';
        this.store.appendJobEvent(
          job,
          'tool',
          type === 'item.started' ? `调用工具: ${name}` : `工具完成: ${name}`,
          evt
        );
      }
    }
  }

  /**
   * Returns IMMEDIATELY (< 50ms) with { job, session, shadow }.
   * Shadow preparation, binary resolution, and codex execution all happen asynchronously.
   */
  startJob({
    sourceDir,
    prompt,
    persona,
    session = null,
    sandbox = '',
    permissions = null,
    model = '',
    reasoningEffort = '',
    fastMode = undefined,
    cleanCodexConfig = undefined,
    createdBy = 'hakimi',
    title = '',
    images = [],
    attachments = [],
    shadowLimits = {},
    coldStartTimeoutMs = DEFAULT_COLD_START_TIMEOUT_MS,
    _overrideCommand = null, // internal hook for unit/e2e watchdog testing
  }) {
    const rawSourceDir = String(sourceDir || session?.sourceDir || '').trim();
    if (!rawSourceDir) {
      throw new Error('请指定目标工程目录 sourceDir');
    }
    const absSourceDir = resolve(rawSourceDir);
    if (!existsSync(absSourceDir) || !statSync(absSourceDir).isDirectory()) {
      throw new Error(`源工程目录不存在或不是文件夹: ${absSourceDir}`);
    }

    const effectiveModel = String(model || session?.model || persona.model).trim();
    const effectiveEffort = String(
      reasoningEffort || session?.reasoningEffort || persona.reasoningEffort || 'high'
    ).trim();
    const effectiveFastMode = typeof fastMode === 'boolean' ? fastMode : Boolean(persona.fastMode);
    const effectiveCleanConfig =
      typeof cleanCodexConfig === 'boolean' ? cleanCodexConfig : persona.cleanCodexConfig !== false;
    const effectivePerms = permissions
      ? normalizePermissions(permissions, sandbox || persona.defaultSandbox)
      : VALID_SANDBOXES.includes(sandbox)
        ? permissionsFromSandbox(sandbox)
        : normalizePermissions(persona.permissions, persona.defaultSandbox);
    const effectiveSandbox = permissionsToSandbox(effectivePerms);
    const isDirect = effectivePerms.fileScope === 'direct';

    const attachmentImages = Array.isArray(attachments)
      ? attachments.map((a) => a?.filePath).filter(Boolean)
      : [];
    const mergedImages = [...(Array.isArray(images) ? images : []), ...attachmentImages];
    const msgAttachments = Array.isArray(attachments)
      ? attachments.map((a) => ({
          id: a.id,
          name: a.name,
          mime: a.mime,
          previewDataUrl: a.previewDataUrl || '',
        }))
      : [];

    // Check existing active shadow on this session (skipped completely in turbo-direct)
    const existingShadow =
      !isDirect && session?.shadowId ? this.store.getShadow(session.shadowId) : null;
    const reusableShadow =
      existingShadow && existingShadow.status !== 'discarded' && existsSync(existingShadow.workDir)
        ? existingShadow
        : null;

    // Prevent concurrent running jobs on same session, same shadow, or same direct sourceDir
    const busyJob = this.store.state.jobs.find(
      (j) =>
        j.status === 'running' &&
        ((session && j.sessionId === session.id) ||
          (reusableShadow && j.shadowId === reusableShadow.id) ||
          (isDirect && j.directMode && j.sourceDir === absSourceDir))
    );
    if (busyJob) {
      throw new Error(
        `当前工位已有运行中的任务 (${busyJob.id.slice(0, 8)})，请等待完成或先点击中止。`
      );
    }

    if (!session) {
      const autoTitle =
        String(title || '').trim() || String(prompt).trim().replace(/\s+/g, ' ').slice(0, 24);
      session = this.store.createSession({
        personaId: persona.id,
        provider: 'codex-cli',
        title: autoTitle,
        sourceDir: absSourceDir,
        shadowId: reusableShadow ? reusableShadow.id : null,
        model: effectiveModel,
        reasoningEffort: effectiveEffort,
      });
    } else {
      session.provider = 'codex-cli';
      session.model = effectiveModel;
      session.reasoningEffort = effectiveEffort;
      session.updatedAt = Date.now();
    }

    const needsShadow = !isDirect && !reusableShadow;
    const jobId = `job-${randomUUID().slice(0, 12)}`;
    const job = this.store.addJob({
      id: jobId,
      sessionId: session.id,
      personaId: persona.id,
      personaName: persona.name,
      provider: 'codex-cli',
      createdBy: createdBy === 'boss' ? 'boss' : 'hakimi',
      sourceDir: absSourceDir,
      shadowId: isDirect ? null : reusableShadow ? reusableShadow.id : null,
      shadowWorkDir: isDirect ? absSourceDir : reusableShadow ? reusableShadow.workDir : null,
      directMode: isDirect,
      directSummary: null,
      sandbox: effectiveSandbox,
      permissions: effectivePerms,
      model: effectiveModel,
      reasoningEffort: effectiveEffort,
      fastMode: effectiveFastMode,
      cleanCodexConfig: effectiveCleanConfig,
      prompt: String(prompt),
      status: 'running',
      stage: needsShadow ? 'preparing_shadow' : 'starting_engine',
      stageLabel: needsShadow
        ? '准备隔离副本'
        : isDirect
          ? '启动引擎（Turbo 直通）'
          : '启动引擎',
      codexThreadId: session.codexThreadId || null,
      resumed: Boolean(session.codexThreadId),
      events: [],
      commandsRun: [],
      liveReply: '',
      finalReply: '',
      usage: null,
      exitCode: null,
      error: null,
      abortReason: '',
      diffSummary: null,
      sourceIntegrity: null,
      createdAt: Date.now(),
      startedAt: Date.now(),
      finishedAt: null,
    });

    this.store.appendSessionMessage(session.id, {
      role: createdBy === 'boss' ? 'boss' : 'hakimi',
      text: String(prompt),
      jobId: job.id,
      attachments: msgAttachments,
    });

    const controller = new AbortController();
    this.runningJobs.set(job.id, {
      controller,
      child: null,
      pid: null,
      lastMsgFile: null,
      coldStartTimer: null,
    });

    setImmediate(() => {
      this._runPipeline({
        job,
        session,
        reusableShadow,
        absSourceDir,
        isDirect,
        persona,
        effectiveModel,
        effectiveEffort,
        effectiveFastMode,
        effectiveCleanConfig,
        effectiveSandbox,
        effectivePerms,
        prompt: String(prompt),
        images: mergedImages,
        shadowLimits,
        coldStartTimeoutMs,
        controller,
        _overrideCommand,
      });
    });

    return { job, session, shadow: reusableShadow };
  }

  async _runPipeline({
    job,
    session,
    reusableShadow,
    absSourceDir,
    isDirect = false,
    persona,
    effectiveModel,
    effectiveEffort,
    effectiveFastMode = false,
    effectiveCleanConfig = true,
    effectiveSandbox,
    effectivePerms,
    prompt,
    images,
    shadowLimits,
    coldStartTimeoutMs,
    controller,
    _overrideCommand,
  }) {
    const finishFailure = (errMsg) => {
      this._clearColdStartTimer(job.id);
      this.runningJobs.delete(job.id);
      job.finishedAt = Date.now();
      if (job.status === 'aborted' || controller.signal.aborted) {
        job.status = 'aborted';
        job.stage = 'aborted';
        job.stageLabel = '已中止';
        this.store.appendJobEvent(
          job,
          'system',
          `任务已中止${job.abortReason ? `：${job.abortReason}` : ''}`
        );
        this.store.appendSessionMessage(session.id, {
          role: 'system',
          text: `已中止本次执行${job.abortReason ? `：${job.abortReason}` : ''}（不会自动重发）`,
          jobId: job.id,
        });
      } else {
        job.status = 'failed';
        job.stage = 'failed';
        job.stageLabel = '执行失败';
        job.error = redactSecrets(String(errMsg || '未知错误'), this.store.getKnownSecrets()).slice(0, 1000);
        this.store.appendJobEvent(job, 'error', job.error.slice(0, 320));
        this.store.appendSessionMessage(session.id, {
          role: 'system',
          text: `执行失败：${job.error.slice(0, 400)}`,
          jobId: job.id,
        });
      }
      this.store.flush();
      this._notifyWaiters(job.id, job);
    };

    // Stage 1: Prepare isolated shadow copy asynchronously (completely skipped in turbo-direct)
    let shadow = isDirect ? null : reusableShadow;
    if (!isDirect && !shadow) {
      this._setStage(job, 'preparing_shadow', '准备隔离副本');
      this.store.appendJobEvent(job, 'system', `正在为 ${absSourceDir} 准备隔离影子副本...`);
      try {
        shadow = await createShadowCopyAsync(this.store, absSourceDir, {
          ...shadowLimits,
          signal: controller.signal,
        });
        job.shadowId = shadow.id;
        job.shadowWorkDir = shadow.workDir;
        session.shadowId = shadow.id;
        session.sourceDir = shadow.sourceDir;
        this.store.appendJobEvent(
          job,
          'system',
          `影子副本 ${shadow.id} 就绪（${shadow.fileCount} 文件，已跳过 ${shadow.skippedDirs.length} 个重目录）`
        );
      } catch (err) {
        finishFailure(err?.name === 'AbortError' ? '影子副本准备阶段被用户中止' : err.message);
        return;
      }
    }

    const runWorkDir = isDirect ? absSourceDir : shadow.workDir;

    if (controller.signal.aborted || job.status === 'aborted') {
      finishFailure('已中止');
      return;
    }

    // Stage 2: Resolve Codex executable & launch child process
    this._setStage(job, 'starting_engine', isDirect ? '启动引擎（Turbo 直通）' : '启动引擎');

    let execPath;
    let execArgs;
    let outboundPrompt = String(prompt || '');
    const lastMsgFile = join(this.store.tmpDir, `last_${job.id}.txt`);

    if (_overrideCommand) {
      execPath = _overrideCommand.command;
      execArgs = _overrideCommand.args || [];
    } else {
      let bin;
      try {
        bin = await this.ensureCodexBinaryAsync(persona?.customCodexPath || '');
      } catch (err) {
        finishFailure(err.message);
        return;
      }
      if (!bin?.path) {
        finishFailure('未找到本机 Codex CLI（请确认已安装 Codex CLI / Codex 桌面端，或在人物卡中填写自定义 Codex 路径）');
        return;
      }
      execPath = bin.path;

      const userProfile = this.store.getUserProfile();
      const profileBlock = composePersonaProfileBlock(persona, userProfile);
      const hadRollback = Boolean(session.pendingDiskRollbackNotice);
      if (hadRollback) {
        session.pendingDiskRollbackNotice = false;
      }
      const anchorEval = evaluateAnchorSync(session, profileBlock, prompt);
      this.store.scheduleSave();

      const turnGuidanceHeader = composeTurnGuidanceHeader({
        workDir: runWorkDir,
        permissions: effectivePerms,
        directMode: isDirect,
        hadRollback,
        inheritedSummary: session.inheritedSummary,
        isFirstTurnWithInherited: Boolean(session.inheritedSummary?.summary && !session.codexThreadId),
      });
      outboundPrompt = composeOutboundUserPayload({
        userPrompt: prompt,
        turnGuidanceHeader,
        recencySyncBlock: anchorEval.recencySyncBlock,
      });

      const devInst = buildDeveloperInstructions(persona, {
        isDirect,
        absSourceDir: runWorkDir,
        permissions: effectivePerms,
        userProfile,
        inheritedSummary: session.inheritedSummary,
      });
      const validImages = Array.isArray(images)
        ? images.map((x) => String(x || '').trim()).filter((p) => p && existsSync(p))
        : [];

      const winSandbox =
        effectiveCleanConfig && !isDirect
          ? readCodexUserDefaults().windowsSandbox || 'unelevated'
          : '';

      execArgs = buildCodexArgs({
        isDirect,
        isResume: Boolean(session.codexThreadId),
        sandbox: effectiveSandbox,
        permissions: effectivePerms,
        workDir: runWorkDir,
        effectiveModel,
        effectiveEffort,
        fastMode: effectiveFastMode,
        cleanCodexConfig: effectiveCleanConfig,
        windowsSandbox: winSandbox,
        devInst,
        validImages,
        lastMsgFile,
        codexThreadId: session.codexThreadId || '',
      });
    }

    if (controller.signal.aborted || job.status === 'aborted') {
      finishFailure('已中止');
      return;
    }

    this.store.appendJobEvent(
      job,
      'system',
      `启动 ${persona.name} [Codex] (${effectiveModel} / ${effectiveEffort} / ${isDirect ? '⚡ Turbo 直通' : effectiveSandbox}${session.codexThreadId ? ' / resume' : ''})`
    );

    let child;
    try {
      child = spawn(execPath, execArgs, {
        cwd: runWorkDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: { ...process.env, NO_COLOR: '1' },
      });
    } catch (err) {
      finishFailure(`拉起 Codex CLI 失败: ${err.message}`);
      return;
    }

    const active = this.runningJobs.get(job.id);
    if (!active || controller.signal.aborted || job.status === 'aborted') {
      this._killProcessTree(child.pid, child);
      finishFailure('已中止');
      return;
    }
    active.child = child;
    active.pid = child.pid;
    active.lastMsgFile = lastMsgFile;

    // Cold-start watchdog: abort cleanly if thread.started is not received within 45s
    const timeoutMs = Math.max(500, Number(coldStartTimeoutMs) || DEFAULT_COLD_START_TIMEOUT_MS);
    let timedOutColdStart = false;
    active.coldStartTimer = setTimeout(() => {
      if (job.status !== 'running') return;
      timedOutColdStart = true;
      job.error = `Codex 冷启动超时（${(timeoutMs / 1000).toFixed(0)}s 内未收到 thread.started 首包），可能是网络异常、登录过期或进程假死。已自动强杀进程，绝不自动重发。`;
      this.store.appendJobEvent(job, 'error', job.error);
      this._killProcessTree(child.pid, child);
    }, timeoutMs);

    let stdoutBuf = '';
    let stderrText = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const evt = JSON.parse(trimmed);
          this._handleCodexEvent(job, session, evt);
        } catch {
          this.store.appendJobEvent(job, 'system', trimmed.slice(0, 300));
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrText += chunk;
      if (stderrText.length > 8000) stderrText = stderrText.slice(-8000);
    });

    child.on('error', (err) => {
      finishFailure(`进程启动错误: ${err.message}`);
    });

    child.on('close', async (code) => {
      this._clearColdStartTimer(job.id);
      this.runningJobs.delete(job.id);

      if (stdoutBuf.trim()) {
        try {
          this._handleCodexEvent(job, session, JSON.parse(stdoutBuf.trim()));
        } catch {
          // ignore
        }
      }

      let fileReply = '';
      try {
        if (existsSync(lastMsgFile)) {
          fileReply = readFileSync(lastMsgFile, 'utf8').trim();
          unlinkSync(lastMsgFile);
        }
      } catch {
        // ignore
      }

      if (fileReply) {
        job.finalReply = fileReply;
      } else if (!job.finalReply && job.liveReply) {
        job.finalReply = job.liveReply;
      }

      if (isDirect) {
        job.directSummary = await inspectDirectGitStatus(absSourceDir);
        job.diffSummary = null;
        job.sourceIntegrity = null;
      } else {
        // Stage 4: Compute ground-truth red/green Diff & source integrity verification
        this._setStage(job, 'computing_diff', '汇总红绿 Diff');
        let diff = null;
        try {
          if (shadow && existsSync(shadow.workDir)) {
            diff = computeShadowDiff(shadow);
            shadow.hasChanges = diff.hasChanges;
            shadow.changedCount = diff.stats.totalFiles;
            shadow.updatedAt = Date.now();
            job.diffSummary = {
              hasChanges: diff.hasChanges,
              stats: diff.stats,
              files: diff.files.map((f) => ({
                path: f.path,
                status: f.status,
                additions: f.additions,
                deletions: f.deletions,
              })),
            };
          }
        } catch (err) {
          this.store.appendJobEvent(job, 'error', `影子 Diff 计算失败: ${err.message}`);
        }

        try {
          if (shadow && existsSync(shadow.manifestFile)) {
            job.sourceIntegrity = verifySourceUntouched(shadow, diff);
            if (!job.sourceIntegrity.untouched) {
              this.store.appendJobEvent(
                job,
                'error',
                `⚠️ 源目录基线完整性警告：检测到 ${job.sourceIntegrity.tamperedFiles.length} 个原目录文件发生变化！`
              );
            }
          }
        } catch (err) {
          this.store.appendJobEvent(job, 'error', `源目录校验失败: ${err.message}`);
        }
      }

      job.exitCode = code;
      job.finishedAt = Date.now();

      if (job.status === 'aborted' || controller.signal.aborted) {
        job.status = 'aborted';
        job.stage = 'aborted';
        job.stageLabel = '已中止';
        this.store.appendJobEvent(
          job,
          'system',
          `任务已中止${job.abortReason ? `：${job.abortReason}` : ''}`
        );
        this.store.appendSessionMessage(session.id, {
          role: 'system',
          text: `已中止本次执行${job.abortReason ? `：${job.abortReason}` : ''}（不会自动重发）`,
          jobId: job.id,
        });
      } else if (timedOutColdStart) {
        job.status = 'failed';
        job.stage = 'failed';
        job.stageLabel = '冷启动超时';
        this.store.appendSessionMessage(session.id, {
          role: 'system',
          text: job.error,
          jobId: job.id,
        });
      } else if (code === 0) {
        job.status = 'completed';
        job.stage = 'completed';
        job.stageLabel = '已完成';
        const dur = ((job.finishedAt - job.startedAt) / 1000).toFixed(1);
        this.store.appendJobEvent(job, 'system', `执行完成（耗时 ${dur}s）`);
        this.store.appendSessionMessage(session.id, {
          role: 'assistant',
          text: job.finalReply || '（任务已完成，无文本回复）',
          jobId: job.id,
          model: job.model,
          usage: job.usage,
        });
      } else {
        job.status = 'failed';
        job.stage = 'failed';
        job.stageLabel = '执行失败';
        job.error = redactSecrets(
          (job.error || stderrText || `codex 退出码 ${code}`).trim(),
          this.store.getKnownSecrets()
        ).slice(0, 1000);
        this.store.appendJobEvent(job, 'error', `执行失败 (exit ${code}): ${job.error.slice(0, 260)}`);
        this.store.appendSessionMessage(session.id, {
          role: 'system',
          text: `执行失败 (exit ${code})：${job.error.slice(0, 400)}`,
          jobId: job.id,
        });
      }

      if (this.quotaReader) {
        try {
          const { contextUsage } = await this.quotaReader.refreshAll({
            threadId: session.codexThreadId || job.codexThreadId || '',
          });
          if (contextUsage) {
            session.contextUsage = contextUsage;
          }
        } catch {
          // best-effort local quota/context snapshot refresh
        }
      }

      this.store.flush();
      this._notifyWaiters(job.id, job);
    });

    try {
      child.stdin.end(outboundPrompt, 'utf8');
    } catch {
      // ignore
    }
  }

  abortJob(jobId, reason = '用户手动中止') {
    const job = this.store.getJob(jobId);
    if (!job) throw new Error(`未找到任务: ${jobId}`);
    if (job.status !== 'running') {
      return { aborted: false, status: job.status, job };
    }

    job.status = 'aborted';
    job.stage = 'aborted';
    job.stageLabel = '已中止';
    job.abortReason = String(reason || '用户手动中止').trim();

    const active = this.runningJobs.get(job.id);
    if (active) {
      this._clearColdStartTimer(job.id);
      active.controller.abort();
      if (active.child || active.pid) {
        this._killProcessTree(active.pid, active.child);
      }
    }

    this.store.flush();
    return { aborted: true, status: 'aborted', job };
  }

  abortAllJobs(reason = '全局急停熔断') {
    const ids = Array.from(this.runningJobs.keys());
    const abortedIds = [];
    for (const id of ids) {
      try {
        const res = this.abortJob(id, reason);
        if (res.aborted) abortedIds.push(id);
      } catch {
        // ignore
      }
    }
    return abortedIds;
  }

  /**
   * Ephemeral, read-only, low-effort summarization call using local codex.exe.
   * Zero shadow copy, no shell commands, never persists thread history.
   */
  async runOneShotSummary(persona, promptText, { timeoutMs = 90_000 } = {}) {
    const bin = await this.ensureCodexBinaryAsync(persona?.customCodexPath || '');
    if (!bin?.path) {
      throw new Error('未检测到本机 Codex CLI，无法使用该成员整理摘要');
    }
    const outFile = join(this.store.tmpDir, `sum_${randomUUID().slice(0, 10)}.txt`);
    const args = [
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--skip-git-repo-check',
      '--json',
      '-s',
      'read-only',
      '-c',
      'approval_policy="never"',
      '-c',
      'features.shell_tool=false',
      '-c',
      'features.unified_exec=false',
      '-c',
      'service_tier="default"',
      '-c',
      'model_reasoning_effort="low"',
      '-C',
      this.store.tmpDir,
      '-o',
      outFile,
    ];
    if (persona?.model) args.push('-m', persona.model);
    args.push('-');

    return new Promise((resolveSum, rejectSum) => {
      let stdoutBuf = '';
      let lastAgentMsg = '';
      let stderrText = '';
      let settled = false;

      const child = spawn(bin.path, args, {
        cwd: this.store.tmpDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: { ...process.env, NO_COLOR: '1' },
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this._killProcessTree(child.pid, child);
        rejectSum(new Error(`压缩摘要超时 (${Math.round(timeoutMs / 1000)}s)`));
      }, timeoutMs);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdoutBuf += chunk;
        const lines = stdoutBuf.split(/\r?\n/);
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const evt = JSON.parse(trimmed);
            if (evt?.item?.type === 'agent_message' && typeof evt.item.text === 'string') {
              lastAgentMsg = evt.item.text;
            }
          } catch {
            // ignore
          }
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderrText += chunk;
        if (stderrText.length > 4000) stderrText = stderrText.slice(-4000);
      });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectSum(new Error(`拉起 codex 压缩摘要失败: ${err.message}`));
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.quotaReader) {
          this.quotaReader.getQuota({ force: true }).catch(() => {});
        }
        let fileReply = '';
        try {
          if (existsSync(outFile)) {
            fileReply = readFileSync(outFile, 'utf8').trim();
            unlinkSync(outFile);
          }
        } catch {
          // ignore
        }
        const text = (fileReply || lastAgentMsg || '').trim();
        if (code === 0 && text) {
          resolveSum(text);
        } else {
          rejectSum(
            new Error(stderrText.trim() || `codex 压缩摘要失败 (exit ${code})`)
          );
        }
      });

      try {
        child.stdin.end(String(promptText || ''), 'utf8');
      } catch {
        // ignore
      }
    });
  }

  shutdownAll() {
    for (const [jobId, active] of this.runningJobs.entries()) {
      this._clearColdStartTimer(jobId);
      try {
        active.controller.abort();
      } catch {
        // ignore
      }
      if (active.child || active.pid) {
        this._killProcessTree(active.pid, active.child);
      }
      const job = this.store.getJob(jobId);
      if (job && job.status === 'running') {
        job.status = 'needs_review';
        job.stage = 'needs_review';
        job.stageLabel = '结果待核对';
        job.error = 'MCP Server 退出，原运行中任务已安全终止（结果待核对）';
        job.finishedAt = Date.now();
      }
    }
    this.runningJobs.clear();
    try {
      this.store.flush();
    } catch {
      // ignore
    }
  }
}
