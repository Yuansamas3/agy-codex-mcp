import { randomUUID } from 'node:crypto';
import {
  lstatSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const SAFE_BITMAP_DATA_URL_RE =
  /^data:image\/(?:png|jpeg|jpg|webp|gif|bmp);base64,[A-Za-z0-9+/=\s]+$/i;

const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  try {
    Atomics.wait(SLEEP_BUF, 0, 0, Math.max(1, Math.floor(ms)));
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // fallback busy wait
    }
  }
}

export function isSafeBitmapDataUrl(val) {
  if (typeof val !== 'string') return false;
  const trimmed = val.trim();
  if (!trimmed || trimmed.length > 20 * 1024 * 1024) return false;
  return SAFE_BITMAP_DATA_URL_RE.test(trimmed);
}

/**
 * Normalizes an absolute filesystem path for strict prefix boundary comparisons.
 * On Windows, normalizes drive letters and case (NTFS/FAT case-insensitive) and trims trailing slashes.
 */
export function normalizePathForCompare(absPath) {
  let norm = resolve(String(absPath || ''));
  if (process.platform === 'win32') {
    norm = norm.replace(/^[a-z]:/, (m) => m.toUpperCase()).toLowerCase();
  }
  const rootPrefix = process.platform === 'win32' ? /^[a-z]:\\$/i : /^\/$/;
  while (norm.length > 1 && !rootPrefix.test(norm) && (norm.endsWith('\\') || norm.endsWith('/'))) {
    norm = norm.slice(0, -1);
  }
  return norm;
}

/**
 * Strictly checks whether `candidateReal` is equal to or strictly inside `rootReal`.
 * Prevents sibling-prefix collisions such as `D:\proj` matching `D:\proj_evil`.
 */
export function isSameOrInsideRealPath(rootReal, candidateReal) {
  const rootNorm = normalizePathForCompare(rootReal);
  const candNorm = normalizePathForCompare(candidateReal);
  if (candNorm === rootNorm) return true;
  const boundary = rootNorm.endsWith(sep) ? rootNorm : rootNorm + sep;
  return candNorm.startsWith(boundary);
}

export function lstatNoThrow(targetPath) {
  try {
    return lstatSync(targetPath);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      return null;
    }
    throw err;
  }
}

export function realpathNative(p) {
  return realpathSync.native(resolve(p));
}

/**
 * Hard realpath + symlink/junction boundary guard.
 * - Canonicalizes `rootDir` via `fs.realpathSync.native`
 * - Rejects NUL bytes and lexical escapes
 * - Walks every existing path component from `rootReal` down to target, rejecting symlinks/junctions
 * - Verifies `fs.realpathSync.native` of the target (or deepest existing ancestor when `allowMissingLeaf`)
 *   is strictly inside `rootReal` with proper separator & drive-case normalization.
 */
export function assertRealPathInsideRoot(
  rootDir,
  targetPath,
  { allowMissingLeaf = false, rejectSymlink = true, label = '工作根目录' } = {}
) {
  if (typeof rootDir !== 'string' || !rootDir.trim()) {
    throw new Error(`路径越界拦截：${label}无效`);
  }
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    throw new Error('路径越界拦截：目标路径不能为空');
  }
  if (rootDir.includes('\0') || targetPath.includes('\0')) {
    throw new Error('路径越界拦截：包含非法 NUL 字符');
  }

  let rootReal;
  try {
    rootReal = realpathNative(rootDir);
  } catch {
    throw new Error(`路径越界拦截：${label}不存在或无法解析`);
  }

  // First evaluate lexical containment against BOTH original resolved root and canonical rootReal
  const absRootLex = resolve(rootDir);
  const absTargetInput = resolve(targetPath);
  let relFromRoot = relative(rootReal, absTargetInput);
  if (relFromRoot.startsWith('..') || isAbsolute(relFromRoot)) {
    const relFromLex = relative(absRootLex, absTargetInput);
    if (relFromLex.startsWith('..') || isAbsolute(relFromLex)) {
      throw new Error(`路径越界拦截：${targetPath} 不在${label}之内`);
    }
    relFromRoot = relFromLex;
  }

  const segments = relFromRoot
    ? relFromRoot.split(/[\\/]+/).filter((s) => s.length > 0 && s !== '.')
    : [];
  if (segments.includes('..')) {
    throw new Error(`路径越界拦截：禁止使用上级目录跳转 (${targetPath})`);
  }

  const candidate = segments.length > 0 ? resolve(rootReal, ...segments) : rootReal;
  if (!isSameOrInsideRealPath(rootReal, candidate)) {
    throw new Error(`路径越界拦截：目标路径超出${label} (${targetPath})`);
  }

  // Walk every segment from rootReal down to candidate to defeat intermediate symlinks/junctions
  // AND catch dangling leaf symlinks (which existsSync misses!).
  let cursor = rootReal;
  let lastExisting = rootReal;
  let missingEncountered = false;

  for (let i = 0; i < segments.length; i++) {
    cursor = join(cursor, segments[i]);
    const st = lstatNoThrow(cursor);
    if (!st) {
      missingEncountered = true;
      break;
    }
    if (rejectSymlink && st.isSymbolicLink()) {
      throw new Error(`路径越界拦截：禁止通过符号链接或目录联接访问 (${targetPath})`);
    }
    const stepReal = realpathNative(cursor);
    if (!isSameOrInsideRealPath(rootReal, stepReal)) {
      throw new Error(`路径越界拦截：真实物理路径逃逸出${label} (${targetPath})`);
    }
    lastExisting = stepReal;
  }

  if (!missingEncountered) {
    const leafStat = lstatNoThrow(candidate);
    if (!leafStat) {
      if (!allowMissingLeaf) {
        throw new Error(`文件或目录不存在: ${targetPath}`);
      }
      return { absPath: candidate, rootReal, exists: false, stat: null };
    }
    if (rejectSymlink && leafStat.isSymbolicLink()) {
      throw new Error(`路径越界拦截：禁止通过符号链接或目录联接访问 (${targetPath})`);
    }
    const targetReal = realpathNative(candidate);
    if (!isSameOrInsideRealPath(rootReal, targetReal)) {
      throw new Error(`路径越界拦截：真实物理路径逃逸出${label} (${targetPath})`);
    }
    return { absPath: targetReal, rootReal, exists: true, stat: leafStat };
  }

  if (!allowMissingLeaf) {
    throw new Error(`文件或目录不存在: ${targetPath}`);
  }

  // Verify deepest existing ancestor stays strictly inside rootReal
  const ancestorReal = realpathNative(lastExisting);
  if (!isSameOrInsideRealPath(rootReal, ancestorReal)) {
    throw new Error(`路径越界拦截：父目录真实路径逃逸出${label} (${targetPath})`);
  }

  return { absPath: candidate, rootReal, exists: false, stat: null };
}

/**
 * Redacts all known secrets and common Bearer / API key token formats from arbitrary text
 * so credentials can NEVER leak into error messages, UI logs, job_logs, or model tool outputs.
 */
export function redactSecrets(input, knownSecrets = []) {
  let out = String(input ?? '');
  if (!out) return out;

  if (Array.isArray(knownSecrets)) {
    for (const raw of knownSecrets) {
      const secret = String(raw || '').trim();
      if (secret.length >= 6) {
        out = out.split(secret).join('[REDACTED]');
      }
    }
  }

  out = out
    .replace(/(Authorization\s*[:=]\s*Bearer\s+)[^\s'",;}\]]+/gi, '$1[REDACTED]')
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]')
    .replace(/\bsk-(?:proj-|ant-|or-v1-)?[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(
      /(\b(?:api[_-]?key|x-api-key|secret[_-]?key)\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{8,}(["']?)/gi,
      '$1[REDACTED]$2'
    );

  return out;
}

/**
 * Atomic file write with short retry backoff on transient Windows EPERM / EBUSY / EACCES locks.
 */
export function atomicWriteFileSync(targetPath, content, { maxRetries = 6 } = {}) {
  const tmp = `${targetPath}.tmp-${process.pid}-${Date.now()}-${randomUUID().slice(0, 6)}`;
  writeFileSync(tmp, content, 'utf8');
  const delays = [15, 30, 60, 100, 150, 220];
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      renameSync(tmp, targetPath);
      return;
    } catch (err) {
      lastErr = err;
      const code = err?.code;
      const retryable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (!retryable || attempt >= maxRetries) {
        break;
      }
      sleepSync(delays[Math.min(attempt, delays.length - 1)]);
    }
  }
  try {
    unlinkSync(tmp);
  } catch {
    // ignore cleanup error
  }
  throw lastErr;
}
