import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  ANTI_ESCAPE_GUARDRAIL,
  buildDirectModeInstructions,
  buildInheritedSummaryInstruction,
} from './codex-runner.mjs';
import {
  composeOutboundUserPayload,
  composePersonaProfileBlock,
  composeTurnGuidanceHeader,
  evaluateAnchorSync,
} from './prompt-composer.mjs';
import {
  assertRealPathInsideRoot,
  isSameOrInsideRealPath,
  lstatNoThrow,
  realpathNative,
  redactSecrets,
} from './security.mjs';
import {
  computeShadowDiff,
  createShadowCopyAsync,
  inspectDirectGitStatus,
  verifySourceUntouched,
} from './shadow-engine.mjs';
import {
  DEFAULT_OPENAI_CONTEXT_WINDOW,
  normalizeContextUsage,
  normalizeContextWindow,
  normalizePermissions,
  permissionsFromSandbox,
  permissionsToSandbox,
  VALID_SANDBOXES,
} from './store.mjs';

export function buildOpenAiContextUsage(rawUsage, persona = null) {
  if (!rawUsage || typeof rawUsage !== 'object') return null;
  const inputTokens = Math.max(
    0,
    Math.round(Number(rawUsage.prompt_tokens ?? rawUsage.input_tokens) || 0)
  );
  const outputTokens = Math.max(
    0,
    Math.round(Number(rawUsage.completion_tokens ?? rawUsage.output_tokens) || 0)
  );
  const cachedTokens = Math.max(
    0,
    Math.round(
      Number(
        rawUsage.prompt_cache_hit_tokens ??
          rawUsage.prompt_tokens_details?.cached_tokens ??
          rawUsage.cached_input_tokens
      ) || 0
    )
  );
  const reasoningTokens = Math.max(
    0,
    Math.round(
      Number(
        rawUsage.completion_tokens_details?.reasoning_tokens ??
          rawUsage.reasoning_output_tokens
      ) || 0
    )
  );
  const rawTotal = Math.max(0, Math.round(Number(rawUsage.total_tokens) || 0));
  const usedTokens = rawTotal > 0 ? rawTotal : inputTokens + outputTokens;
  if (usedTokens === 0 && inputTokens === 0 && outputTokens === 0) return null;
  const maxTokens = normalizeContextWindow(persona?.contextWindow) || DEFAULT_OPENAI_CONTEXT_WINDOW;
  return normalizeContextUsage({
    usedTokens,
    inputTokens,
    outputTokens,
    cachedTokens,
    reasoningTokens,
    maxTokens,
    source: 'openai-usage',
    updatedAt: Date.now(),
  });
}

export const MAX_TOOL_ROUNDS = 20;
const MAX_READ_BYTES = 32 * 1024;
const MAX_READ_LINES = 400;
const MAX_CMD_TIMEOUT_MS = 60_000;
const MAX_CMD_STDOUT_BYTES = 24 * 1024;
const MAX_CMD_STDERR_BYTES = 12 * 1024;

function killSubprocessTree(pid, child) {
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

function resolveDirectToolPath(baseDir, inputPath, { allowMissingLeaf = false, allowExternal = false } = {}) {
  if (typeof inputPath !== 'string' || !inputPath.trim()) {
    throw new Error('路径参数不能为空');
  }
  const raw = inputPath.trim();
  if (raw.includes('\0')) {
    throw new Error('路径拦截：包含非法 NUL 字符');
  }
  const absBase = realpathNative(resolve(baseDir));
  const absTarget =
    isAbsolute(raw) || /^[a-zA-Z]:/.test(raw) ? resolve(raw) : resolve(absBase, raw);
  if (!allowExternal) {
    const checked = assertRealPathInsideRoot(absBase, absTarget, {
      allowMissingLeaf,
      rejectSymlink: true,
      label: '目标工程目录',
    });
    const relDisplay = relative(absBase, checked.absPath);
    return {
      absPath: checked.absPath,
      relPosix: relDisplay ? relDisplay.split(sep).join('/') : '.',
    };
  }
  if (!allowMissingLeaf && !existsSync(absTarget)) {
    throw new Error(`文件或目录不存在: ${raw}`);
  }
  const relDisplay = relative(absBase, absTarget);
  const relPosix =
    relDisplay && !relDisplay.startsWith('..') && !isAbsolute(relDisplay)
      ? relDisplay.split(sep).join('/')
      : absTarget;
  return { absPath: absTarget, relPosix };
}

/**
 * Normalizes user-provided OpenAI-compatible Base URL to the exact /chat/completions endpoint.
 * Handles:
 *   - https://api.deepseek.com            -> https://api.deepseek.com/v1/chat/completions
 *   - https://api.deepseek.com/v1         -> https://api.deepseek.com/v1/chat/completions
 *   - https://openrouter.ai/api/v1        -> https://openrouter.ai/api/v1/chat/completions
 *   - http://127.0.0.1:11434/v1           -> http://127.0.0.1:11434/v1/chat/completions
 *   - https://proxy.example/v1/chat/completions -> unchanged
 */
export function resolveChatCompletionsUrl(rawBaseUrl) {
  const cleaned = String(rawBaseUrl || '').trim().replace(/\/+$/, '');
  if (!cleaned) {
    throw new Error('请先在人物卡中填写 OpenAI 兼容 API 的 Base URL');
  }
  let parsed;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new Error(`无效的 Base URL: ${cleaned}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Base URL 仅支持 http:// 或 https:// 协议: ${cleaned}`);
  }

  const lowerPath = parsed.pathname.replace(/\/+$/, '').toLowerCase();
  if (lowerPath.endsWith('/chat/completions')) {
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  }
  if (/\/v\d+(?:beta\d*)?$/i.test(lowerPath) || /\/openai$/i.test(lowerPath)) {
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}/chat/completions`;
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}/v1/chat/completions`;
}

/**
 * Hard path boundary guard for every built-in agentic file tool.
 * Strictly requires a relative path inside shadowWorkDir, rejects .git,
 * and verifies realpath containment (or nearest existing parent realpath for new files).
 */
export function resolveSafeShadowPath(shadowWorkDir, inputPath, { allowMissingLeaf = false } = {}) {
  if (typeof inputPath !== 'string' || !inputPath.trim()) {
    throw new Error('路径参数不能为空');
  }
  const raw = inputPath.trim();
  if (raw.includes('\0')) {
    throw new Error('路径越界拦截：包含非法 NUL 字符');
  }
  if (isAbsolute(raw) || /^[a-zA-Z]:/.test(raw) || raw.startsWith('\\\\') || raw.startsWith('//')) {
    throw new Error(`路径越界拦截：禁止使用绝对路径 (${raw})，必须使用相对路径`);
  }

  const normalizedRel = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  const segments = normalizedRel.split('/').filter((s) => s.length > 0 && s !== '.');
  if (segments.includes('..')) {
    throw new Error(`路径越界拦截：禁止使用上级目录跳转 (${raw})`);
  }
  if (segments[0]?.toLowerCase() === '.git') {
    throw new Error('路径越界拦截：禁止读写影子副本内部 .git 目录');
  }

  const rootReal = realpathNative(shadowWorkDir);
  const candidate = segments.length > 0 ? resolve(rootReal, ...segments) : rootReal;
  const checked = assertRealPathInsideRoot(rootReal, candidate, {
    allowMissingLeaf,
    rejectSymlink: true,
    label: '影子工作区',
  });

  return { absPath: checked.absPath, relPosix: segments.join('/') };
}

function isBinaryBuffer(buf) {
  const len = Math.min(buf.length, 4096);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// OpenAI Function Calling Tool Definitions (Strictly Scoped to Shadow)
// ---------------------------------------------------------------------------

const READ_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出当前影子工作区中的相对文件路径（自动跳过 .git）。',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: '可选相对子目录，默认 "."' },
          maxDepth: { type: 'integer', description: '最大遍历深度，默认 6' },
          maxEntries: { type: 'integer', description: '最多返回条数，默认 200（上限 500）' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_text',
      description: '在影子工作区文本文件中按关键字搜索匹配行，返回相对路径、行号与摘要。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键字（大小写不敏感）' },
          dir: { type: 'string', description: '可选相对子目录，默认 "."' },
          maxResults: { type: 'integer', description: '最多返回匹配条数，默认 40（上限 100）' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '按行号范围读取影子工作区中的文本文件（单次上限 400 行 / 32 KB）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对文件路径' },
          startLine: { type: 'integer', description: '起始行号（从 1 开始，默认 1）' },
          endLine: { type: 'integer', description: '结束行号（含，可选）' },
        },
        required: ['path'],
      },
    },
  },
];

const WRITE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '在影子工作区中新建或覆盖写入 UTF-8 文本文件（自动创建父目录）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对文件路径' },
          content: { type: 'string', description: '完整文件内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: '在影子工作区现有文本文件中执行精确字符串替换。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对文件路径' },
          old_text: { type: 'string', description: '要被替换的原文精确片段' },
          new_text: { type: 'string', description: '替换后的新内容' },
          replace_all: { type: 'boolean', description: '是否替换全部匹配项，默认 false' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: '删除影子工作区中的单个文件（不能删除目录）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对文件路径' },
        },
        required: ['path'],
      },
    },
  },
];

const WRITE_TOOL_NAMES = new Set(['write_file', 'edit_file', 'delete_file']);

const RUN_COMMAND_TOOL = {
  type: 'function',
  function: {
    name: 'run_command',
    description:
      '仅在 Turbo 直通模式下可用：在本机执行一条 PowerShell/终端命令（默认工作目录为目标工程目录，单次上限 60 秒，输出自动截断）。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令字符串' },
        cwd: { type: 'string', description: '可选：工作目录（默认目标工程目录，支持相对或绝对路径）' },
        timeoutSec: { type: 'integer', description: '可选：超时秒数（默认 60，最大 60）' },
      },
      required: ['command'],
    },
  },
};

function runDirectCommandAsync(workDir, args, signal) {
  return new Promise((resolveCmd) => {
    const command = String(args.command || '').trim();
    if (!command) {
      resolveCmd({ ok: false, error: 'command 不能为空' });
      return;
    }
    let cwd = resolve(workDir);
    if (args.cwd && String(args.cwd).trim()) {
      const candidate = resolve(cwd, String(args.cwd).trim());
      if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
        resolveCmd({ ok: false, error: `工作目录不存在: ${candidate}` });
        return;
      }
      cwd = candidate;
    }
    if (signal?.aborted) {
      resolveCmd({ ok: false, aborted: true, error: '命令执行前任务已中止' });
      return;
    }

    const timeoutMs = Math.min(
      Math.max(1000, (Number(args.timeoutSec) || 60) * 1000),
      MAX_CMD_TIMEOUT_MS
    );

    const isWin = process.platform === 'win32';
    const shellCmd = isWin ? 'powershell.exe' : '/bin/sh';
    const shellArgs = isWin
      ? ['-NoProfile', '-NonInteractive', '-Command', command]
      : ['-c', command];
    const child = spawn(shellCmd, shellArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: !isWin,
      env: { ...process.env, NO_COLOR: '1' },
    });

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let aborted = false;

    const onAbort = () => {
      aborted = true;
      killSubprocessTree(child.pid, child);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      killSubprocessTree(child.pid, child);
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (Buffer.byteLength(stdout, 'utf8') < MAX_CMD_STDOUT_BYTES) {
        stdout += chunk;
      } else {
        stdoutTruncated = true;
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (Buffer.byteLength(stderr, 'utf8') < MAX_CMD_STDERR_BYTES) {
        stderr += chunk;
      } else {
        stderrTruncated = true;
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolveCmd({ ok: false, error: `启动命令失败: ${err.message}` });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (stdoutTruncated) stdout = stdout.slice(0, MAX_CMD_STDOUT_BYTES) + '\n... (stdout 已截断)';
      if (stderrTruncated) stderr = stderr.slice(0, MAX_CMD_STDERR_BYTES) + '\n... (stderr 已截断)';
      if (aborted) {
        resolveCmd({ ok: false, aborted: true, exitCode: code, stdout, stderr, error: '命令已被用户中止' });
        return;
      }
      if (timedOut) {
        resolveCmd({
          ok: false,
          timedOut: true,
          exitCode: code,
          stdout,
          stderr,
          error: `命令执行超时 (${(timeoutMs / 1000).toFixed(0)}s) 已自动终止`,
        });
        return;
      }
      resolveCmd({
        ok: code === 0,
        exitCode: code,
        cwd,
        stdout,
        stderr,
      });
    });
  });
}

export function executeShadowTool(workDir, sandbox, name, rawArgs) {
  let args = {};
  if (typeof rawArgs === 'string') {
    try {
      args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    } catch (err) {
      return { ok: false, error: `工具参数 JSON 解析失败: ${err.message}` };
    }
  } else if (rawArgs && typeof rawArgs === 'object') {
    args = rawArgs;
  }

  const isDirect = sandbox === 'turbo-direct';
  const canWrite = sandbox === 'workspace-write' || isDirect;

  if (WRITE_TOOL_NAMES.has(name) && !canWrite) {
    return {
      ok: false,
      error: `权限拒绝：当前为 ${sandbox} 只读沙箱，禁止执行写操作工具 ${name}`,
    };
  }

  if (name === 'run_command' && !isDirect) {
    return {
      ok: false,
      error: '权限拒绝：run_command 仅在 turbo-direct 模式下开放',
    };
  }

  const resolvePath = (p, opts = {}) =>
    isDirect
      ? resolveDirectToolPath(workDir, p, {
          allowMissingLeaf: Boolean(opts.allowMissingLeaf),
          allowExternal: Boolean(opts.allowExternal),
        })
      : resolveSafeShadowPath(workDir, p, { allowMissingLeaf: Boolean(opts.allowMissingLeaf) });

  try {
    const rootReal = realpathNative(workDir);

    if (name === 'list_files') {
      const subDir = args.dir && args.dir !== '.' ? args.dir : '.';
      const base =
        subDir === '.'
          ? { absPath: rootReal, relPosix: '' }
          : resolvePath(subDir, { allowMissingLeaf: false, allowExternal: true });
      if (!statSync(base.absPath).isDirectory()) {
        return { ok: false, error: `目标路径不是目录: ${subDir}` };
      }
      const maxDepth = Math.max(1, Math.min(Number(args.maxDepth) || 6, 12));
      const maxEntries = Math.max(1, Math.min(Number(args.maxEntries) || 200, 500));
      const results = [];
      let truncated = false;

      function walk(absDir, relPrefix, depth) {
        if (depth > maxDepth || truncated) return;
        let ents;
        try {
          ents = readdirSync(absDir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of ents) {
          if (results.length >= maxEntries) {
            truncated = true;
            return;
          }
          if (e.name.toLowerCase() === '.git' || e.name.toLowerCase() === 'node_modules') continue;
          const childAbs = join(absDir, e.name);
          let lst;
          try {
            lst = lstatSync(childAbs);
          } catch {
            continue;
          }
          if (lst.isSymbolicLink()) continue;
          if (!isDirect) {
            try {
              if (!isSameOrInsideRealPath(rootReal, realpathNative(childAbs))) continue;
            } catch {
              continue;
            }
          }
          const childRel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
          if (lst.isDirectory()) {
            walk(childAbs, childRel, depth + 1);
          } else if (lst.isFile()) {
            results.push(childRel);
          }
        }
      }

      walk(base.absPath, base.relPosix, 1);
      return { ok: true, count: results.length, truncated, files: results };
    }

    if (name === 'search_text') {
      const query = String(args.query || '');
      if (!query) return { ok: false, error: 'query 不能为空' };
      const subDir = args.dir && args.dir !== '.' ? args.dir : '.';
      const base =
        subDir === '.'
          ? { absPath: rootReal, relPosix: '' }
          : resolvePath(subDir, { allowMissingLeaf: false, allowExternal: true });
      if (!statSync(base.absPath).isDirectory()) {
        return { ok: false, error: `目标路径不是目录: ${subDir}` };
      }
      const maxResults = Math.max(1, Math.min(Number(args.maxResults) || 40, 100));
      const needle = query.toLowerCase();
      const matches = [];

      function walkSearch(absDir, relPrefix) {
        if (matches.length >= maxResults) return;
        let ents;
        try {
          ents = readdirSync(absDir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of ents) {
          if (matches.length >= maxResults) return;
          if (e.name.toLowerCase() === '.git' || e.name.toLowerCase() === 'node_modules') continue;
          const childAbs = join(absDir, e.name);
          let lst;
          try {
            lst = lstatSync(childAbs);
          } catch {
            continue;
          }
          if (lst.isSymbolicLink()) continue;
          if (!isDirect) {
            try {
              if (!isSameOrInsideRealPath(rootReal, realpathNative(childAbs))) continue;
            } catch {
              continue;
            }
          }
          const childRel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
          if (lst.isDirectory()) {
            walkSearch(childAbs, childRel);
          } else if (lst.isFile() && lst.size <= 512 * 1024) {
            const buf = readFileSync(childAbs);
            if (isBinaryBuffer(buf)) continue;
            const lines = buf.toString('utf8').split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(needle)) {
                matches.push(`${childRel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
                if (matches.length >= maxResults) return;
              }
            }
          }
        }
      }

      walkSearch(base.absPath, base.relPosix);
      return { ok: true, count: matches.length, matches };
    }

    if (name === 'read_file') {
      const { absPath, relPosix } = resolvePath(args.path, {
        allowMissingLeaf: false,
        allowExternal: true,
      });
      const lst = lstatNoThrow(absPath);
      if (!lst || lst.isDirectory()) {
        return { ok: false, error: `无法读取目录或不存在的路径: ${relPosix}` };
      }
      if (!isDirect && lst.isSymbolicLink()) {
        return { ok: false, error: `路径越界拦截：禁止读取符号链接 (${relPosix})` };
      }
      const buf = readFileSync(absPath);
      if (isBinaryBuffer(buf)) {
        return { ok: false, error: `文件 ${relPosix} 是二进制文件，无法按文本读取` };
      }
      const allLines = buf.toString('utf8').split(/\r?\n/);
      const totalLines = allLines.length;
      const start = Math.max(1, Number(args.startLine) || 1);
      const requestedEnd = args.endLine ? Number(args.endLine) : start + MAX_READ_LINES - 1;
      const end = Math.min(totalLines, start + MAX_READ_LINES - 1, requestedEnd);

      const outLines = [];
      let usedBytes = 0;
      let truncated = end < totalLines;
      for (let i = start; i <= end; i++) {
        const lineStr = `${i}: ${allLines[i - 1]}`;
        const bytes = Buffer.byteLength(lineStr, 'utf8') + 1;
        if (usedBytes + bytes > MAX_READ_BYTES) {
          truncated = true;
          break;
        }
        outLines.push(lineStr);
        usedBytes += bytes;
      }
      return {
        ok: true,
        path: relPosix,
        totalLines,
        startLine: start,
        returnedLines: outLines.length,
        truncated,
        content: outLines.join('\n'),
      };
    }

    if (name === 'write_file') {
      const { absPath, relPosix } = resolvePath(args.path, {
        allowMissingLeaf: true,
        allowExternal: false,
      });
      const content = String(args.content ?? '');
      mkdirSync(dirname(absPath), { recursive: true });
      // TOCTOU re-verification immediately before write
      const finalChecked = assertRealPathInsideRoot(rootReal, absPath, {
        allowMissingLeaf: true,
        rejectSymlink: true,
        label: isDirect ? '目标工程目录' : '影子工作区',
      });
      writeFileSync(finalChecked.absPath, content, 'utf8');
      return {
        ok: true,
        path: relPosix,
        bytesWritten: Buffer.byteLength(content, 'utf8'),
      };
    }

    if (name === 'edit_file') {
      const { absPath, relPosix } = resolvePath(args.path, {
        allowMissingLeaf: false,
        allowExternal: false,
      });
      const lst = lstatNoThrow(absPath);
      if (!lst || lst.isDirectory() || lst.isSymbolicLink()) {
        return { ok: false, error: `路径越界拦截：不允许编辑目录或符号链接 (${relPosix})` };
      }
      const oldText = String(args.old_text ?? '');
      const newText = String(args.new_text ?? '');
      if (!oldText) return { ok: false, error: 'old_text 不能为空' };
      const cur = readFileSync(absPath, 'utf8');
      const count = cur.split(oldText).length - 1;
      if (count === 0) {
        return { ok: false, error: `未在 ${relPosix} 中找到指定的 old_text 片段` };
      }
      if (count > 1 && !args.replace_all) {
        return {
          ok: false,
          error: `在 ${relPosix} 中找到 ${count} 处匹配，请提供更多上下文或传 replace_all=true`,
        };
      }
      const next = args.replace_all ? cur.split(oldText).join(newText) : cur.replace(oldText, newText);
      writeFileSync(absPath, next, 'utf8');
      return { ok: true, path: relPosix, replacements: args.replace_all ? count : 1 };
    }

    if (name === 'delete_file') {
      const { absPath, relPosix } = resolvePath(args.path, {
        allowMissingLeaf: false,
        allowExternal: false,
      });
      const lst = lstatNoThrow(absPath);
      if (!lst || lst.isDirectory() || lst.isSymbolicLink()) {
        return { ok: false, error: `delete_file 不允许删除目录或符号链接: ${relPosix}` };
      }
      unlinkSync(absPath);
      return { ok: true, path: relPosix, deleted: true };
    }

    return { ok: false, error: `未知工具: ${name}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function executeToolAsync(workDir, sandboxOrPerms, name, rawArgs, signal = null) {
  const perms =
    sandboxOrPerms && typeof sandboxOrPerms === 'object'
      ? normalizePermissions(sandboxOrPerms, 'workspace-write')
      : permissionsFromSandbox(String(sandboxOrPerms || 'workspace-write'));
  const resolvedSandbox = permissionsToSandbox(perms);

  if (name === 'run_command') {
    if (perms.fileScope !== 'direct') {
      return { ok: false, error: '权限拒绝：run_command 仅在 turbo-direct（原目录不限）模式下开放' };
    }
    if (perms.commandPolicy === 'disabled') {
      return { ok: false, error: '权限拒绝：当前命令执行策略为禁止，无法运行 run_command' };
    }
    let args = {};
    if (typeof rawArgs === 'string') {
      try {
        args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
      } catch (err) {
        return { ok: false, error: `工具参数 JSON 解析失败: ${err.message}` };
      }
    } else if (rawArgs && typeof rawArgs === 'object') {
      args = rawArgs;
    }
    return runDirectCommandAsync(workDir, args, signal);
  }
  return executeShadowTool(workDir, resolvedSandbox, name, rawArgs);
}

// ---------------------------------------------------------------------------
// Streaming SSE / JSON Fallback Client
// ---------------------------------------------------------------------------

async function callChatCompletion({
  endpoint,
  apiKey,
  model,
  messages,
  tools,
  signal,
  onConnected,
  onFirstReasoning,
  onContentDelta,
  onReasoningChunk,
}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream, application/json',
    Connection: 'keep-alive',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const body = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new Error(redactSecrets(err?.message || String(err), [apiKey]));
  }

  if (!res.ok) {
    let errBody = '';
    try {
      errBody = redactSecrets((await res.text()).slice(0, 600), [apiKey]);
    } catch {
      // ignore
    }
    if (res.status === 400 && /stream_options/i.test(errBody)) {
      delete body.stream_options;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        throw new Error(redactSecrets(err?.message || String(err), [apiKey]));
      }
      if (!res.ok) {
        let retryErr = '';
        try {
          retryErr = redactSecrets((await res.text()).slice(0, 600), [apiKey]);
        } catch {
          // ignore
        }
        throw new Error(
          redactSecrets(
            `HTTP ${res.status} ${res.statusText}${retryErr ? `: ${retryErr}` : ''}`,
            [apiKey]
          )
        );
      }
    } else {
      throw new Error(
        redactSecrets(`HTTP ${res.status} ${res.statusText}${errBody ? `: ${errBody}` : ''}`, [
          apiKey,
        ])
      );
    }
  }

  if (onConnected) onConnected();

  const ctype = (res.headers.get('content-type') || '').toLowerCase();

  // Non-streaming JSON fallback (for proxies/models that ignore stream:true)
  if (ctype.includes('application/json')) {
    const data = await res.json();
    const msg = data?.choices?.[0]?.message || {};
    const content = typeof msg.content === 'string' ? msg.content : '';
    const reasoning =
      typeof msg.reasoning_content === 'string'
        ? msg.reasoning_content
        : typeof msg.reasoning === 'string'
          ? msg.reasoning
          : '';
    if (reasoning) {
      if (onFirstReasoning) onFirstReasoning();
      if (onReasoningChunk) onReasoningChunk(reasoning);
    }
    if (content && onContentDelta) onContentDelta(content);
    return {
      content,
      reasoning,
      toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
      usage: data?.usage || null,
    };
  }

  // SSE stream reader
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let content = '';
  let reasoning = '';
  let reasoningPending = '';
  let sawReasoning = false;
  let usage = null;
  const toolMap = new Map(); // index -> { id, type, function: { name, arguments } }

  function flushReasoning(force = false) {
    if (!reasoningPending) return;
    if (force || reasoningPending.length >= 160 || reasoningPending.includes('\n')) {
      if (onReasoningChunk) onReasoningChunk(reasoningPending.trim());
      reasoningPending = '';
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;

      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }

      if (parsed.usage) usage = parsed.usage;
      const choice = parsed.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || choice.message || {};

      const rDelta =
        typeof delta.reasoning_content === 'string'
          ? delta.reasoning_content
          : typeof delta.reasoning === 'string'
            ? delta.reasoning
            : '';
      if (rDelta) {
        if (!sawReasoning) {
          sawReasoning = true;
          if (onFirstReasoning) onFirstReasoning();
        }
        reasoning += rDelta;
        reasoningPending += rDelta;
        flushReasoning(false);
      }

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        flushReasoning(true);
        content += delta.content;
        if (onContentDelta) onContentDelta(content);
      }

      if (Array.isArray(delta.tool_calls)) {
        flushReasoning(true);
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? toolMap.size;
          if (!toolMap.has(idx)) {
            toolMap.set(idx, {
              id: tc.id || `call_${idx}_${randomUUID().slice(0, 6)}`,
              type: 'function',
              function: { name: '', arguments: '' },
            });
          }
          const slot = toolMap.get(idx);
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.function.name += tc.function.name;
          if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
        }
      }
    }
  }

  flushReasoning(true);
  const toolCalls = Array.from(toolMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);

  return { content, reasoning, toolCalls, usage };
}

// ---------------------------------------------------------------------------
// OpenAI-Compatible Runner
// ---------------------------------------------------------------------------

export class OpenAiRunner {
  constructor(store) {
    this.store = store;
    this.runningJobs = new Map(); // jobId -> { controller }
    this.waiters = new Map(); // jobId -> Set<resolveFn>
  }

  hasRunningJob(jobId) {
    return this.runningJobs.has(jobId);
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
    return new Promise((resolve) => {
      let set = this.waiters.get(jobId);
      if (!set) {
        set = new Set();
        this.waiters.set(jobId, set);
      }
      const timer = setTimeout(() => {
        set.delete(onDone);
        resolve(this.store.getJob(jobId));
      }, Math.min(timeoutSec, 180) * 1000);

      const onDone = (finishedJob) => {
        clearTimeout(timer);
        resolve(finishedJob);
      };
      set.add(onDone);
    });
  }

  async testConnection({ baseUrl, apiKey, model, existingPersonaId = '', clearApiKey = false }) {
    let effectiveKey = String(apiKey || '').trim();
    if (!effectiveKey && !clearApiKey && existingPersonaId) {
      const saved = this.store.getPersona(existingPersonaId);
      effectiveKey = String(saved?.apiKey || '').trim();
    }
    const endpoint = resolveChatCompletionsUrl(baseUrl);
    const effectiveModel = String(model || '').trim();
    if (!effectiveModel) {
      throw new Error('请先填写 Model 模型名称');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const start = Date.now();
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (effectiveKey) headers.Authorization = `Bearer ${effectiveKey}`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: effectiveModel,
          messages: [{ role: 'user', content: 'Reply with OK' }],
          max_tokens: 16,
          stream: false,
        }),
        signal: controller.signal,
      });
      const latencyMs = Date.now() - start;
      const secrets = [effectiveKey, ...this.store.getKnownSecrets()];
      if (!res.ok) {
        const errText = redactSecrets((await res.text().catch(() => '')).slice(0, 400), secrets);
        return {
          ok: false,
          latencyMs,
          endpoint,
          model: effectiveModel,
          error: redactSecrets(
            `HTTP ${res.status} ${res.statusText}${errText ? `: ${errText}` : ''}`,
            secrets
          ),
        };
      }
      const data = await res.json().catch(() => ({}));
      const reply = redactSecrets(
        String(data?.choices?.[0]?.message?.content || '').trim().slice(0, 120),
        secrets
      );
      return {
        ok: true,
        latencyMs,
        endpoint,
        model: data?.model || effectiveModel,
        replyPreview: reply || '(连接正常)',
      };
    } catch (err) {
      const secrets = [effectiveKey, ...this.store.getKnownSecrets()];
      return {
        ok: false,
        latencyMs: Date.now() - start,
        endpoint,
        model: effectiveModel,
        error:
          err.name === 'AbortError'
            ? '连接超时 (15s)'
            : redactSecrets(err.message || String(err), secrets),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  _setStage(job, stage, stageLabel) {
    job.stage = stage;
    job.stageLabel = stageLabel;
    this.store.scheduleSave();
  }

  /**
   * Non-tool one-shot completion for session context compression / summarization.
   */
  async runOneShotCompletion(persona, promptText, { timeoutMs = 45_000 } = {}) {
    const endpoint = resolveChatCompletionsUrl(persona.baseUrl);
    const model = String(persona.model || '').trim();
    if (!model) throw new Error('该 API 人物卡未填写模型名');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const turn = await callChatCompletion({
        endpoint,
        apiKey: String(persona.apiKey || '').trim(),
        model,
        messages: [
          {
            role: 'system',
            content:
              '你是专业的工程上下文压缩助手，擅长提炼高密度、结构化、忠于原文的技术交接摘要。只输出摘要正文，不加客套话。',
          },
          { role: 'user', content: String(promptText || '') },
        ],
        tools: [],
        signal: controller.signal,
      });
      const text = String(turn.content || '').trim();
      if (!text) throw new Error('模型返回了空摘要');
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Returns IMMEDIATELY (< 50ms) with { job, session, shadow }.
   * Shadow preparation and streaming API execution run asynchronously on backend.
   */
  startJob({
    sourceDir,
    prompt,
    persona,
    session = null,
    sandbox = '',
    permissions = null,
    model = '',
    createdBy = 'hakimi',
    title = '',
    attachments = [],
    shadowLimits = {},
  }) {
    const endpoint = resolveChatCompletionsUrl(persona.baseUrl);
    const effectiveModel = String(model || session?.model || persona.model).trim();
    if (!effectiveModel) {
      throw new Error('请先为 OpenAI 兼容 API 人物卡配置模型名 (model)');
    }

    const rawSourceDir = String(sourceDir || session?.sourceDir || '').trim();
    if (!rawSourceDir) {
      throw new Error('请指定目标工程目录 sourceDir');
    }
    const absSourceDir = resolve(rawSourceDir);
    if (!existsSync(absSourceDir) || !statSync(absSourceDir).isDirectory()) {
      throw new Error(`源工程目录不存在或不是文件夹: ${absSourceDir}`);
    }

    const effectivePerms = permissions
      ? normalizePermissions(permissions, sandbox || persona.defaultSandbox)
      : VALID_SANDBOXES.includes(sandbox)
        ? permissionsFromSandbox(sandbox)
        : normalizePermissions(persona.permissions, persona.defaultSandbox);
    const effectiveSandbox = permissionsToSandbox(effectivePerms);
    const isDirect = effectivePerms.fileScope === 'direct';
    const effectiveToolMode = persona.toolMode === 'chat' ? 'chat' : 'agent';

    const msgAttachments = Array.isArray(attachments)
      ? attachments.map((a) => ({
          id: a.id,
          name: a.name,
          mime: a.mime,
          previewDataUrl: a.previewDataUrl || '',
        }))
      : [];

    const existingShadow =
      !isDirect && session?.shadowId ? this.store.getShadow(session.shadowId) : null;
    const reusableShadow =
      existingShadow && existingShadow.status !== 'discarded' && existsSync(existingShadow.workDir)
        ? existingShadow
        : null;

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
        provider: 'openai-compatible',
        title: autoTitle,
        sourceDir: absSourceDir,
        shadowId: reusableShadow ? reusableShadow.id : null,
        model: effectiveModel,
        reasoningEffort: '',
      });
    } else {
      session.provider = 'openai-compatible';
      session.model = effectiveModel;
      session.updatedAt = Date.now();
    }

    const needsShadow = !isDirect && !reusableShadow;
    const jobId = `job-${randomUUID().slice(0, 12)}`;
    const job = this.store.addJob({
      id: jobId,
      sessionId: session.id,
      personaId: persona.id,
      personaName: persona.name,
      provider: 'openai-compatible',
      createdBy: createdBy === 'boss' ? 'boss' : 'hakimi',
      sourceDir: absSourceDir,
      shadowId: isDirect ? null : reusableShadow ? reusableShadow.id : null,
      shadowWorkDir: isDirect ? absSourceDir : reusableShadow ? reusableShadow.workDir : null,
      directMode: isDirect,
      directSummary: null,
      sandbox: effectiveSandbox,
      permissions: effectivePerms,
      model: effectiveModel,
      reasoningEffort: '',
      toolMode: effectiveToolMode,
      prompt: String(prompt),
      status: 'running',
      stage: needsShadow ? 'preparing_shadow' : 'starting_engine',
      stageLabel: needsShadow
        ? '准备隔离副本'
        : isDirect
          ? '启动引擎（Turbo 直通）'
          : '启动引擎',
      codexThreadId: null,
      resumed: Array.isArray(session.openaiMessages) && session.openaiMessages.length > 0,
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
    this.runningJobs.set(job.id, { controller });

    setImmediate(() => {
      this._executeLoop({
        job,
        session,
        reusableShadow,
        absSourceDir,
        isDirect,
        shadowLimits,
        persona,
        endpoint,
        model: effectiveModel,
        sandbox: effectiveSandbox,
        permissions: effectivePerms,
        toolMode: effectiveToolMode,
        prompt: String(prompt),
        attachments: Array.isArray(attachments) ? attachments : [],
        controller,
      });
    });

    return { job, session, shadow: reusableShadow };
  }

  async _executeLoop({
    job,
    session,
    reusableShadow,
    absSourceDir,
    isDirect = false,
    shadowLimits,
    persona,
    endpoint,
    model,
    sandbox,
    permissions,
    toolMode,
    prompt,
    attachments = [],
    controller,
  }) {
    let shadow = isDirect ? null : reusableShadow;
    let lastContent = '';
    let aggUsage = null;
    let failedError = null;

    try {
      // Stage 1: Prepare shadow workspace asynchronously if needed (skipped in turbo-direct)
      if (!isDirect && !shadow) {
        this._setStage(job, 'preparing_shadow', '准备隔离副本');
        this.store.appendJobEvent(job, 'system', `正在为 ${absSourceDir} 准备隔离影子副本...`);
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
      }

      if (controller.signal.aborted || job.status === 'aborted') {
        return;
      }

      const activeWorkDir = isDirect ? absSourceDir : shadow.workDir;

      // Stage 2: Launch OpenAI-compatible HTTP stream
      this._setStage(job, 'starting_engine', isDirect ? '启动引擎（Turbo 直通）' : '启动引擎');

      const effectivePerms = normalizePermissions(permissions, sandbox);
      const canWrite = effectivePerms.fileScope === 'shadow' || isDirect;
      const canRunCmd = isDirect && effectivePerms.commandPolicy === 'auto';

      const tools =
        toolMode === 'chat'
          ? []
          : [
              ...READ_TOOLS,
              ...(canWrite ? WRITE_TOOLS : []),
              ...(canRunCmd ? [RUN_COMMAND_TOOL] : []),
            ];

      const userProfile = this.store.getUserProfile();
      const profileBlock = composePersonaProfileBlock(persona, userProfile);
      const hadRollback = Boolean(session.pendingDiskRollbackNotice);
      if (hadRollback) {
        session.pendingDiskRollbackNotice = false;
      }
      const anchorEval = evaluateAnchorSync(session, profileBlock, prompt);
      this.store.scheduleSave();

      const sysParts = [];
      if (isDirect) {
        sysParts.push(buildDirectModeInstructions(absSourceDir));
        if (toolMode === 'agent') {
          sysParts.push(
            canRunCmd
              ? '你可以使用内置工具（list_files / search_text / read_file / write_file / edit_file / delete_file / run_command）直接操作当前工程目录、读取外部参考路径并执行本机测试或构建命令。'
              : '你可以使用内置文件工具（list_files / search_text / read_file / write_file / edit_file / delete_file）直接操作当前工程目录并读取外部参考路径；当前命令执行策略为禁止，不可运行命令。'
          );
        }
      } else {
        sysParts.push(ANTI_ESCAPE_GUARDRAIL);
        if (toolMode === 'agent') {
          sysParts.push(
            canWrite
              ? '你可以使用内置文件工具（list_files / search_text / read_file / write_file / edit_file / delete_file）在当前隔离影子副本内读写文件，所有路径必须为相对路径。'
              : '当前为只读模式：你仅可使用 list_files / search_text / read_file 查看影子副本代码，严禁修改文件。'
          );
        }
      }
      sysParts.push(profileBlock);

      const inheritedInst = buildInheritedSummaryInstruction(session.inheritedSummary);
      if (inheritedInst) sysParts.push(inheritedInst);

      // Outbound-only situational header & optional recency sync (NEVER persisted into session.openaiMessages!)
      const turnGuidanceHeader = composeTurnGuidanceHeader({
        workDir: activeWorkDir,
        permissions: effectivePerms,
        directMode: isDirect,
        hadRollback,
        inheritedSummary: session.inheritedSummary,
        isFirstTurnWithInherited: Boolean(
          session.inheritedSummary?.summary && (!session.openaiMessages || session.openaiMessages.length === 0)
        ),
      });
      const outboundUserText = composeOutboundUserPayload({
        userPrompt: prompt,
        turnGuidanceHeader,
        recencySyncBlock: anchorEval.recencySyncBlock,
      });

      // Build current user turn message (multimodal content array when image attachments present)
      const imageBlocks = [];
      for (const att of attachments) {
        if (att?.dataUrl) {
          imageBlocks.push({ type: 'image_url', image_url: { url: att.dataUrl } });
        } else if (att?.filePath && existsSync(att.filePath)) {
          try {
            const b64 = readFileSync(att.filePath).toString('base64');
            imageBlocks.push({
              type: 'image_url',
              image_url: { url: `data:${att.mime || 'image/png'};base64,${b64}` },
            });
          } catch {
            // ignore unreadable attachment
          }
        }
      }
      const currentUserMsg =
        imageBlocks.length > 0
          ? { role: 'user', content: [{ type: 'text', text: outboundUserText }, ...imageBlocks] }
          : { role: 'user', content: outboundUserText };

      const convMessages = [
        { role: 'system', content: sysParts.join('\n\n') },
        ...(Array.isArray(session.openaiMessages) ? session.openaiMessages : []),
        currentUserMsg,
      ];

      this.store.appendJobEvent(
        job,
        'system',
        `启动 ${persona.name} [API] (${model} / ${toolMode === 'chat' ? '纯对话' : isDirect ? '⚡ Turbo 直通' : sandbox})`
      );

      for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
        if (controller.signal.aborted || job.status === 'aborted') break;

        let sawContent = false;
        const turn = await callChatCompletion({
          endpoint,
          apiKey: String(persona.apiKey || '').trim(),
          model,
          messages: convMessages,
          tools,
          signal: controller.signal,
          onConnected: () => {
            if (round === 1) {
              this._setStage(job, 'executing', '思考与执行中');
              this.store.appendJobEvent(job, 'system', 'API 已连接，等待首包流式返回...');
            }
          },
          onFirstReasoning: () => {
            this._setStage(job, 'thinking', '正在深度思考...');
          },
          onContentDelta: (partial) => {
            if (!sawContent) {
              sawContent = true;
              this._setStage(job, 'executing', '正在输出回复...');
            }
            job.liveReply = partial;
            this.store.scheduleSave();
          },
          onReasoningChunk: (chunk) => {
            if (chunk) {
              this.store.appendJobEvent(job, 'reasoning', chunk.slice(0, 320));
            }
          },
        });

        if (turn.usage) {
          const cachedHit = Number(
            turn.usage.prompt_cache_hit_tokens ??
              turn.usage.prompt_tokens_details?.cached_tokens ??
              turn.usage.cached_input_tokens ??
              0
          ) || 0;
          aggUsage = {
            input_tokens:
              (aggUsage?.input_tokens || 0) +
              (turn.usage.prompt_tokens ?? turn.usage.input_tokens ?? 0),
            output_tokens:
              (aggUsage?.output_tokens || 0) +
              (turn.usage.completion_tokens ?? turn.usage.output_tokens ?? 0),
            cached_input_tokens: (aggUsage?.cached_input_tokens || 0) + cachedHit,
          };
          job.usage = aggUsage;

          // Record LAST round's usage as the accurate topic context window occupancy
          const ctxUsage = buildOpenAiContextUsage(turn.usage, persona);
          if (ctxUsage) {
            session.contextUsage = ctxUsage;
          }
        }

        if (turn.content) {
          lastContent = turn.content;
          job.liveReply = turn.content;
        }

        if (!turn.toolCalls || turn.toolCalls.length === 0) {
          break;
        }

        convMessages.push({
          role: 'assistant',
          content: turn.content || null,
          tool_calls: turn.toolCalls,
        });

        for (const tc of turn.toolCalls) {
          if (controller.signal.aborted || job.status === 'aborted') break;
          const fnName = tc.function?.name || '';
          const fnArgs = tc.function?.arguments || '{}';
          this._setStage(job, 'executing', `执行工具 ${fnName}...`);
          this.store.appendJobEvent(job, 'command', `调用工具 ${fnName}(${String(fnArgs).slice(0, 180)})`);
          const toolOut = await executeToolAsync(
            activeWorkDir,
            effectivePerms,
            fnName,
            fnArgs,
            controller.signal
          );
          const summary = toolOut.ok
            ? `工具 ${fnName} 完成`
            : `工具 ${fnName} 拦截/报错: ${toolOut.error}`;
          this.store.appendJobEvent(job, toolOut.ok ? 'tool' : 'error', summary);

          convMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(toolOut),
          });
        }

        if (round === MAX_TOOL_ROUNDS) {
          this.store.appendJobEvent(
            job,
            'error',
            `已达到单次任务工具循环上限（${MAX_TOOL_ROUNDS} 轮），自动停止防止死循环`
          );
          if (!lastContent) {
            lastContent = `已达到最大工具调用轮数（${MAX_TOOL_ROUNDS} 轮），请查看过程日志后继续。`;
          }
        }
      }
    } catch (err) {
      if (err?.name === 'AbortError' || controller.signal.aborted || job.status === 'aborted') {
        // handled as aborted below
      } else {
        const secrets = [persona?.apiKey, ...this.store.getKnownSecrets()];
        failedError = redactSecrets(err?.message || String(err), secrets);
      }
    } finally {
      this.runningJobs.delete(job.id);
      job.finalReply = lastContent || job.liveReply || '';

      if (isDirect) {
        job.directSummary = await inspectDirectGitStatus(absSourceDir);
        job.diffSummary = null;
        job.sourceIntegrity = null;
      } else {
        // Stage 4: Ground-truth filesystem diff & source integrity verification
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
          text: `已中止本次 API 请求${job.abortReason ? `：${job.abortReason}` : ''}（不会自动重发）`,
          jobId: job.id,
        });
      } else if (failedError) {
        job.status = 'failed';
        job.stage = 'failed';
        job.stageLabel = '执行失败';
        job.error = failedError.slice(0, 1000);
        this.store.appendJobEvent(job, 'error', `API 请求失败: ${job.error.slice(0, 300)}`);
        this.store.appendSessionMessage(session.id, {
          role: 'system',
          text: `API 请求失败：${job.error.slice(0, 400)}`,
          jobId: job.id,
        });
      } else {
        job.status = 'completed';
        job.stage = 'completed';
        job.stageLabel = '已完成';
        job.exitCode = 0;
        const dur = ((job.finishedAt - job.startedAt) / 1000).toFixed(1);
        this.store.appendJobEvent(job, 'system', `执行完成（耗时 ${dur}s）`);
        this.store.appendSessionMessage(session.id, {
          role: 'assistant',
          text: job.finalReply || '（任务已完成，无文本回复）',
          jobId: job.id,
          model: job.model,
          usage: job.usage,
        });
        const historyPrompt =
          attachments.length > 0 ? `${prompt}\n[附带 ${attachments.length} 张图片]` : prompt;
        this.store.appendOpenAiHistory(session.id, historyPrompt, job.finalReply || '（已完成）');
      }

      this.store.flush();
      this._notifyWaiters(job.id, job);
    }
  }

  abortJob(jobId, reason = '用户手动中止') {
    const job = this.store.getJob(jobId);
    if (!job) throw new Error(`未找到任务: ${jobId}`);
    if (job.status !== 'running') {
      return { aborted: false, status: job.status, job };
    }
    job.status = 'aborted';
    job.abortReason = String(reason || '用户手动中止').trim();
    const active = this.runningJobs.get(job.id);
    if (active) {
      active.controller.abort();
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

  shutdownAll() {
    for (const [jobId, active] of this.runningJobs.entries()) {
      try {
        active.controller.abort();
      } catch {
        // ignore
      }
      const job = this.store.getJob(jobId);
      if (job && job.status === 'running') {
        job.status = 'needs_review';
        job.error = 'MCP Server 退出，原运行中 API 任务已安全中止（结果待核对）';
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
