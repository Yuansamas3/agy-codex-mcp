import { execFile, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  assertRealPathInsideRoot,
  isSameOrInsideRealPath,
  lstatNoThrow,
  normalizePathForCompare,
  realpathNative,
} from './security.mjs';

const execFileAsync = promisify(execFile);

export const DEFAULT_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'target',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.idea',
  '.vs',
  '.vscode',
  'out',
  'coverage',
  'bin',
  'obj',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.gradle',
  '.sidedesk-shadow',
]);

export const DEFAULT_SHADOW_LIMITS = {
  maxFiles: 5000,
  maxBytes: 200 * 1024 * 1024, // 200 MB
};

export class ShadowLimitError extends Error {
  constructor(message, stats) {
    super(message);
    this.name = 'ShadowLimitError';
    this.stats = stats;
  }
}

function toPosixRel(relPath) {
  return relPath.split(sep).join('/');
}

export function assertInsideRoot(rootDir, targetPath, opts = {}) {
  const checked = assertRealPathInsideRoot(rootDir, targetPath, {
    allowMissingLeaf: true,
    rejectSymlink: true,
    ...opts,
  });
  return checked.absPath;
}

export function sha256File(filePath) {
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return hash.digest('hex');
}

function findGitExecutable() {
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    const r = spawnSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true });
    const first = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return first || 'git';
  }
  const r = spawnSync('which', ['git'], { encoding: 'utf8' });
  const first = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  if (first && existsSync(first)) return first;
  for (const c of ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git']) {
    if (existsSync(c)) return c;
  }
  return 'git';
}

const GIT_EXE = findGitExecutable();

function runGit(cwd, args) {
  return spawnSync(GIT_EXE, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

async function runGitAsync(cwd, args) {
  try {
    const { stdout, stderr } = await execFileAsync(GIT_EXE, args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { status: 0, stdout: stdout || '', stderr: stderr || '' };
  } catch (err) {
    return {
      status: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout || '',
      stderr: err.stderr || err.message || '',
    };
  }
}

/**
 * Fast pre-scan with hard circuit breaker (maxFiles & maxBytes).
 * Skips heavy build/dependency directories and ALL symlinks/junctions.
 */
export function prescanSourceDir(sourceDir, opts = {}) {
  const rawAbs = resolve(sourceDir);
  if (!existsSync(rawAbs) || !statSync(rawAbs).isDirectory()) {
    throw new Error(`源工程目录不存在或不是文件夹: ${rawAbs}`);
  }
  const absSource = realpathNative(rawAbs);

  const maxFiles = opts.maxFiles ?? DEFAULT_SHADOW_LIMITS.maxFiles;
  const maxBytes = opts.maxBytes ?? DEFAULT_SHADOW_LIMITS.maxBytes;
  const skipDirs = opts.skipDirs ?? DEFAULT_SKIP_DIRS;

  const files = []; // { relPosix, absPath, size }
  const skippedDirs = [];
  const skippedSymlinks = [];
  let totalBytes = 0;

  function walk(currentAbs, relPrefix) {
    let entries;
    try {
      entries = readdirSync(currentAbs, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const childAbs = join(currentAbs, entry.name);
      const childRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

      let lst;
      try {
        lst = lstatSync(childAbs);
      } catch {
        continue;
      }

      // Never follow symlinks or Windows junctions
      if (lst.isSymbolicLink()) {
        skippedSymlinks.push(childRel);
        continue;
      }

      // Verify physical realpath stays strictly inside absSource (defeats Windows mount points / junctions)
      let childReal;
      try {
        childReal = realpathNative(childAbs);
      } catch {
        skippedSymlinks.push(childRel);
        continue;
      }
      if (!isSameOrInsideRealPath(absSource, childReal)) {
        skippedSymlinks.push(childRel);
        continue;
      }

      if (lst.isDirectory()) {
        if (skipDirs.has(entry.name.toLowerCase())) {
          skippedDirs.push(childRel);
          continue;
        }
        walk(childReal, childRel);
        continue;
      }

      if (lst.isFile()) {
        const size = lst.size || 0;
        totalBytes += size;
        files.push({ relPosix: childRel, absPath: childReal, size });

        if (files.length > maxFiles) {
          throw new ShadowLimitError(
            `影子副本安全熔断：扫描到可复制文件数超过上限 ${maxFiles} 个（当前已扫 ${files.length} 个，体积 ${(totalBytes / 1024 / 1024).toFixed(1)} MB）。为防止卡死磁盘已阻断拷贝，请选择更小的子工程目录。`,
            { fileCount: files.length, totalBytes, maxFiles, maxBytes }
          );
        }
        if (totalBytes > maxBytes) {
          throw new ShadowLimitError(
            `影子副本安全熔断：可复制源码体积超过上限 ${(maxBytes / 1024 / 1024).toFixed(0)} MB（当前已扫 ${(totalBytes / 1024 / 1024).toFixed(1)} MB，共 ${files.length} 个文件）。为防止卡死磁盘已阻断拷贝，请检查大体积资源或选择更小的子工程目录。`,
            { fileCount: files.length, totalBytes, maxFiles, maxBytes }
          );
        }
      }
    }
  }

  walk(absSource, '');

  return {
    sourceDir: absSource,
    files,
    fileCount: files.length,
    totalBytes,
    skippedDirs,
    skippedSymlinks,
  };
}

function initLocalBaselineGit(workDir) {
  const r1 = runGit(workDir, ['init', '-q']);
  if (r1.status !== 0) {
    throw new Error(`影子副本初始化本地 git 基线失败: ${r1.stderr || r1.stdout}`);
  }
  runGit(workDir, ['config', 'user.name', 'sidedesk-shadow']);
  runGit(workDir, ['config', 'user.email', 'shadow@sidedesk.local']);
  runGit(workDir, ['config', 'core.autocrlf', 'false']);
  runGit(workDir, ['config', 'core.quotepath', 'false']);
  runGit(workDir, ['add', '-A', '--', '.']);
  const r2 = runGit(workDir, ['commit', '--allow-empty', '-q', '-m', 'sidedesk-baseline']);
  if (r2.status !== 0) {
    throw new Error(`影子副本提交基线失败: ${r2.stderr || r2.stdout}`);
  }
}

/**
 * Create an isolated shadow workspace copy with baseline sha256 manifest + local git baseline.
 */
export function createShadowCopy(store, sourceDir, opts = {}) {
  const scan = prescanSourceDir(sourceDir, opts);
  const shadowId = `sh-${randomUUID().slice(0, 12)}`;
  const shadowRoot = join(store.shadowsDir, shadowId);
  const workDir = join(shadowRoot, 'work');
  const manifestFile = join(shadowRoot, 'manifest.json');

  mkdirSync(workDir, { recursive: true });

  const baselineFiles = {};
  for (const f of scan.files) {
    // Re-verify source file right before copy (TOCTOU symlink defense)
    const srcChecked = assertRealPathInsideRoot(scan.sourceDir, f.absPath, {
      allowMissingLeaf: false,
      rejectSymlink: true,
      label: '源工程目录',
    });
    if (!srcChecked.stat?.isFile()) continue;
    const destAbs = assertInsideRoot(workDir, join(workDir, ...f.relPosix.split('/')));
    mkdirSync(dirname(destAbs), { recursive: true });
    copyFileSync(srcChecked.absPath, destAbs);
    baselineFiles[f.relPosix] = {
      sha256: sha256File(destAbs),
      size: f.size,
    };
  }

  initLocalBaselineGit(workDir);

  const manifest = {
    id: shadowId,
    sourceDir: scan.sourceDir,
    workDir,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    fileCount: scan.fileCount,
    totalBytes: scan.totalBytes,
    skippedDirs: scan.skippedDirs,
    skippedSymlinks: scan.skippedSymlinks,
    files: baselineFiles,
  };
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), 'utf8');

  const record = store.addShadow({
    id: shadowId,
    sourceDir: scan.sourceDir,
    workDir,
    manifestFile,
    status: 'active', // 'active' | 'applied' | 'discarded'
    fileCount: scan.fileCount,
    totalBytes: scan.totalBytes,
    skippedDirs: scan.skippedDirs.slice(0, 30),
    skippedSymlinks: scan.skippedSymlinks.slice(0, 30),
    hasChanges: false,
    changedCount: 0,
    lastAppliedBackupId: null,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
  });

  return record;
}

async function initLocalBaselineGitAsync(workDir) {
  const r1 = await runGitAsync(workDir, ['init', '-q']);
  if (r1.status !== 0) {
    throw new Error(`影子副本初始化本地 git 基线失败: ${r1.stderr || r1.stdout}`);
  }
  await runGitAsync(workDir, ['config', 'user.name', 'sidedesk-shadow']);
  await runGitAsync(workDir, ['config', 'user.email', 'shadow@sidedesk.local']);
  await runGitAsync(workDir, ['config', 'core.autocrlf', 'false']);
  await runGitAsync(workDir, ['config', 'core.quotepath', 'false']);
  await runGitAsync(workDir, ['add', '-A', '--', '.']);
  const r2 = await runGitAsync(workDir, ['commit', '--allow-empty', '-q', '-m', 'sidedesk-baseline']);
  if (r2.status !== 0) {
    throw new Error(`影子副本提交基线失败: ${r2.stderr || r2.stdout}`);
  }
}

/**
 * Non-blocking async shadow creation so the MCP event loop stays responsive (<50ms send & instant abort).
 */
export async function createShadowCopyAsync(store, sourceDir, opts = {}) {
  const signal = opts.signal || null;
  const checkAborted = () => {
    if (signal?.aborted) {
      const err = new Error('影子副本创建已中止');
      err.name = 'AbortError';
      throw err;
    }
  };

  checkAborted();
  const scan = prescanSourceDir(sourceDir, opts);
  checkAborted();

  const shadowId = `sh-${randomUUID().slice(0, 12)}`;
  const shadowRoot = join(store.shadowsDir, shadowId);
  const workDir = join(shadowRoot, 'work');
  const manifestFile = join(shadowRoot, 'manifest.json');

  try {
    await mkdir(workDir, { recursive: true });

    const baselineFiles = {};
    for (let i = 0; i < scan.files.length; i++) {
      if (i % 25 === 0) {
        checkAborted();
        await new Promise((r) => setImmediate(r));
      }
      const f = scan.files[i];
      const srcChecked = assertRealPathInsideRoot(scan.sourceDir, f.absPath, {
        allowMissingLeaf: false,
        rejectSymlink: true,
        label: '源工程目录',
      });
      if (!srcChecked.stat?.isFile()) continue;
      const destAbs = assertInsideRoot(workDir, join(workDir, ...f.relPosix.split('/')));
      await mkdir(dirname(destAbs), { recursive: true });
      await copyFile(srcChecked.absPath, destAbs);
      baselineFiles[f.relPosix] = {
        sha256: sha256File(destAbs),
        size: f.size,
      };
    }

    checkAborted();
    await initLocalBaselineGitAsync(workDir);
    checkAborted();

    const manifest = {
      id: shadowId,
      sourceDir: scan.sourceDir,
      workDir,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      fileCount: scan.fileCount,
      totalBytes: scan.totalBytes,
      skippedDirs: scan.skippedDirs,
      skippedSymlinks: scan.skippedSymlinks,
      files: baselineFiles,
    };
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), 'utf8');

    return store.addShadow({
      id: shadowId,
      sourceDir: scan.sourceDir,
      workDir,
      manifestFile,
      status: 'active',
      fileCount: scan.fileCount,
      totalBytes: scan.totalBytes,
      skippedDirs: scan.skippedDirs.slice(0, 30),
      skippedSymlinks: scan.skippedSymlinks.slice(0, 30),
      hasChanges: false,
      changedCount: 0,
      lastAppliedBackupId: null,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
    });
  } catch (err) {
    try {
      if (existsSync(shadowRoot)) rmSync(shadowRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

export function loadShadowManifest(shadow) {
  return JSON.parse(readFileSync(shadow.manifestFile, 'utf8'));
}

function saveShadowManifest(shadow, manifest) {
  manifest.updatedAt = Date.now();
  writeFileSync(shadow.manifestFile, JSON.stringify(manifest, null, 2), 'utf8');
}

function isProbablyBinary(buf) {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function buildAddedFilePatch(relPosix, absPath, maxPatchBytes = 200 * 1024) {
  const buf = readFileSync(absPath);
  if (isProbablyBinary(buf)) {
    return {
      isBinary: true,
      additions: 0,
      deletions: 0,
      patch: `diff --git a/${relPosix} b/${relPosix}\nnew file\nBinary file (${buf.length} bytes)\n`,
    };
  }
  const truncated = buf.length > maxPatchBytes;
  const text = (truncated ? buf.subarray(0, maxPatchBytes) : buf).toString('utf8');
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const body = lines.map((l) => `+${l}`).join('\n');
  const patch =
    `diff --git a/${relPosix} b/${relPosix}\n` +
    `new file mode 100644\n` +
    `--- /dev/null\n` +
    `+++ b/${relPosix}\n` +
    `@@ -0,0 +1,${lines.length} @@\n` +
    `${body}${truncated ? '\n... (文件内容过大，已截断预览)' : ''}\n`;
  return {
    isBinary: false,
    additions: lines.length,
    deletions: 0,
    patch,
  };
}

function countDiffLines(patch) {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions++;
    else if (line.startsWith('-')) deletions++;
  }
  return { additions, deletions };
}

/**
 * Computes ground-truth filesystem diff of the shadow workspace against its local baseline commit.
 */
export function computeShadowDiff(shadow) {
  if (!shadow || !existsSync(shadow.workDir)) {
    throw new Error('影子副本目录不存在或已被丢弃');
  }

  const stRes = runGit(shadow.workDir, ['status', '--porcelain=v1', '-uall', '-z', '--']);
  if (stRes.status !== 0) {
    throw new Error(`影子副本状态检测失败: ${stRes.stderr || stRes.stdout}`);
  }

  const raw = stRes.stdout || '';
  const tokens = raw.split('\0').filter((t) => t.length > 0);
  const entries = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.length < 4) continue;
    const xy = tok.slice(0, 2);
    const p1 = tok.slice(3);

    if (xy.includes('R') || xy.includes('C')) {
      const oldPath = tokens[i + 1] || '';
      i++;
      if (oldPath) entries.push({ status: 'deleted', path: oldPath });
      entries.push({ status: 'added', path: p1 });
      continue;
    }

    if (xy === '??' || xy.includes('A')) {
      entries.push({ status: 'added', path: p1 });
    } else if (xy.includes('D')) {
      entries.push({ status: 'deleted', path: p1 });
    } else {
      entries.push({ status: 'modified', path: p1 });
    }
  }

  const byPath = new Map();
  for (const e of entries) {
    const cleanPath = toPosixRel(e.path);
    if (!cleanPath || cleanPath === '.git' || cleanPath.startsWith('.git/')) continue;
    byPath.set(cleanPath, e.status);
  }

  const files = [];
  const blockedSymlinks = [];
  let totalInsertions = 0;
  let totalDeletions = 0;
  let added = 0;
  let modified = 0;
  let deleted = 0;

  for (const [relPosix, status] of byPath.entries()) {
    const rawInWork = join(shadow.workDir, ...relPosix.split('/'));
    let checkedWork;
    try {
      checkedWork = assertRealPathInsideRoot(shadow.workDir, rawInWork, {
        allowMissingLeaf: status === 'deleted',
        rejectSymlink: true,
        label: '影子副本目录',
      });
    } catch {
      // Never follow symlinks/junctions planted inside the shadow workspace
      blockedSymlinks.push(relPosix);
      continue;
    }
    const absInWork = checkedWork.absPath;

    if (status === 'added') {
      if (!checkedWork.exists || checkedWork.stat?.isDirectory()) continue;
      added++;
      const built = buildAddedFilePatch(relPosix, absInWork);
      totalInsertions += built.additions;
      files.push({
        path: relPosix,
        status: 'added',
        additions: built.additions,
        deletions: 0,
        isBinary: built.isBinary,
        patch: built.patch,
      });
    } else {
      if (status === 'deleted') deleted++;
      else modified++;
      const dRes = runGit(shadow.workDir, [
        '-c',
        'core.quotepath=false',
        'diff',
        'HEAD',
        '--',
        relPosix,
      ]);
      const patch = dRes.stdout || '';
      const isBinary = /Binary files .* differ/.test(patch);
      const { additions, deletions } = isBinary
        ? { additions: 0, deletions: 0 }
        : countDiffLines(patch);
      totalInsertions += additions;
      totalDeletions += deletions;
      files.push({
        path: relPosix,
        status,
        additions,
        deletions,
        isBinary,
        patch: patch.length > 220 * 1024 ? patch.slice(0, 220 * 1024) + '\n... (Diff 过大已截断)' : patch,
      });
    }
  }

  const fullPatch = files.map((f) => f.patch).join('\n');
  return {
    shadowId: shadow.id,
    sourceDir: shadow.sourceDir,
    hasChanges: files.length > 0,
    blockedSymlinks,
    stats: {
      added,
      modified,
      deleted,
      totalFiles: files.length,
      insertions: totalInsertions,
      deletions: totalDeletions,
    },
    files,
    fullPatch,
  };
}

/**
 * Post-run integrity check: verifies original sourceDir baseline files were NOT unexpectedly tampered with.
 */
export function verifySourceUntouched(shadow, shadowDiff = null) {
  const manifest = loadShadowManifest(shadow);
  const tamperedFiles = [];

  for (const [relPosix, meta] of Object.entries(manifest.files || {})) {
    let checked;
    try {
      checked = assertRealPathInsideRoot(shadow.sourceDir, join(shadow.sourceDir, ...relPosix.split('/')), {
        allowMissingLeaf: true,
        rejectSymlink: true,
        label: '原工程目录',
      });
    } catch {
      tamperedFiles.push({ path: relPosix, reason: 'symlink_or_escape' });
      continue;
    }
    if (!checked.exists) {
      tamperedFiles.push({ path: relPosix, reason: 'deleted' });
      continue;
    }
    try {
      const curHash = sha256File(checked.absPath);
      if (curHash !== meta.sha256) {
        tamperedFiles.push({ path: relPosix, reason: 'modified' });
      }
    } catch {
      tamperedFiles.push({ path: relPosix, reason: 'unreadable' });
    }
  }

  if (shadowDiff && Array.isArray(shadowDiff.files)) {
    for (const f of shadowDiff.files) {
      if (f.status === 'added' && !manifest.files[f.path]) {
        try {
          const checked = assertRealPathInsideRoot(shadow.sourceDir, join(shadow.sourceDir, ...f.path.split('/')), {
            allowMissingLeaf: true,
            rejectSymlink: true,
            label: '原工程目录',
          });
          if (checked.exists) {
            tamperedFiles.push({ path: f.path, reason: 'unexpected_added' });
          }
        } catch {
          tamperedFiles.push({ path: f.path, reason: 'symlink_or_escape' });
        }
      }
    }
  }

  return {
    checked: true,
    checkedAt: Date.now(),
    untouched: tamperedFiles.length === 0,
    tamperedFiles,
  };
}

/**
 * Conflict detection right before applying shadow changes back into sourceDir.
 */
export function checkApplyConflicts(shadow, diff) {
  const manifest = loadShadowManifest(shadow);
  const conflicts = [];

  for (const f of diff.files) {
    const checked = assertRealPathInsideRoot(shadow.sourceDir, join(shadow.sourceDir, ...f.path.split('/')), {
      allowMissingLeaf: true,
      rejectSymlink: true,
      label: '原工程目录',
    });
    const absOrig = checked.absPath;
    const base = manifest.files[f.path];

    if (f.status === 'added') {
      if (checked.exists) {
        conflicts.push({
          path: f.path,
          reason: '原目录在创建影子副本后新增了同名文件',
        });
      }
    } else if (f.status === 'modified' || f.status === 'deleted') {
      if (!checked.exists) {
        conflicts.push({
          path: f.path,
          reason: '原目录中的该文件已被外部删除',
        });
      } else if (base && sha256File(absOrig) !== base.sha256) {
        conflicts.push({
          path: f.path,
          reason: '原目录中的该文件在创建影子副本后被外部修改过',
        });
      }
    }
  }

  return {
    hasConflicts: conflicts.length > 0,
    conflicts,
  };
}

/**
 * Apply verified shadow changes to original sourceDir with automatic pre-apply snapshot backup.
 */
export function applyShadowToSource(store, shadow, { force = false } = {}) {
  const diff = computeShadowDiff(shadow);
  if (Array.isArray(diff.blockedSymlinks) && diff.blockedSymlinks.length > 0) {
    throw new Error(
      `安全拦截：影子副本中检测到非法符号链接/目录联接 (${diff.blockedSymlinks.join(', ')})，已阻断写回原目录`
    );
  }
  if (!diff.hasChanges) {
    return { applied: false, reason: 'no_changes', message: '影子副本暂无文件变更可应用' };
  }

  const conflictReport = checkApplyConflicts(shadow, diff);
  if (conflictReport.hasConflicts && !force) {
    return {
      applied: false,
      conflict: true,
      conflicts: conflictReport.conflicts,
      message: `检测到 ${conflictReport.conflicts.length} 个文件与原目录存在冲突，已暂停写入以防静默覆盖`,
    };
  }

  const backupId = `bk-${randomUUID().slice(0, 12)}`;
  const backupRoot = join(store.backupsDir, backupId);
  const backupFilesDir = join(backupRoot, 'files');
  mkdirSync(backupFilesDir, { recursive: true });

  const modifiedFiles = [];
  const deletedFiles = [];
  const addedFiles = [];

  for (const f of diff.files) {
    const origChecked = assertRealPathInsideRoot(shadow.sourceDir, join(shadow.sourceDir, ...f.path.split('/')), {
      allowMissingLeaf: true,
      rejectSymlink: true,
      label: '原工程目录',
    });
    const absOrig = origChecked.absPath;
    if (f.status === 'added') {
      if (origChecked.exists) {
        const bakDest = assertInsideRoot(backupFilesDir, join(backupFilesDir, ...f.path.split('/')));
        mkdirSync(dirname(bakDest), { recursive: true });
        copyFileSync(absOrig, bakDest);
        modifiedFiles.push(f.path);
      } else {
        addedFiles.push(f.path);
      }
    } else if (f.status === 'modified') {
      if (origChecked.exists) {
        const bakDest = assertInsideRoot(backupFilesDir, join(backupFilesDir, ...f.path.split('/')));
        mkdirSync(dirname(bakDest), { recursive: true });
        copyFileSync(absOrig, bakDest);
        modifiedFiles.push(f.path);
      } else {
        addedFiles.push(f.path);
      }
    } else if (f.status === 'deleted') {
      if (origChecked.exists) {
        const bakDest = assertInsideRoot(backupFilesDir, join(backupFilesDir, ...f.path.split('/')));
        mkdirSync(dirname(bakDest), { recursive: true });
        copyFileSync(absOrig, bakDest);
        deletedFiles.push(f.path);
      }
    }
  }

  const backupMeta = {
    id: backupId,
    shadowId: shadow.id,
    sourceDir: shadow.sourceDir,
    backupRoot,
    backupFilesDir,
    addedFiles,
    modifiedFiles,
    deletedFiles,
    undone: false,
    createdAt: Date.now(),
    undoneAt: null,
  };
  writeFileSync(join(backupRoot, 'backup.json'), JSON.stringify(backupMeta, null, 2), 'utf8');

  const manifest = loadShadowManifest(shadow);
  for (const f of diff.files) {
    const origChecked = assertRealPathInsideRoot(shadow.sourceDir, join(shadow.sourceDir, ...f.path.split('/')), {
      allowMissingLeaf: true,
      rejectSymlink: true,
      label: '原工程目录',
    });
    const absOrig = origChecked.absPath;

    if (f.status === 'deleted') {
      if (origChecked.exists) {
        const curStat = lstatNoThrow(absOrig);
        if (curStat?.isSymbolicLink()) {
          throw new Error(`路径越界拦截：拒绝删除符号链接 (${f.path})`);
        }
        if (curStat) unlinkSync(absOrig);
      }
      delete manifest.files[f.path];
    } else {
      const workChecked = assertRealPathInsideRoot(shadow.workDir, join(shadow.workDir, ...f.path.split('/')), {
        allowMissingLeaf: false,
        rejectSymlink: true,
        label: '影子副本目录',
      });
      if (!workChecked.stat?.isFile()) {
        throw new Error(`安全拦截：影子变更项不是普通文件 (${f.path})`);
      }
      mkdirSync(dirname(absOrig), { recursive: true });
      // TOCTOU re-check right before writing into sourceDir
      const finalOrig = assertRealPathInsideRoot(shadow.sourceDir, absOrig, {
        allowMissingLeaf: true,
        rejectSymlink: true,
        label: '原工程目录',
      });
      copyFileSync(workChecked.absPath, finalOrig.absPath);
      manifest.files[f.path] = {
        sha256: sha256File(finalOrig.absPath),
        size: statSync(finalOrig.absPath).size,
      };
    }
  }

  runGit(shadow.workDir, ['add', '-A', '--', '.']);
  runGit(shadow.workDir, ['commit', '--allow-empty', '-q', '-m', `sidedesk-applied-${backupId}`]);
  saveShadowManifest(shadow, manifest);

  shadow.status = 'applied';
  shadow.hasChanges = false;
  shadow.changedCount = 0;
  shadow.lastAppliedBackupId = backupId;
  shadow.updatedAt = Date.now();

  store.addBackup(backupMeta);
  store.flush();

  return {
    applied: true,
    backupId,
    stats: diff.stats,
    addedFiles,
    modifiedFiles,
    deletedFiles,
  };
}

function cleanupEmptyParentDirs(startDir, stopRoot) {
  let rootReal;
  try {
    rootReal = realpathNative(stopRoot);
  } catch {
    return;
  }
  const rootNorm = normalizePathForCompare(rootReal);
  let cur = resolve(startDir);
  while (true) {
    const lst = lstatNoThrow(cur);
    if (!lst || lst.isSymbolicLink() || !lst.isDirectory()) break;
    let curReal;
    try {
      curReal = realpathNative(cur);
    } catch {
      break;
    }
    const curNorm = normalizePathForCompare(curReal);
    if (curNorm === rootNorm || !isSameOrInsideRealPath(rootReal, curReal)) {
      break;
    }
    try {
      const items = readdirSync(curReal);
      if (items.length === 0) {
        rmSync(curReal, { recursive: false });
        const parent = dirname(curReal);
        if (parent === curReal) break;
        cur = parent;
      } else {
        break;
      }
    } catch {
      break;
    }
  }
}

/**
 * One-click Undo ("撤销上次应用"): restores backed-up modified/deleted files and removes added files.
 */
export function undoLastApply(store, { backupId = '', sourceDir = '' } = {}) {
  const backup = backupId
    ? store.getBackup(backupId)
    : store.getLatestUndoableBackup(sourceDir);

  if (!backup) {
    return { undone: false, message: '没有可撤销的已应用备份记录' };
  }
  if (backup.undone) {
    return { undone: false, message: `备份 ${backup.id} 已经撤销过` };
  }

  let restoredCount = 0;
  let removedAddedCount = 0;

  for (const relPosix of [...(backup.modifiedFiles || []), ...(backup.deletedFiles || [])]) {
    const bakChecked = assertRealPathInsideRoot(
      backup.backupFilesDir,
      join(backup.backupFilesDir, ...relPosix.split('/')),
      { allowMissingLeaf: true, rejectSymlink: true, label: '备份目录' }
    );
    const origChecked = assertRealPathInsideRoot(
      backup.sourceDir,
      join(backup.sourceDir, ...relPosix.split('/')),
      { allowMissingLeaf: true, rejectSymlink: true, label: '原工程目录' }
    );
    if (bakChecked.exists && bakChecked.stat?.isFile()) {
      mkdirSync(dirname(origChecked.absPath), { recursive: true });
      const finalOrig = assertRealPathInsideRoot(backup.sourceDir, origChecked.absPath, {
        allowMissingLeaf: true,
        rejectSymlink: true,
        label: '原工程目录',
      });
      copyFileSync(bakChecked.absPath, finalOrig.absPath);
      restoredCount++;
    }
  }

  for (const relPosix of backup.addedFiles || []) {
    const origChecked = assertRealPathInsideRoot(
      backup.sourceDir,
      join(backup.sourceDir, ...relPosix.split('/')),
      { allowMissingLeaf: true, rejectSymlink: true, label: '原工程目录' }
    );
    if (origChecked.exists) {
      const curStat = lstatNoThrow(origChecked.absPath);
      if (curStat?.isSymbolicLink()) {
        throw new Error(`路径越界拦截：拒绝删除符号链接 (${relPosix})`);
      }
      if (curStat) {
        unlinkSync(origChecked.absPath);
        cleanupEmptyParentDirs(dirname(origChecked.absPath), backup.sourceDir);
        removedAddedCount++;
      }
    }
  }

  backup.undone = true;
  backup.undoneAt = Date.now();
  try {
    writeFileSync(join(backup.backupRoot, 'backup.json'), JSON.stringify(backup, null, 2), 'utf8');
  } catch {
    // ignore
  }

  const shadow = store.getShadow(backup.shadowId);
  if (shadow && existsSync(shadow.manifestFile)) {
    try {
      const manifest = loadShadowManifest(shadow);
      for (const relPosix of [...(backup.modifiedFiles || []), ...(backup.deletedFiles || [])]) {
        const origChecked = assertRealPathInsideRoot(
          backup.sourceDir,
          join(backup.sourceDir, ...relPosix.split('/')),
          { allowMissingLeaf: true, rejectSymlink: true, label: '原工程目录' }
        );
        if (origChecked.exists) {
          manifest.files[relPosix] = {
            sha256: sha256File(origChecked.absPath),
            size: statSync(origChecked.absPath).size,
          };
        }
      }
      for (const relPosix of backup.addedFiles || []) {
        delete manifest.files[relPosix];
      }
      saveShadowManifest(shadow, manifest);
    } catch {
      // ignore
    }
  }

  if (typeof store.markSessionsRollbackNotice === 'function') {
    store.markSessionsRollbackNotice({ sourceDir: backup.sourceDir, shadowId: backup.shadowId });
  }
  store.flush();

  return {
    undone: true,
    backupId: backup.id,
    sourceDir: backup.sourceDir,
    restoredCount,
    removedAddedCount,
  };
}

/**
 * Discard shadow copy completely without touching sourceDir.
 */
export function discardShadow(store, shadowId) {
  const shadow = store.getShadow(shadowId);
  if (!shadow) {
    throw new Error(`未找到影子副本: ${shadowId}`);
  }
  const shadowRoot = dirname(shadow.workDir);
  const checkedRoot = assertRealPathInsideRoot(store.shadowsDir, shadowRoot, {
    allowMissingLeaf: true,
    rejectSymlink: true,
    label: '影子存储目录',
  });
  if (checkedRoot.exists) {
    rmSync(checkedRoot.absPath, { recursive: true, force: true });
  }
  shadow.status = 'discarded';
  shadow.hasChanges = false;
  shadow.changedCount = 0;
  shadow.updatedAt = Date.now();
  if (typeof store.markSessionsRollbackNotice === 'function') {
    store.markSessionsRollbackNotice({ sourceDir: shadow.sourceDir, shadowId: shadow.id });
  }
  store.flush();
  return { discarded: true, shadowId: shadow.id };
}

/**
 * Lightweight, non-blocking git working-tree summary for turbo-direct mode.
 * Never creates shadows, never copies files, never modifies the repo.
 */
export async function inspectDirectGitStatus(sourceDir) {
  try {
    const absDir = resolve(sourceDir);
    if (!existsSync(absDir)) {
      return {
        isGitRepo: false,
        changedCount: 0,
        files: [],
        summary: 'Turbo 直通已直接在原目录执行',
      };
    }
    const check = await runGitAsync(absDir, ['rev-parse', '--is-inside-work-tree']);
    if (check.status !== 0 || check.stdout.trim() !== 'true') {
      return {
        isGitRepo: false,
        changedCount: 0,
        files: [],
        summary: 'Turbo 直通已直接在原目录执行（非 Git 目录）',
      };
    }
    const st = await runGitAsync(absDir, ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-uall', '--']);
    if (st.status !== 0) {
      return {
        isGitRepo: true,
        changedCount: 0,
        files: [],
        summary: 'Turbo 直通已直接在原目录执行',
      };
    }
    const lines = (st.stdout || '')
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter((l) => l.length >= 4);
    const files = lines.slice(0, 30).map((l) => ({
      status: l.slice(0, 2).trim() || 'M',
      path: l.slice(3),
    }));
    return {
      isGitRepo: true,
      changedCount: lines.length,
      files,
      summary:
        lines.length > 0
          ? `Turbo 直通已直接在原目录执行（Git 工作区当前有 ${lines.length} 个变动文件）`
          : 'Turbo 直通已直接在原目录执行（Git 工作区无未提交变动）',
    };
  } catch {
    return {
      isGitRepo: false,
      changedCount: 0,
      files: [],
      summary: 'Turbo 直通已直接在原目录执行',
    };
  }
}
