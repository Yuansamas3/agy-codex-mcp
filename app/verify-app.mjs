import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const htmlPath = join(__dirname, 'dist', 'app.html');
const srcMainPath = join(__dirname, 'src', 'main.js');

function pass(msg) {
  console.log(`✅ [PASS] ${msg}`);
}

// 1. Static CSP & Bundle Hygiene Audit
assert.ok(existsSync(htmlPath), 'dist/app.html must exist');
const html = readFileSync(htmlPath, 'utf8');
const srcMain = readFileSync(srcMainPath, 'utf8');
const srcCodeOnly = srcMain.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const byteLen = Buffer.byteLength(html, 'utf8');

assert.ok(byteLen > 5000 && byteLen < 10 * 1024 * 1024, `HTML size out of range: ${byteLen}`);
assert.equal(/<script[^>]+src=/i.test(html), false, 'Must not contain external <script src>');
assert.equal(/<link[^>]+rel=["']?stylesheet/i.test(html), false, 'Must not contain external stylesheet');
assert.equal(/\b(localStorage|sessionStorage|indexedDB)\b/.test(srcCodeOnly), false, 'No browser storage');
assert.equal(/\bfetch\s*\(/.test(srcCodeOnly), false, 'No raw fetch() in frontend');
assert.ok(html.includes('pm-avatar-paste'), 'User manual edit #pm-avatar-paste must be preserved in dist/app.html');
assert.ok(html.includes('up-avatar-paste'), 'Profile paste button #up-avatar-paste must exist');
assert.ok(html.includes('不再延续'), 'Inherited summary unbind button must exist');
assert.ok(html.includes('⚡ Turbo 全开直通'), 'Turbo preset must exist');
assert.ok(html.includes('btn-emergency-trip'), 'Emergency trip button must exist');
assert.ok(html.includes('⚡ 闪电加速'), 'Fast mode toggle must exist');
assert.ok(html.includes('纯净极速启动'), 'Clean Codex config toggle must exist');
assert.ok(html.includes('pm-address-as'), 'Persona addressUserAs input must exist');
assert.ok(html.includes('pm-mem-list'), 'Persona long-term memory list must exist');
assert.ok(html.includes('pm-codex-path'), 'Custom Codex path input #pm-codex-path must exist');
assert.ok(html.includes('pm-api-presets'), 'API quick-fill preset chips #pm-api-presets must exist');
assert.ok(html.includes('btn-theme-toggle'), 'Topbar manual theme toggle #btn-theme-toggle must exist');
assert.ok(html.includes('up-theme-seg'), 'Profile theme segmented control #up-theme-seg must exist');
assert.ok(html.includes('btn-modal-x') && html.includes('modal-head-tabbed'), 'Round 2 modal header & close button must exist');
assert.ok(html.includes('--modal-bg:') && html.includes('--seg-track:') && html.includes('--float-rim:'), 'Round 2 semantic color tokens must exist');
assert.ok(html.includes('btn-quota-pill') && html.includes('quota-popover'), 'v1.1 quota capsule & details popover must exist');
assert.ok(html.includes('btn-quota-refresh') && html.includes('btn-quota-compress'), 'v1.1 quota refresh & high-context compress nudge must exist');
assert.ok(html.includes('pm-context-window'), 'v1.1 API persona optional contextWindow input must exist');
assert.equal(html.includes('bubble-more-btn'), false, 'Legacy .bubble-more-btn must be completely removed');
pass(`1. 静态 CSP、体量与增量保留检查 (${(byteLen / 1024).toFixed(1)} KB, 零外链/零 localStorage/保留 #pm-avatar-paste + 主题手动切换控件 + v1.1 配额微胶囊与上下文详情浮层)`);

// 2. Live MCP Resource & Draft Tool Verification
const testDataDir = join(tmpdir(), `sidedesk-ui-verify-${Date.now()}`);
mkdirSync(testDataDir, { recursive: true });
try {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(rootDir, 'server', 'index.mjs'), `--data_dir=${testDataDir}`],
  });
  const client = new Client({ name: 'sidedesk-ui-verifier', version: '0.3.0' });
  await client.connect(transport);

  const resRead = await client.readResource({ uri: 'ui://sidedesk/app.html' });
  assert.equal(resRead.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.equal(resRead.contents[0].text, html);

  const draftRes = await client.callTool({
    name: 'app_save_draft',
    arguments: { key: 'new', text: '副席草稿测试', sourceDir: 'D:\\demo\\api' },
  });
  assert.equal(draftRes.structuredContent.ok, true);
  await client.close();
  pass('2. MCP ui://sidedesk/app.html 资源读取 + 草稿持久化');
} finally {
  rmSync(testDataDir, { recursive: true, force: true });
}

// 3. Headless Chrome/Edge Strict CSP + 360px Narrow-Pane Layout + Full Modal & Bubble Audit
function findBrowserExecutable() {
  const envCandidates = [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.EDGE_PATH,
  ].filter(Boolean);
  for (const c of envCandidates) {
    if (existsSync(c)) return c;
  }

  const candidates = [];
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || '';
    candidates.push(
      join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      local ? join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
      join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      local ? join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : ''
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    );
  } else {
    for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
      const r = spawnSync('which', [bin], { encoding: 'utf8' });
      const first = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (first && existsSync(first)) return first;
    }
    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge');
  }

  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return '';
}

const chromeExe = findBrowserExecutable();
assert.ok(chromeExe, 'No Chrome / Edge / Chromium binary found (set CHROME_PATH to override)');

const mockHostHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Mock MCP Host v0.3</title></head>
<body style="margin:0;padding:0;background:#111;">
  <iframe id="app-frame" src="/app.html" style="width:360px;height:740px;border:0;display:block;"></iframe>
  <script>
    const frame = document.getElementById('app-frame');
    window.__REPORT__ = { done: false, initDone: false, cspViolations: [], errors: [], calls: [], themeCalls: [], checks: {} };

    const MOCK_API_SESSION = {
      id: 'sess-api-1',
      personaId: 'ds-r1',
      provider: 'openai-compatible',
      title: '长上下文并发重构',
      sourceDir: 'D:\\\\projects\\\\my-backend',
      shadowId: null,
      contentMessageCount: 4,
      hasFreshSummary: false,
      inheritedSummary: null,
      contextUsage: {
        usedTokens: 92200,
        inputTokens: 90100,
        outputTokens: 2100,
        cachedTokens: 41200,
        reasoningTokens: 0,
        maxTokens: 128000,
        usedPercent: 72,
        source: 'openai-usage',
        updatedAt: Date.now() - 3000,
      },
      messages: [
        { id: 'am1', role: 'boss', text: '继续重构连接池', createdAt: Date.now() - 10000 },
        { id: 'am2', role: 'assistant', text: '已完成初步方案。', model: 'deepseek-reasoner', createdAt: Date.now() - 4000 },
      ],
    };

    const MOCK_STATE = {
      codex: { available: true, version: 'codex-cli 0.171.0-alpha.13', checking: false },
      quota: {
        available: true,
        source: 'codex-sessions',
        limitId: 'codex',
        planType: 'plus',
        primary: {
          usedPercent: 2,
          remainingPercent: 98,
          windowMinutes: 300,
          resetsAt: Math.floor(Date.now() / 1000) + 8040,
        },
        secondary: {
          usedPercent: 29,
          remainingPercent: 71,
          windowMinutes: 10080,
          resetsAt: Math.floor(Date.now() / 1000) + 3 * 86400,
        },
        credits: { hasCredits: false, unlimited: false, balance: '0' },
        snapshotAt: Date.now() - 30000,
        scannedAt: Date.now(),
      },
      userProfile: { userName: '老板', userAvatar: '👑', themeMode: 'auto' },
      defaultPermissions: { fileScope: 'shadow', commandPolicy: 'auto', networkPolicy: 'deny' },
      availableModels: ['gpt-6.2-sol', 'gpt-6-luna'],
      modelReasoningLevels: {
        'gpt-6.2-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        'gpt-6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      personas: [
        {
          id: 'codex-default',
          name: 'Codex',
          role: '后端架构师',
          avatar: '🧪',
          addressUserAs: '老板',
          memories: [
            { id: 'mem-1', text: '回答尽量控制在 5 行以内', enabled: true },
            { id: 'mem-2', text: '旧偏好已停用', enabled: false },
          ],
          provider: 'codex-cli',
          systemPrompt: '严苛审计代码隐患',
          model: 'gpt-6.2-sol',
          reasoningEffort: 'high',
          fastMode: false,
          cleanCodexConfig: true,
          defaultSandbox: 'workspace-write',
          permissions: { fileScope: 'shadow', commandPolicy: 'auto', networkPolicy: 'deny' },
          baseUrl: '',
          toolMode: 'agent',
          hasApiKey: false,
          apiKeyHint: '',
        },
        {
          id: 'ds-r1',
          name: 'DeepSeek 审计官',
          role: '推理模型后端专家',
          avatar: '🧠',
          provider: 'openai-compatible',
          systemPrompt: '深度推理分析',
          model: 'deepseek-reasoner',
          reasoningEffort: 'high',
          defaultSandbox: 'workspace-write',
          permissions: { fileScope: 'shadow', commandPolicy: 'auto', networkPolicy: 'deny' },
          baseUrl: 'https://api.deepseek.com/v1',
          toolMode: 'agent',
          hasApiKey: true,
          apiKeyHint: 'sk-...8899',
        }
      ],
      sessions: [{
        id: 'sess-1',
        personaId: 'codex-default',
        provider: 'codex-cli',
        title: '鉴权并发审计',
        sourceDir: 'D:\\\\projects\\\\my-backend',
        shadowId: 'sh-mock01',
        codexThreadId: 'th-1',
        model: 'gpt-6.2-sol',
        reasoningEffort: 'high',
        createdAt: Date.now() - 60000,
        updatedAt: Date.now(),
        messageCount: 2,
        contentMessageCount: 2,
        hasFreshSummary: false,
        hasInheritedSummary: true,
      }, {
        id: 'sess-api-1',
        personaId: 'ds-r1',
        provider: 'openai-compatible',
        title: '长上下文并发重构',
        sourceDir: 'D:\\\\projects\\\\my-backend',
        shadowId: null,
        codexThreadId: null,
        model: 'deepseek-reasoner',
        reasoningEffort: '',
        createdAt: Date.now() - 40000,
        updatedAt: Date.now() - 1000,
        messageCount: 2,
        contentMessageCount: 4,
        hasFreshSummary: false,
        hasInheritedSummary: false,
      }],
      activeSession: {
        id: 'sess-1',
        personaId: 'codex-default',
        provider: 'codex-cli',
        title: '鉴权并发审计',
        sourceDir: 'D:\\\\projects\\\\my-backend',
        shadowId: 'sh-mock01',
        contentMessageCount: 2,
        hasFreshSummary: false,
        contextUsage: {
          usedTokens: 21086,
          inputTokens: 20984,
          outputTokens: 102,
          cachedTokens: 14208,
          reasoningTokens: 0,
          maxTokens: 475000,
          usedPercent: 4.4,
          source: 'codex-jsonl',
          updatedAt: Date.now() - 5000,
        },
        inheritedSummary: {
          sourceSessionId: 'sess-0',
          sourceTitle: '历史方案讨论',
          summary: '已敲定采用 Redis 分布式锁处理 token 刷新并发。',
          updatedAt: Date.now() - 50000,
        },
        messages: [
          { id: 'm1', role: 'boss', text: '111', jobId: 'job-1', createdAt: Date.now() - 20000 },
          { id: 'm2', role: 'assistant', text: '已修复并发竞态，欢迎验收。', jobId: 'job-1', model: 'gpt-6.2-sol', createdAt: Date.now() - 5000 },
          { id: 'm3', role: 'assistant', text: '你好！有什么可以帮你的？', jobId: 'job-2', model: 'gpt-6.2-sol', createdAt: Date.now() - 2000 }
        ],
      },
      jobDetailsById: {
        'job-1': {
          id: 'job-1',
          provider: 'codex-cli',
          status: 'completed',
          model: 'gpt-6.2-sol',
          sandbox: 'workspace-write',
          permissions: { fileScope: 'shadow', commandPolicy: 'auto', networkPolicy: 'deny' },
          shadowId: 'sh-mock01',
          startedAt: Date.now() - 18000,
          finishedAt: Date.now() - 5000,
          diffSummary: { hasChanges: true, stats: { added: 0, modified: 1, deleted: 0, totalFiles: 1, insertions: 6, deletions: 2 }, files: [{ path: 'src/auth.ts', status: 'modified', additions: 6, deletions: 2 }] },
          sourceIntegrity: { checked: true, untouched: true, tamperedFiles: [] },
          events: [
            { ts: Date.now() - 17000, kind: 'system', text: '启动引擎' },
            { ts: Date.now() - 16500, kind: 'reasoning', text: '正在深度思考...' },
            { ts: Date.now() - 16000, kind: 'reasoning', text: '定位到 token 刷新未加分布式锁' },
            { ts: Date.now() - 15000, kind: 'command', text: '执行命令: pytest' },
            { ts: Date.now() - 14000, kind: 'message', text: '已修复' }
          ],
        },
        'job-2': {
          id: 'job-2',
          provider: 'codex-cli',
          status: 'completed',
          model: 'gpt-6.2-sol',
          sandbox: 'read-only',
          events: [
            { ts: Date.now() - 3000, kind: 'system', text: '启动引擎' },
            { ts: Date.now() - 2500, kind: 'reasoning', text: '正在深度思考...' },
            { ts: Date.now() - 2200, kind: 'message', text: '你好！' }
          ],
        }
      },
      runningJobs: [{
        id: 'job-run-1',
        sessionId: 'sess-other',
        personaId: 'ds-r1',
        personaName: 'DeepSeek 审计官',
        provider: 'openai-compatible',
        stage: 'executing',
        stageLabel: '思考与执行中',
        model: 'deepseek-reasoner',
        sandbox: 'workspace-write',
        startedAt: Date.now() - 3000,
        liveReply: '',
        events: [],
      }],
      recentJobs: [],
      pendingShadows: [{ id: 'sh-mock01', sourceDir: 'D:\\\\projects\\\\my-backend', status: 'active', changedCount: 1, updatedAt: Date.now() }],
      undoableBackups: [{ id: 'bk-01', shadowId: 'sh-mock01', sourceDir: 'D:\\\\projects\\\\my-backend', addedCount: 0, modifiedCount: 1, deletedCount: 0, createdAt: Date.now() }],
      drafts: {},
      recentSourceDirs: ['D:\\\\projects\\\\my-backend'],
      updatedAt: Date.now(),
    };

    const MOCK_DIFF = {
      ok: true,
      diff: {
        shadowId: 'sh-mock01',
        sourceDir: 'D:\\\\projects\\\\my-backend',
        hasChanges: true,
        stats: { added: 0, modified: 1, deleted: 0, totalFiles: 1, insertions: 2, deletions: 1 },
        files: [{
          path: 'src/auth/very_long_file_name_for_narrow_pane_check.ts',
          status: 'modified',
          additions: 2,
          deletions: 1,
          isBinary: false,
          patch: 'diff --git a/src/auth.ts b/src/auth.ts\\n--- a/src/auth.ts\\n+++ b/src/auth.ts\\n@@ -1,2 +1,3 @@\\n-return raw.longPropertyNameThatMustScrollInsideCodeBlockOnly();\\n+if (!raw) throw new Error("missing");\\n+return raw.longPropertyNameThatMustScrollInsideCodeBlockOnly();'
        }],
        fullPatch: '+fixed'
      }
    };

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || msg.jsonrpc !== '2.0') return;
      const reply = (result) => frame.contentWindow.postMessage({ jsonrpc: '2.0', id: msg.id, result }, '*');
      if (msg.method === 'ui/initialize') {
        reply({
          protocolVersion: msg.params?.protocolVersion || '2026-01-26',
          hostInfo: { name: 'mock', version: '1.0.0' },
          hostCapabilities: { serverTools: {}, message: {}, updateModelContext: {} },
          hostContext: { theme: 'dark', displayMode: 'inline', styles: { variables: {} } }
        });
      } else if (msg.method === 'ui/notifications/initialized') {
        window.__REPORT__.initDone = true;
      } else if (msg.method === 'tools/call') {
        const name = msg.params?.name;
        window.__REPORT__.calls.push(name);
        if (name === 'app_get_state') {
          const reqArgs = msg.params?.arguments || {};
          const wantApi = reqArgs.sessionId === 'sess-api-1' || reqArgs.personaId === 'ds-r1';
          const payload = wantApi ? { ...MOCK_STATE, activeSession: MOCK_API_SESSION } : MOCK_STATE;
          reply({ content: [{ type: 'text', text: '{}' }], structuredContent: payload });
        } else if (name === 'app_refresh_quota') {
          MOCK_STATE.quota = {
            ...MOCK_STATE.quota,
            primary: {
              ...MOCK_STATE.quota.primary,
              usedPercent: 84,
              remainingPercent: 16,
            },
            scannedAt: Date.now(),
          };
          reply({
            content: [{ type: 'text', text: '{}' }],
            structuredContent: {
              ok: true,
              quota: MOCK_STATE.quota,
              contextUsage: MOCK_STATE.activeSession.contextUsage,
            },
          });
        } else if (name === 'app_get_diff') reply({ content: [{ type: 'text', text: '{}' }], structuredContent: MOCK_DIFF });
        else if (name === 'app_test_provider') reply({ content: [{ type: 'text', text: '{}' }], structuredContent: { ok: true, latencyMs: 128, model: 'deepseek-reasoner' } });
        else if (name === 'app_clear_inherited_summary') {
          MOCK_STATE.activeSession.inheritedSummary = null;
          reply({ content: [{ type: 'text', text: '{}' }], structuredContent: { ok: true, session: MOCK_STATE.activeSession } });
        } else if (name === 'app_export_session') {
          reply({ content: [{ type: 'text', text: '{}' }], structuredContent: { ok: true, filename: 'topic.md', savedPath: 'D:\\\\tmp\\\\topic.md', markdown: '# 鉴权并发审计\\n测试导出' } });
        } else if (name === 'app_emergency_trip') {
          MOCK_STATE.runningJobs = [];
          reply({ content: [{ type: 'text', text: '{}' }], structuredContent: { ok: true, abortedCount: 1, abortedJobIds: ['job-run-1'], downgradedGlobalToShadow: true } });
        } else if (name === 'app_set_theme') {
          const tm = msg.params?.arguments?.themeMode || 'auto';
          MOCK_STATE.userProfile.themeMode = tm;
          window.__REPORT__.themeCalls.push(tm);
          reply({ content: [{ type: 'text', text: '{}' }], structuredContent: { ok: true, themeMode: tm, userProfile: MOCK_STATE.userProfile } });
        } else if (name === 'app_save_user_profile') {
          const a = msg.params?.arguments || {};
          if (a.userName) MOCK_STATE.userProfile.userName = a.userName;
          if (a.userAvatar !== undefined) MOCK_STATE.userProfile.userAvatar = a.userAvatar;
          if (a.themeMode) MOCK_STATE.userProfile.themeMode = a.themeMode;
          reply({ content: [{ type: 'text', text: '{}' }], structuredContent: { ok: true, userProfile: MOCK_STATE.userProfile } });
        } else reply({ content: [{ type: 'text', text: '{}' }], structuredContent: { ok: true } });
      } else if (msg.id !== undefined) {
        reply({});
      }
    });

    frame.addEventListener('load', () => {
      const w = frame.contentWindow;
      const doc = frame.contentDocument;
      w.addEventListener('securitypolicyviolation', (e) => window.__REPORT__.cspViolations.push(e.violatedDirective + ':' + e.blockedURI));
      w.addEventListener('error', (e) => window.__REPORT__.errors.push(e.message || String(e)));
      w.addEventListener('unhandledrejection', (e) => window.__REPORT__.errors.push(String(e.reason)));

      setTimeout(async () => {
        try {
          const stationScrollWidth = doc.documentElement.scrollWidth;
          const initialTheme = doc.documentElement.getAttribute('data-theme');

          // v1.1 Quota Pill + Popover check in initial Dark theme (360px)
          const quotaPillCodexText = doc.getElementById('quota-pill-text')?.textContent?.trim() || '';
          doc.getElementById('btn-quota-pill').click();
          await new Promise((r) => setTimeout(r, 100));
          const quotaPopOpenDark = !doc.getElementById('quota-popover')?.classList.contains('hidden');
          const quotaPopDarkScrollWidth = doc.documentElement.scrollWidth;
          const quota5hValText = doc.getElementById('quota-5h-val')?.textContent?.trim() || '';
          const quota7dValText = doc.getElementById('quota-7d-val')?.textContent?.trim() || '';
          const quota5hSubText = doc.getElementById('quota-5h-sub')?.textContent?.trim() || '';
          const quota7dSubText = doc.getElementById('quota-7d-sub')?.textContent?.trim() || '';
          const quotaPlanText = doc.getElementById('quota-plan-label')?.textContent?.trim() || '';
          const quotaCtxCodexVal = doc.getElementById('quota-ctx-val')?.textContent?.trim() || '';
          const quotaCtxCodexSub = doc.getElementById('quota-ctx-sub')?.textContent?.trim() || '';
          const quotaCodexNudgeHidden = doc.getElementById('quota-compress-nudge')?.classList.contains('hidden');

          // Manual Theme Toggle in Topbar: dark(auto) -> light(manual), then host-context-changed(dark) MUST NOT overwrite!
          doc.getElementById('btn-theme-toggle').click();
          await new Promise((r) => setTimeout(r, 120));
          const themeAfterTopbarClick = doc.documentElement.getAttribute('data-theme');
          const lightScrollWidth = doc.documentElement.scrollWidth;

          // Re-open #quota-popover in Light theme + click Refresh -> low-quota warning (<20%)
          if (doc.getElementById('quota-popover')?.classList.contains('hidden')) {
            doc.getElementById('btn-quota-pill').click();
            await new Promise((r) => setTimeout(r, 80));
          }
          const quotaPopLightScrollWidth = doc.documentElement.scrollWidth;
          doc.getElementById('btn-quota-refresh').click();
          await new Promise((r) => setTimeout(r, 140));
          const quotaPillAfterRefresh = doc.getElementById('quota-pill-text')?.textContent?.trim() || '';
          const quotaPillWarnAfterRefresh = doc.getElementById('btn-quota-pill')?.classList.contains('is-warn');
          doc.getElementById('btn-quota-pill').click(); // close popover
          await new Promise((r) => setTimeout(r, 60));

          // Synthetic hostContextChanged while manual 'light' is active -> MUST stay 'light'!
          frame.contentWindow.postMessage({
            jsonrpc: '2.0',
            method: 'ui/notifications/host-context-changed',
            params: { theme: 'dark' }
          }, '*');
          await new Promise((r) => setTimeout(r, 100));
          const themeAfterHostPushWhileManual = doc.documentElement.getAttribute('data-theme');

          const activeChipText = doc.querySelector('.member-chip.active')?.textContent?.trim() || '';
          const inheritedBarVisible = !doc.getElementById('inherited-bar')?.classList.contains('hidden');
          const inheritedTitle = doc.getElementById('inherited-summary-title')?.textContent || '';
          const userBubbleRect = doc.querySelector('.chat-row.is-user .bubble')?.getBoundingClientRect();
          const userCaptionText = doc.querySelector('.chat-row.is-user .chat-caption')?.textContent || '';
          const aiCaptionText = doc.querySelector('.chat-row.is-assistant .chat-caption')?.textContent || '';
          const foldEls = doc.querySelectorAll('.chat-row.is-assistant details.proc-fold');
          const foldCount = foldEls.length;
          const foldText = foldEls[0]?.querySelector('summary')?.textContent?.trim() || '';
          const foldStyle = foldEls[0] ? w.getComputedStyle(foldEls[0]) : null;
          const foldBorderWidth = foldStyle ? foldStyle.borderTopWidth : 'none';
          const foldBgColor = foldStyle ? foldStyle.backgroundColor : 'none';
          const moreBtnCount = doc.querySelectorAll('.bubble-more-btn').length;

          // Click "不再延续" -> unbinds inherited summary
          doc.getElementById('btn-clear-inherited').click();
          await new Promise((r) => setTimeout(r, 150));
          const inheritedHiddenAfterClear = doc.getElementById('inherited-bar')?.classList.contains('hidden');

          // Open Composer Params Popover: verify 6 reasoning levels + dynamic model sync + Turbo preset
          doc.getElementById('btn-params-pop').click();
          await new Promise((r) => setTimeout(r, 100));
          const paramsPopScrollWidth = doc.documentElement.scrollWidth;
          const solEfforts = Array.from(doc.getElementById('ctrl-effort').options).map((o) => o.value);
          doc.getElementById('ctrl-model').value = 'gpt-6-luna';
          doc.getElementById('ctrl-model').dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 60));
          const lunaEfforts = Array.from(doc.getElementById('ctrl-effort').options).map((o) => o.value);

          doc.querySelector('[data-preset-scope="composer"][data-preset="turbo"]').click();
          await new Promise((r) => setTimeout(r, 100));
          const turboScrollWidth = doc.documentElement.scrollWidth;
          const turboPathText = doc.getElementById('path-summary')?.textContent || '';
          const turboPathIsAmber = doc.getElementById('path-summary')?.classList.contains('is-turbo');
          const turboHintText = doc.getElementById('shadow-hint')?.textContent || '';

          // Two-stage Emergency Trip button test (while in Turbo mode with 1 running job!)
          const tripBtn = doc.getElementById('btn-emergency-trip');
          const tripInitialText = tripBtn?.textContent || '';
          tripBtn.click(); // Click 1: arm
          await new Promise((r) => setTimeout(r, 80));
          const tripArmedText = tripBtn?.textContent || '';
          const tripArmedScrollWidth = doc.documentElement.scrollWidth;
          const tripNotYetCalled = !window.__REPORT__.calls.includes('app_emergency_trip');
          tripBtn.click(); // Click 2: execute global trip + downgrade Turbo -> shadow!
          await new Promise((r) => setTimeout(r, 200));
          const tripHiddenAfter = tripBtn?.classList.contains('hidden');
          const restoredPathText = doc.getElementById('path-summary')?.textContent || '';

          // Review View
          doc.getElementById('tab-review').click();
          await new Promise((r) => setTimeout(r, 250));
          const reviewScrollWidth = doc.documentElement.scrollWidth;
          doc.getElementById('tab-station').click();
          await new Promise((r) => setTimeout(r, 80));

          // Settings Modal (3 tabs) — check v0.3.1 + v0.4 persona fields (addressUserAs + long-term memories)
          doc.getElementById('btn-settings').click();
          await new Promise((r) => setTimeout(r, 120));
          const pmCleanChecked = Boolean(doc.getElementById('pm-clean-config')?.checked);
          const pmFastExists = Boolean(doc.getElementById('pm-fast-mode'));
          const pmEfforts = Array.from(doc.getElementById('pm-effort').options).map((o) => o.value);
          const pmAddressAsVal = doc.getElementById('pm-address-as')?.value || '';
          const pmMemInitialCount = doc.getElementById('pm-mem-count')?.textContent || '';
          doc.getElementById('pm-mem-input').value = '所有 SQL 修改必须先看索引';
          doc.getElementById('pm-mem-add').click();
          await new Promise((r) => setTimeout(r, 60));
          const pmMemAfterAddCount = doc.getElementById('pm-mem-count')?.textContent || '';
          const modalMemScrollWidth = doc.documentElement.scrollWidth;
          doc.querySelector('[data-pick-p="ds-r1"]').click();
          await new Promise((r) => setTimeout(r, 100));
          const modalPersonasScrollWidth = doc.documentElement.scrollWidth;
          const hasAvatarPasteBtn = Boolean(doc.getElementById('pm-avatar-paste'));
          const hasCodexPathInput = Boolean(doc.getElementById('pm-codex-path'));
          const apiKeyPlaceholder = doc.getElementById('pm-api-key')?.placeholder || '';
          const apiKeyVal = doc.getElementById('pm-api-key')?.value || '';
          // Verify API quick-fill chips populate Base URL + Model without clobbering typed API Key
          doc.getElementById('pm-api-key').value = 'temp-untouched-key';
          doc.querySelector('[data-api-preset="ollama"]')?.click();
          await new Promise((r) => setTimeout(r, 40));
          const presetBaseUrl = doc.getElementById('pm-base-url')?.value || '';
          const presetModel = doc.getElementById('pm-api-model')?.value || '';
          const presetKeyPreserved = doc.getElementById('pm-api-key')?.value === 'temp-untouched-key';
          // Restore ds-r1 values before testing connection
          doc.querySelector('[data-api-preset="deepseek"]')?.click();
          doc.getElementById('pm-api-key').value = '';
          await new Promise((r) => setTimeout(r, 40));
          doc.getElementById('pm-test-conn').click();
          await new Promise((r) => setTimeout(r, 200));
          const testResText = doc.getElementById('pm-test-result')?.textContent || '';

          // Tab 2: Profile + 3-way theme segmented control
          doc.getElementById('stab-profile').click();
          await new Promise((r) => setTimeout(r, 100));
          const modalProfileScrollWidth = doc.documentElement.scrollWidth;
          const hasProfilePasteBtn = Boolean(doc.getElementById('up-avatar-paste'));
          const profileNameVal = doc.getElementById('up-name')?.value || '';
          const profileThemeActiveBefore = doc.querySelector('#up-theme-seg .seg-btn.active')?.dataset?.themeVal || '';

          // Switch to dark via Profile segmented control
          doc.querySelector('#up-theme-seg [data-theme-val="dark"]').click();
          await new Promise((r) => setTimeout(r, 120));
          const themeAfterProfileDark = doc.documentElement.getAttribute('data-theme');
          const modalProfileDarkScrollWidth = doc.documentElement.scrollWidth;

          // Switch back to auto -> follows cached hostTheme ('dark'), then verify host push ('light') updates it
          doc.querySelector('#up-theme-seg [data-theme-val="auto"]').click();
          await new Promise((r) => setTimeout(r, 120));
          const themeAfterProfileAuto = doc.documentElement.getAttribute('data-theme');
          frame.contentWindow.postMessage({
            jsonrpc: '2.0',
            method: 'ui/notifications/host-context-changed',
            params: { theme: 'light' }
          }, '*');
          await new Promise((r) => setTimeout(r, 100));
          const themeAfterAutoFollowsHostLight = doc.documentElement.getAttribute('data-theme');
          frame.contentWindow.postMessage({
            jsonrpc: '2.0',
            method: 'ui/notifications/host-context-changed',
            params: { theme: 'dark' }
          }, '*');
          await new Promise((r) => setTimeout(r, 80));

          // Tab 3: Default Permissions
          doc.getElementById('stab-perms').click();
          await new Promise((r) => setTimeout(r, 100));
          const modalPermsScrollWidth = doc.documentElement.scrollWidth;
          doc.getElementById('btn-modal-close').click();
          await new Promise((r) => setTimeout(r, 80));

          // New Topic Modal
          doc.getElementById('btn-new-topic').click();
          await new Promise((r) => setTimeout(r, 120));
          const newTopicScrollWidth = doc.documentElement.scrollWidth;
          const ntNeedText = doc.getElementById('nt-summary-need-text')?.textContent || '';
          doc.getElementById('btn-nt-close').click();
          await new Promise((r) => setTimeout(r, 80));

          // Topic Manager Modal + Export
          doc.getElementById('btn-topic-mgr').click();
          await new Promise((r) => setTimeout(r, 120));
          const topicMgrScrollWidth = doc.documentElement.scrollWidth;
          doc.querySelector('[data-tm-export="sess-1"]')?.click();
          await new Promise((r) => setTimeout(r, 150));
          const exportMdVal = doc.getElementById('tm-export-md')?.value || '';
          doc.getElementById('btn-tm-close').click();
          await new Promise((r) => setTimeout(r, 80));

          // Switch to API persona (ds-r1) with 72% context usage -> verify API capsule, hidden Codex section, and compress nudge -> New Topic Modal
          doc.querySelector('[data-member-pick="ds-r1"]')?.click();
          await new Promise((r) => setTimeout(r, 200));
          const quotaPillApiText = doc.getElementById('quota-pill-text')?.textContent?.trim() || '';
          const quotaPillApiWarn = doc.getElementById('btn-quota-pill')?.classList.contains('is-warn');
          doc.getElementById('btn-quota-pill').click();
          await new Promise((r) => setTimeout(r, 100));
          const quotaPopApiScrollWidth = doc.documentElement.scrollWidth;
          const quotaCodexHiddenOnApi = doc.getElementById('quota-codex-section')?.classList.contains('hidden');
          const quotaCtxApiVal = doc.getElementById('quota-ctx-val')?.textContent?.trim() || '';
          const quotaApiNudgeVisible = !doc.getElementById('quota-compress-nudge')?.classList.contains('hidden');
          doc.getElementById('btn-quota-compress').click();
          await new Promise((r) => setTimeout(r, 100));
          const compressOpenedNewTopicModal = !doc.getElementById('new-topic-modal')?.classList.contains('hidden');

          window.__REPORT__.checks = {
            stationScrollWidth,
            lightScrollWidth,
            quotaPopDarkScrollWidth,
            quotaPopLightScrollWidth,
            quotaPopApiScrollWidth,
            paramsPopScrollWidth,
            turboScrollWidth,
            tripArmedScrollWidth,
            reviewScrollWidth,
            modalPersonasScrollWidth,
            modalMemScrollWidth,
            modalProfileScrollWidth,
            modalProfileDarkScrollWidth,
            modalPermsScrollWidth,
            newTopicScrollWidth,
            topicMgrScrollWidth,
            quotaPillCodexText,
            quotaPopOpenDark,
            quota5hValText,
            quota7dValText,
            quota5hSubText,
            quota7dSubText,
            quotaPlanText,
            quotaCtxCodexVal,
            quotaCtxCodexSub,
            quotaCodexNudgeHidden,
            quotaPillAfterRefresh,
            quotaPillWarnAfterRefresh,
            quotaPillApiText,
            quotaPillApiWarn,
            quotaCodexHiddenOnApi,
            quotaCtxApiVal,
            quotaApiNudgeVisible,
            compressOpenedNewTopicModal,
            initialTheme,
            themeAfterTopbarClick,
            themeAfterHostPushWhileManual,
            profileThemeActiveBefore,
            themeAfterProfileDark,
            themeAfterProfileAuto,
            themeAfterAutoFollowsHostLight,
            pmAddressAsVal,
            pmMemInitialCount,
            pmMemAfterAddCount,
            activeChipText,
            inheritedBarVisible,
            inheritedTitle,
            inheritedHiddenAfterClear,
            userBubbleWidth: Math.round(userBubbleRect?.width || 999),
            userCaptionText,
            aiCaptionText,
            foldCount,
            foldText,
            foldBorderWidth,
            foldBgColor,
            moreBtnCount,
            solEfforts,
            lunaEfforts,
            pmEfforts,
            pmCleanChecked,
            pmFastExists,
            tripInitialText,
            tripArmedText,
            tripNotYetCalled,
            tripHiddenAfter,
            turboPathText,
            turboPathIsAmber,
            turboHintText,
            restoredPathText,
            hasAvatarPasteBtn,
            hasCodexPathInput,
            hasProfilePasteBtn,
            profileNameVal,
            apiKeyPlaceholder,
            apiKeyVal,
            presetBaseUrl,
            presetModel,
            presetKeyPreserved,
            testResText,
            ntNeedText,
            exportMdVal,
          };
          window.__REPORT__.done = true;
        } catch (err) {
          window.__REPORT__.errors.push(err.message);
          window.__REPORT__.done = true;
        }
      }, 650);
    });
  </script>
</body>
</html>`;

const srv = createServer((req, res) => {
  if (req.url === '/app.html') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; media-src data: blob:;",
    });
    res.end(html);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(mockHostHtml);
});

await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
const userDataDir = join(tmpdir(), `sidedesk-chrome-${Date.now()}`);

const chrome = spawn(
  chromeExe,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    `http://127.0.0.1:${port}/`,
  ],
  { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
);

let cdpUrl = '';
await new Promise((resolveReady, rejectReady) => {
  const timer = setTimeout(() => rejectReady(new Error('Chrome CDP startup timeout')), 15000);
  chrome.stderr.setEncoding('utf8');
  chrome.stderr.on('data', (chunk) => {
    const m = chunk.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (m) {
      cdpUrl = m[1];
      clearTimeout(timer);
      resolveReady();
    }
  });
});

try {
  const dbgPort = new URL(cdpUrl).port;
  const targets = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json();
  const pageTarget = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));

  let seq = 1;
  const cdpCall = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = seq++;
      const onMsg = (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.id === id) {
          ws.removeEventListener('message', onMsg);
          if (msg.error) rej(new Error(msg.error.message));
          else res(msg.result);
        }
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({ id, method, params }));
    });

  let report = null;
  for (let i = 0; i < 30; i++) {
    const r = await cdpCall('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__REPORT__)',
      returnByValue: true,
    });
    const parsed = JSON.parse(r.result.value || '{}');
    if (parsed.done) {
      report = parsed;
      break;
    }
    await new Promise((w) => setTimeout(w, 250));
  }
  ws.close();

  assert.ok(report, 'Report did not complete');
  console.log('Browser Verification Report:', JSON.stringify(report, null, 2));

  assert.equal(report.initDone, true);
  assert.deepEqual(report.cspViolations, [], 'ZERO CSP violations required');
  assert.deepEqual(report.errors, [], 'ZERO runtime errors required');
  assert.ok(report.calls.includes('app_clear_inherited_summary'), 'Must call app_clear_inherited_summary');
  assert.ok(report.calls.includes('app_emergency_trip'), 'Must call app_emergency_trip on 2nd click');
  assert.ok(report.calls.includes('app_export_session'), 'Must call app_export_session');
  assert.ok(report.calls.includes('app_test_provider'), 'Must call app_test_provider');
  assert.ok(report.calls.includes('app_refresh_quota'), 'Must call app_refresh_quota');
  assert.ok(report.calls.includes('app_set_theme'), 'Must call app_set_theme');
  assert.deepEqual(report.themeCalls, ['light', 'dark', 'auto'], 'Expected theme toggle sequence light -> dark -> auto');

  const c = report.checks;
  for (const [k, v] of [
    ['stationScrollWidth', c.stationScrollWidth],
    ['lightScrollWidth', c.lightScrollWidth],
    ['quotaPopDarkScrollWidth', c.quotaPopDarkScrollWidth],
    ['quotaPopLightScrollWidth', c.quotaPopLightScrollWidth],
    ['quotaPopApiScrollWidth', c.quotaPopApiScrollWidth],
    ['paramsPopScrollWidth', c.paramsPopScrollWidth],
    ['turboScrollWidth', c.turboScrollWidth],
    ['tripArmedScrollWidth', c.tripArmedScrollWidth],
    ['reviewScrollWidth', c.reviewScrollWidth],
    ['modalPersonasScrollWidth', c.modalPersonasScrollWidth],
    ['modalMemScrollWidth', c.modalMemScrollWidth],
    ['modalProfileScrollWidth', c.modalProfileScrollWidth],
    ['modalProfileDarkScrollWidth', c.modalProfileDarkScrollWidth],
    ['modalPermsScrollWidth', c.modalPermsScrollWidth],
    ['newTopicScrollWidth', c.newTopicScrollWidth],
    ['topicMgrScrollWidth', c.topicMgrScrollWidth],
  ]) {
    assert.ok(v <= 360, `360px overflow in ${k}: ${v}`);
  }

  assert.equal(c.initialTheme, 'dark', 'Auto mode must follow initial dark host theme');
  assert.equal(c.themeAfterTopbarClick, 'light', 'Topbar toggle must switch dark -> light immediately');
  assert.equal(c.themeAfterHostPushWhileManual, 'light', 'Host context change MUST NOT overwrite manual light theme');
  assert.equal(c.profileThemeActiveBefore, 'light', 'Profile segmented control must reflect manual light mode');
  assert.equal(c.themeAfterProfileDark, 'dark', 'Profile segmented control must switch to dark');
  assert.equal(c.themeAfterProfileAuto, 'dark', 'Switching back to auto must apply cached hostTheme (dark)');
  assert.equal(c.themeAfterAutoFollowsHostLight, 'light', 'Auto mode must resume following host-context-changed');

  assert.ok(c.activeChipText.includes('Codex 的工位'));
  assert.equal(c.inheritedBarVisible, true);
  assert.ok(c.inheritedTitle.includes('延续「历史方案讨论」的摘要'));
  assert.equal(c.inheritedHiddenAfterClear, true);
  assert.ok(c.userBubbleWidth > 20 && c.userBubbleWidth < 120, `Short bubble '111' must stay compact, got ${c.userBubbleWidth}px`);
  assert.ok(c.userCaptionText.includes('老板'));
  assert.equal(c.userCaptionText.includes('副席直发'), false);
  assert.equal(c.userCaptionText.includes('影子可写'), false);
  assert.equal(c.aiCaptionText.includes('[Codex]'), false);
  assert.equal(c.moreBtnCount, 0, 'Top-right .bubble-more-btn must be completely removed');
  assert.equal(c.foldCount, 1, 'Fluff-only message m3 must render ZERO <details>; m2 must render 1');
  assert.equal(c.foldText, '执行过程 (2)');
  assert.equal(c.foldBorderWidth, '0px', 'Borderless text-only fold required');
  assert.equal(c.foldBgColor, 'rgba(0, 0, 0, 0)', 'Transparent background fold required');
  assert.deepEqual(c.solEfforts, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(c.lunaEfforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(c.pmEfforts, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.equal(c.pmCleanChecked, true);
  assert.equal(c.pmFastExists, true);
  assert.equal(c.pmAddressAsVal, '老板');
  assert.equal(c.pmMemInitialCount, '1/2 生效');
  assert.equal(c.pmMemAfterAddCount, '2/3 生效');
  assert.equal(c.tripInitialText, '🛑 急停 (1)');
  assert.equal(c.tripArmedText, '⚠️ 再点立即全停');
  assert.equal(c.tripNotYetCalled, true, '1st click must arm only without firing trip');
  assert.equal(c.tripHiddenAfter, true);
  assert.equal(c.turboPathIsAmber, true);
  assert.ok(c.turboPathText.includes('⚡ 直接读写：my-backend'));
  assert.equal(c.turboHintText, '⚡ 直接读写当前文件夹');
  assert.ok(c.restoredPathText.includes('影子隔离：my-backend'));
  assert.equal(c.hasAvatarPasteBtn, true);
  assert.equal(c.hasCodexPathInput, true);
  assert.equal(c.hasProfilePasteBtn, true);
  assert.equal(c.profileNameVal, '老板');
  assert.equal(c.apiKeyVal, '');
  assert.ok(c.apiKeyPlaceholder.includes('sk-...8899'));
  assert.equal(c.presetBaseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(c.presetModel, 'qwen2.5-coder:14b');
  assert.equal(c.presetKeyPreserved, true, 'API preset chip MUST NOT overwrite existing API key');
  assert.ok(c.testResText.includes('连接成功') && c.testResText.includes('128ms'));
  assert.ok(c.ntNeedText.includes('鉴权并发审计') && c.ntNeedText.includes('压缩成摘要'));
  assert.ok(c.exportMdVal.includes('鉴权并发审计'));

  // v1.1 Quota Capsule & Details Popover assertions (Codex + Light/Dark + Low-Quota Warning + API + High-Context Nudge)
  assert.equal(c.quotaPillCodexText, '5h 98% · 周 71% · 上下文 4%');
  assert.equal(c.quotaPopOpenDark, true);
  assert.equal(c.quota5hValText, '剩余 98%（已用 2%）');
  assert.equal(c.quota7dValText, '剩余 71%（已用 29%）');
  assert.ok(c.quota5hSubText.includes('后重置 · '), `Unexpected 5h reset text: ${c.quota5hSubText}`);
  assert.ok(c.quota7dSubText.includes('重置'), `Unexpected 7d reset text: ${c.quota7dSubText}`);
  assert.equal(c.quotaPlanText, 'Plan: Plus');
  assert.equal(c.quotaCtxCodexVal, '已用 21.1K / 475K (4.4%)');
  assert.ok(c.quotaCtxCodexSub.includes('缓存命中 14.2K'));
  assert.equal(c.quotaCodexNudgeHidden, true);
  assert.equal(c.quotaPillAfterRefresh, '5h 16% · 周 71% · 上下文 4%');
  assert.equal(c.quotaPillWarnAfterRefresh, true, 'Remaining < 20% must apply .is-warn amber styling');
  assert.equal(c.quotaPillApiText, '上下文 92.2K (72%)');
  assert.equal(c.quotaPillApiText.includes('5h') || c.quotaPillApiText.includes('周'), false, 'API persona must NOT show Codex 5h/weekly quota');
  assert.equal(c.quotaPillApiWarn, true, 'Context >= 65% must apply .is-warn styling');
  assert.equal(c.quotaCodexHiddenOnApi, true, 'API persona must hide Codex quota section inside #quota-popover');
  assert.equal(c.quotaCtxApiVal, '已用 92.2K / 128K (72%)');
  assert.equal(c.quotaApiNudgeVisible, true, 'Context >= 65% must show compress nudge');
  assert.equal(c.compressOpenedNewTopicModal, true, 'Clicking compress nudge must open New Topic / Context Compression modal');

  pass('3. Headless Chrome 360px 实测（零溢出 / 零 CSP 违规 / Light+Dark 双主题配额浮层 / 5h&周剩余与低额度预警 / API 上下文水位与 65% 压缩引导全通）');
  console.log('\n🎉 SIDEDESK v1.1 UI VERIFICATION PASSED 100%!');
} finally {
  chrome.kill();
  srv.close();
  setTimeout(() => {
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }, 300);
}
