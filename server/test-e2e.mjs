import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { esc, isImageAvatar, renderMarkdown } from '../app/src/sanitize.js';
import {
  ANTI_ESCAPE_GUARDRAIL,
  buildCodexArgs,
  buildDeveloperInstructions,
} from './codex-runner.mjs';
import {
  buildOpenAiContextUsage,
  executeShadowTool,
  executeToolAsync,
  resolveChatCompletionsUrl,
  resolveSafeShadowPath,
} from './openai-runner.mjs';
import {
  CodexQuotaReader,
  parseTokenCountFromJsonlText,
  readTailTextAsync,
} from './quota-reader.mjs';
import {
  composeOutboundUserPayload,
  composePersonaProfileBlock,
  composeTurnGuidanceHeader,
  evaluateAnchorSync,
} from './prompt-composer.mjs';
import { RunnerHub } from './runner-hub.mjs';
import {
  buildAugmentedEnv,
  getAutoNodeDir,
  isSameEndpointHost,
  isSameOrInsideRealPath,
  redactSecrets,
} from './security.mjs';
import {
  applyShadowToSource,
  assertInsideRoot,
  computeShadowDiff,
  createShadowCopy,
  discardShadow,
  inspectDirectGitStatus,
  prescanSourceDir,
  ShadowLimitError,
  sha256File,
  undoLastApply,
  verifySourceUntouched,
} from './shadow-engine.mjs';
import {
  hasFreshSessionSummary,
  maskApiKey,
  readCodexUserDefaults,
  sanitizePersonaForApp,
  sanitizePersonaForModel,
  SideDeskStore,
} from './store.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootTmp = join(tmpdir(), `sidedesk-e2e-${Date.now()}`);
const dataDir = join(rootTmp, 'plugin_data');
const sourceDir = join(rootTmp, 'mock_project');
const bigCountDir = join(rootTmp, 'big_count');
const bigBytesDir = join(rootTmp, 'big_bytes');

mkdirSync(dataDir, { recursive: true });
mkdirSync(sourceDir, { recursive: true });
mkdirSync(bigCountDir, { recursive: true });
mkdirSync(bigBytesDir, { recursive: true });

const origAppPy = `def divide(a, b):\n    # BUG: missing zero division check\n    return a / b\n`;
writeFileSync(join(sourceDir, 'app.py'), origAppPy, 'utf8');
writeFileSync(join(sourceDir, 'README.md'), '# 示例后端项目\n', 'utf8');
for (const skip of ['node_modules', '.git', 'dist', '.venv', '__pycache__']) {
  mkdirSync(join(sourceDir, skip), { recursive: true });
  writeFileSync(join(sourceDir, skip, 'dummy.txt'), 'skip-me', 'utf8');
}
const origAppHash = sha256File(join(sourceDir, 'app.py'));

function pass(name, detail = '') {
  console.log(`✅ [PASS] ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// Local Mock OpenAI-Compatible HTTP Server (SSE + reasoning + tool loop + slow abort)
// ---------------------------------------------------------------------------
const mockRequests = [];
const mockServer = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    mockRequests.push({
      url: req.url,
      auth: req.headers.authorization || '',
      body,
    });

    const userMsgs = (body.messages || []).filter((m) => m.role === 'user');
    const lastUserRaw = userMsgs[userMsgs.length - 1]?.content;
    const lastUser = Array.isArray(lastUserRaw)
      ? lastUserRaw.map((b) => (b.type === 'text' ? b.text : `[IMG:${Boolean(b.image_url?.url)}]`)).join(' ')
      : String(lastUserRaw || '');
    const sysMsg = String((body.messages || []).find((m) => m.role === 'system')?.content || '');
    const toolMsgs = (body.messages || []).filter((m) => m.role === 'tool');

    // Simulated upstream 401 error echoing back the caller's Authorization Bearer token & raw API key
    if (body.model === 'leak-test-model' || lastUser.includes('LEAK_KEY_ERROR_TEST')) {
      const authHeader = String(req.headers.authorization || '');
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            message: `Invalid credentials: ${authHeader} raw=${authHeader.replace(/^Bearer\s+/i, '')}`,
          },
        })
      );
      return;
    }

    // Non-streaming ping for connection test
    if (body.stream === false) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'cmpl-ping',
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }],
        })
      );
      return;
    }

    // Summarization request (one-shot context compression)
    if (sysMsg.includes('工程上下文压缩助手')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: '压缩摘要：已完成 app.py 除零检查与并发分析，下一步优化缓存。' } }],
        })}\n\n`
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // Echo system prompt, tool names, and multimodal image presence for v0.3 assertions
    if (lastUser.includes('V03_INSPECT_CALL')) {
      const toolNames = (body.tools || []).map((t) => t.function?.name);
      const hasImageBlock =
        Array.isArray(lastUserRaw) &&
        lastUserRaw.some((b) => b.type === 'image_url' && String(b.image_url?.url || '').startsWith('data:image/png;base64,'));
      const payload = JSON.stringify({
        hasUserName: sysMsg.includes('称呼对方为「老板阿明」'),
        hasInherited: sysMsg.includes('压缩摘要：已完成 app.py 除零检查与并发分析'),
        hasRunCommand: toolNames.includes('run_command'),
        hasImageBlock,
      });
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `INSPECT=${payload}` } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // v0.4 Echo outbound system + user payload characteristics for anchor/guidance/rollback verification
    if (lastUser.includes('V04_ANCHOR_PROBE')) {
      const priorUsers = userMsgs.slice(0, -1).map((m) => String(m.content || ''));
      const payload = JSON.stringify({
        hasGuidance: lastUser.includes('【本轮态势与协作提醒】'),
        hasAntiOverEng: lastUser.includes('避免过度工程化'),
        hasRecencySync: lastUser.includes('【最新角色设定与记忆同步】'),
        hasRollbackNotice: lastUser.includes('用户刚刚撤回了上一轮的文件改动'),
        sysHasAddressOwner: sysMsg.includes('称呼对方为「主人」'),
        sysHasAddressFallback: sysMsg.includes('称呼对方为「老板阿明」'),
        sysHasEnabledMem: sysMsg.includes('偏好使用严格类型检查'),
        sysHasDisabledMem: sysMsg.includes('这条停用记忆绝不能出现'),
        sysHasHotNewMem: sysMsg.includes('热更新新增记忆条款'),
        userHasHotNewMem: lastUser.includes('热更新新增记忆条款'),
        priorHistoryLeakedHeader: priorUsers.some(
          (t) => t.includes('【本轮态势与协作提醒】') || t.includes('【最新角色设定与记忆同步】')
        ),
      });
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `V04=${payload}` } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // v1.1 OpenAI-compatible context usage probes (DeepSeek cache hit + OpenAI multi-round cached_tokens)
    if (lastUser.includes('QUOTA_CTX_PROBE_DS')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: 'DS_USAGE_OK' } }],
          usage: {
            prompt_tokens: 42000,
            completion_tokens: 1500,
            total_tokens: 43500,
            prompt_cache_hit_tokens: 28000,
          },
        })}\n\n`
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (lastUser.includes('QUOTA_CTX_PROBE_OAI')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      if (toolMsgs.length === 0) {
        res.write(
          `data: ${JSON.stringify({
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call_ctx_list',
                  type: 'function',
                  function: { name: 'list_files', arguments: '{}' },
                }],
              },
            }],
            usage: {
              prompt_tokens: 10000,
              completion_tokens: 120,
              total_tokens: 10120,
              prompt_tokens_details: { cached_tokens: 4000 },
            },
          })}\n\n`
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: 'OAI_USAGE_OK' } }],
          usage: {
            prompt_tokens: 85000,
            completion_tokens: 2200,
            total_tokens: 87200,
            prompt_tokens_details: { cached_tokens: 51000 },
          },
        })}\n\n`
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // Slow SSE stream for abort test
    if (lastUser.includes('SLOW_STREAM_ABORT')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '准备长时间流式思考...' } }] })}\n\n`
      );
      const iv = setInterval(() => {
        if (res.writableEnded || res.destroyed) {
          clearInterval(iv);
          return;
        }
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '持续思考中...' } }] })}\n\n`
        );
      }, 200);
      req.on('close', () => clearInterval(iv));
      return;
    }

    // Read-only test: verify tools omit write tools
    if (lastUser.includes('READONLY_CHECK')) {
      const toolNames = (body.tools || []).map((t) => t.function?.name);
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '检查只读沙箱工具列表...' } }] })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: `TOOLS=${toolNames.join(',')}` } }] })}\n\n`
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // Multi-turn follow-up check
    if (lastUser.includes('FOLLOWUP_MEMORY')) {
      const sawPrev = (body.messages || []).some(
        (m) => m.role === 'user' && String(m.content || '').includes('AGENT_FIX_TASK')
      );
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: sawPrev ? 'REMEMBERED_TURN_1' : 'FORGOT_TURN_1' } }] })}\n\n`
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // Turbo direct: test run_command + external read_file + direct write_file
    if (lastUser.includes('TURBO_DIRECT_AGENT')) {
      const toolNames = (body.tools || []).map((t) => t.function?.name);
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      if (toolMsgs.length === 0) {
        const extMatch = lastUser.match(/EXT_FILE=(.+)/);
        const extPath = extMatch ? extMatch[1].trim() : '';
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: `Turbo模式工具: ${toolNames.join(',')}` } }] })}\n\n`
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [{
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_turbo_read_ext',
                    type: 'function',
                    function: { name: 'read_file', arguments: JSON.stringify({ path: extPath }) },
                  },
                  {
                    index: 1,
                    id: 'call_turbo_write',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: JSON.stringify({
                        path: 'turbo_written.txt',
                        content: 'DIRECT_WRITE_OK\n',
                      }),
                    },
                  },
                  {
                    index: 2,
                    id: 'call_turbo_cmd',
                    type: 'function',
                    function: {
                      name: 'run_command',
                      arguments: JSON.stringify({ command: 'Write-Output "TURBO_CMD_OK"', timeoutSec: 15 }),
                    },
                  },
                ],
              },
            }],
          })}\n\n`
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      const joinedTools = toolMsgs.map((m) => String(m.content || '')).join('\n');
      const okAll =
        toolNames.includes('run_command') &&
        joinedTools.includes('EXTERNAL_SECRET_REF_42') &&
        joinedTools.includes('TURBO_CMD_OK') &&
        joinedTools.includes('bytesWritten');
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: okAll ? 'TURBO_DIRECT_ALL_OK' : `TURBO_FAIL:${joinedTools.slice(0, 200)}` } }],
        })}\n\n`
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // Turbo direct: slow run_command for abort tree-kill test
    if (lastUser.includes('TURBO_CMD_ABORT')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      if (toolMsgs.length === 0) {
        res.write(
          `data: ${JSON.stringify({
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call_turbo_sleep',
                  type: 'function',
                  function: {
                    name: 'run_command',
                    arguments: JSON.stringify({ command: 'Start-Sleep -Seconds 25', timeoutSec: 40 }),
                  },
                }],
              },
            }],
          })}\n\n`
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'SHOULD_HAVE_ABORTED' } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // Agentic tool loop: round 1 calls read_file, round 2 calls write_file + edit_file, round 3 finishes
    if (lastUser.includes('AGENT_FIX_TASK')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      if (toolMsgs.length === 0) {
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '先读取 app.py 检查除零风险。\n' } }] })}\n\n`
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call_read_1',
                  type: 'function',
                  function: { name: 'read_file', arguments: '{"path":"app.py"}' },
                }],
              },
            }],
          })}\n\n`
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      if (toolMsgs.length === 1) {
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '确认缺少 b == 0 检查，写入修复与报告。\n' } }] })}\n\n`
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [{
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_edit_1',
                    type: 'function',
                    function: {
                      name: 'edit_file',
                      arguments: JSON.stringify({
                        path: 'app.py',
                        old_text: '    return a / b',
                        new_text: '    if b == 0:\n        raise ValueError("zero")\n    return a / b',
                      }),
                    },
                  },
                  {
                    index: 1,
                    id: 'call_write_1',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: JSON.stringify({
                        path: 'api_audit.md',
                        content: '# API 引擎审计报告\n已修复除零漏洞。\n',
                      }),
                    },
                  },
                ],
              },
            }],
          })}\n\n`
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: '已完成影子副本修复：更新 `app.py` 并生成 `api_audit.md`。' } }],
          usage: { prompt_tokens: 120, completion_tokens: 28 },
        })}\n\n`
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'DEFAULT_OK' } }] }));
  });
});

await new Promise((r) => mockServer.listen(0, '127.0.0.1', r));
const mockPort = mockServer.address().port;
const mockBaseUrl = `http://127.0.0.1:${mockPort}`;

try {
  // -------------------------------------------------------------------------
  // 1. Circuit breaker + Heavy directory skip
  // -------------------------------------------------------------------------
  for (let i = 0; i < 8; i++) writeFileSync(join(bigCountDir, `f${i}.txt`), 'x', 'utf8');
  assert.throws(() => prescanSourceDir(bigCountDir, { maxFiles: 5 }), ShadowLimitError);
  writeFileSync(join(bigBytesDir, 'blob.bin'), Buffer.alloc(4096, 65));
  assert.throws(() => prescanSourceDir(bigBytesDir, { maxBytes: 1024 }), ShadowLimitError);

  const store = new SideDeskStore(dataDir);
  const shSkip = createShadowCopy(store, sourceDir);
  assert.equal(shSkip.fileCount, 2);
  for (const skip of ['node_modules', 'dist', '.venv', '__pycache__']) {
    assert.equal(existsSync(join(shSkip.workDir, skip)), false);
  }
  discardShadow(store, shSkip.id);
  pass('1. 大目录双限熔断 + 重目录零拷贝无软链');

  // -------------------------------------------------------------------------
  // 2. Base URL normalization + API Key masking & preservation semantics
  // -------------------------------------------------------------------------
  assert.equal(resolveChatCompletionsUrl('https://api.deepseek.com'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(resolveChatCompletionsUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(resolveChatCompletionsUrl('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(resolveChatCompletionsUrl('http://127.0.0.1:11434/v1/chat/completions'), 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(maskApiKey('sk-secret-99887766'), 'sk-...7766');
  assert.equal(maskApiKey(''), '');

  const apiPersona = store.savePersona({
    id: 'ds-r1',
    name: 'DeepSeek 审计官',
    provider: 'openai-compatible',
    baseUrl: mockBaseUrl,
    apiKey: 'sk-secret-99887766',
    model: 'deepseek-reasoner',
    toolMode: 'agent',
    defaultSandbox: 'workspace-write',
  });
  const modelView = sanitizePersonaForModel(apiPersona);
  assert.equal('apiKey' in modelView, false);
  assert.equal('apiKeyHint' in modelView, false);
  assert.equal(JSON.stringify(modelView).includes('99887766'), false);

  const appView = sanitizePersonaForApp(apiPersona);
  assert.equal('apiKey' in appView, false);
  assert.equal(appView.hasApiKey, true);
  assert.equal(appView.apiKeyHint, 'sk-...7766');
  assert.equal(JSON.stringify(appView).includes('sk-secret-99887766'), false);

  // Blank apiKey preserves existing key
  store.savePersona({ id: 'ds-r1', name: 'DeepSeek 审计官', apiKey: '' });
  assert.equal(store.getPersona('ds-r1').apiKey, 'sk-secret-99887766');
  pass('2. Base URL 智能规范化 + API Key 严格掩码脱敏与留空保留');

  // -------------------------------------------------------------------------
  // 3. OpenAI-Compatible Engine: Test Connection + SSE + Reasoning + Tool Loop + Multi-turn + Read-only + Escape Block + Abort
  // -------------------------------------------------------------------------
  const hub = new RunnerHub(store);

  // 3a: Connection test (reuses saved key without re-passing)
  const connRes = await hub.testOpenAiConnection({
    baseUrl: mockBaseUrl,
    model: 'deepseek-reasoner',
    existingPersonaId: 'ds-r1',
  });
  assert.equal(connRes.ok, true);
  assert.equal(mockRequests.at(-1).auth, 'Bearer sk-secret-99887766');

  // 3b: Non-blocking <50ms startJob + SSE + reasoning_content + shadow write tools
  const t0 = Date.now();
  const { job: apiJob1, session: apiSess } = hub.startJob({
    sourceDir,
    personaId: 'ds-r1',
    sandbox: 'workspace-write',
    createdBy: 'hakimi',
    prompt: 'AGENT_FIX_TASK 请审计并修复 app.py',
  });
  const dispatchLatencyMs = Date.now() - t0;
  assert.ok(dispatchLatencyMs < 150, `startJob should return fast without blocking shadow copy; got ${dispatchLatencyMs}ms`);
  assert.equal(apiJob1.stage, 'preparing_shadow');

  const apiDone1 = await hub.waitForJob(apiJob1.id, 30);
  assert.equal(apiDone1.status, 'completed', `API job failed: ${apiDone1.error}`);
  assert.ok(apiDone1.events.some((e) => e.kind === 'reasoning' && e.text.includes('除零风险')), 'Must capture reasoning_content into events');
  assert.ok(apiDone1.diffSummary?.hasChanges, 'API tool loop must generate shadow diff');
  assert.ok(apiDone1.sourceIntegrity?.untouched === true, 'Original sourceDir must remain 100% untouched');
  assert.equal(sha256File(join(sourceDir, 'app.py')), origAppHash);
  assert.equal(existsSync(join(sourceDir, 'api_audit.md')), false);

  const apiShadow = store.getShadow(apiDone1.shadowId);
  const apiDiff = computeShadowDiff(apiShadow);
  assert.ok(apiDiff.files.some((f) => f.path === 'app.py' && f.status === 'modified'));
  assert.ok(apiDiff.files.some((f) => f.path === 'api_audit.md' && f.status === 'added'));

  // 3c: Multi-turn session continuation
  const { job: apiJob2 } = hub.startJob({
    sourceDir,
    sessionId: apiSess.id,
    sandbox: 'read-only',
    createdBy: 'boss',
    prompt: 'FOLLOWUP_MEMORY 确认上下文',
  });
  const apiDone2 = await hub.waitForJob(apiJob2.id, 20);
  assert.equal(apiDone2.status, 'completed');
  assert.ok(apiDone2.finalReply.includes('REMEMBERED_TURN_1'), `Expected multi-turn memory, got: ${apiDone2.finalReply}`);

  // 3d: Read-only sandbox omits write tools AND secondary executor rejects writes
  const { job: apiRoJob } = hub.startJob({
    sourceDir,
    sessionId: apiSess.id,
    sandbox: 'read-only',
    createdBy: 'hakimi',
    prompt: 'READONLY_CHECK',
  });
  const apiRoDone = await hub.waitForJob(apiRoJob.id, 20);
  assert.equal(apiRoDone.status, 'completed');
  assert.ok(apiRoDone.finalReply.includes('list_files,search_text,read_file'));
  assert.equal(apiRoDone.finalReply.includes('write_file'), false);
  const roWriteBlock = executeShadowTool(apiShadow.workDir, 'read-only', 'write_file', {
    path: 'hack.txt',
    content: 'nope',
  });
  assert.equal(roWriteBlock.ok, false);
  assert.match(roWriteBlock.error, /只读沙箱/);

  // 3e: Path traversal & absolute path hard guard
  assert.throws(() => resolveSafeShadowPath(apiShadow.workDir, '../escape.txt', { allowMissingLeaf: true }), /越界拦截/);
  assert.throws(() => resolveSafeShadowPath(apiShadow.workDir, 'C:\\Windows\\win.ini'), /越界拦截/);
  assert.throws(() => resolveSafeShadowPath(apiShadow.workDir, '.git/config'), /越界拦截/);
  const escToolRes = executeShadowTool(apiShadow.workDir, 'workspace-write', 'write_file', {
    path: '../outside.txt',
    content: 'bad',
  });
  assert.equal(escToolRes.ok, false);
  assert.match(escToolRes.error, /越界拦截/);

  // 3f: Instant AbortController mid-stream cancellation
  const { job: apiAbortJob } = hub.startJob({
    sourceDir,
    sessionId: apiSess.id,
    sandbox: 'read-only',
    createdBy: 'boss',
    prompt: 'SLOW_STREAM_ABORT',
  });
  await new Promise((r) => setTimeout(r, 350));
  const tAbort = Date.now();
  hub.abortJob(apiAbortJob.id, 'E2E中断SSE流');
  const apiAborted = await hub.waitForJob(apiAbortJob.id, 5);
  assert.equal(apiAborted.status, 'aborted');
  assert.ok(Date.now() - tAbort < 2000, 'SSE abort should finish quickly');

  discardShadow(store, apiShadow.id);
  pass(
    '3. OpenAI 兼容引擎全链路（<50ms瞬回/SSE+reasoning/影子工具循环/多轮续聊/只读拦截/越界拦截/AbortController秒停）',
    `startJob=${dispatchLatencyMs}ms`
  );

  // -------------------------------------------------------------------------
  // 3.5. Turbo-Direct Mode: Bypass Shadow Breaker + run_command + External Read + Direct Write + Abort + Codex Args
  // -------------------------------------------------------------------------
  const turboDir = join(rootTmp, 'turbo_project');
  const extRefFile = join(rootTmp, 'external_ref.txt');
  mkdirSync(turboDir, { recursive: true });
  writeFileSync(join(turboDir, 'a.txt'), 'alpha\n', 'utf8');
  writeFileSync(join(turboDir, 'b.txt'), 'beta\n', 'utf8');
  writeFileSync(join(turboDir, 'c.txt'), 'gamma\n', 'utf8');
  writeFileSync(extRefFile, 'EXTERNAL_SECRET_REF_42\n', 'utf8');

  // 3.5a: workspace-write MUST trip shadowLimits { maxFiles: 1 }
  const { job: blockedJob } = hub.startJob({
    sourceDir: turboDir,
    personaId: 'ds-r1',
    sandbox: 'workspace-write',
    shadowLimits: { maxFiles: 1 },
    createdBy: 'boss',
    prompt: 'READONLY_CHECK',
  });
  const blockedDone = await hub.waitForJob(blockedJob.id, 10);
  assert.equal(blockedDone.status, 'failed');
  assert.match(blockedDone.error, /超出安全阈值|文件/);

  // 3.5b: run_command MUST be blocked outside turbo-direct
  const cmdBlocked = await executeToolAsync(turboDir, 'workspace-write', 'run_command', {
    command: 'Write-Output "NOPE"',
  });
  assert.equal(cmdBlocked.ok, false);
  assert.match(cmdBlocked.error, /turbo-direct/);

  // 3.5c: turbo-direct bypasses maxFiles: 1, creates ZERO shadow, reads external file, writes directly, runs command
  const shadowsBefore = store.state.shadows.length;
  const tTurbo = Date.now();
  const { job: turboApiJob, shadow: turboShadow } = hub.startJob({
    sourceDir: turboDir,
    personaId: 'ds-r1',
    sandbox: 'turbo-direct',
    shadowLimits: { maxFiles: 1 },
    createdBy: 'boss',
    prompt: `TURBO_DIRECT_AGENT\nEXT_FILE=${extRefFile}`,
  });
  const turboDispatchMs = Date.now() - tTurbo;
  assert.ok(turboDispatchMs < 100, `turbo-direct startJob must be <50ms, got ${turboDispatchMs}ms`);
  assert.equal(turboShadow, null);
  assert.equal(turboApiJob.shadowId, null);
  assert.equal(turboApiJob.directMode, true);

  const turboApiDone = await hub.waitForJob(turboApiJob.id, 30);
  assert.equal(turboApiDone.status, 'completed', `Turbo API failed: ${turboApiDone.error}`);
  assert.equal(turboApiDone.shadowId, null);
  assert.equal(turboApiDone.directMode, true);
  assert.equal(store.state.shadows.length, shadowsBefore, 'turbo-direct must create ZERO shadows');
  assert.ok(turboApiDone.finalReply.includes('TURBO_DIRECT_ALL_OK'), `Unexpected reply: ${turboApiDone.finalReply}`);
  assert.equal(readFileSync(join(turboDir, 'turbo_written.txt'), 'utf8'), 'DIRECT_WRITE_OK\n');
  assert.equal(turboApiDone.directSummary?.isGitRepo, false);
  assert.match(turboApiDone.directSummary?.summary || '', /非 Git 目录/);

  // Git repo detection for directSummary
  spawnSync('git', ['init', '-q'], { cwd: turboDir, windowsHide: true });
  spawnSync('git', ['config', 'user.email', 'test@sidedesk.local'], { cwd: turboDir, windowsHide: true });
  spawnSync('git', ['config', 'user.name', 'SideDesk Test'], { cwd: turboDir, windowsHide: true });
  spawnSync('git', ['add', 'a.txt', 'b.txt', 'c.txt'], { cwd: turboDir, windowsHide: true });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: turboDir, windowsHide: true });
  const gitSummary = await inspectDirectGitStatus(turboDir);
  assert.equal(gitSummary.isGitRepo, true);
  assert.ok(gitSummary.changedCount >= 1);
  assert.ok(gitSummary.files.some((f) => f.path === 'turbo_written.txt'));

  // 3.5d: Instant abort of running run_command child tree in turbo-direct
  const { job: turboAbortJob } = hub.startJob({
    sourceDir: turboDir,
    personaId: 'ds-r1',
    sandbox: 'turbo-direct',
    createdBy: 'boss',
    prompt: 'TURBO_CMD_ABORT',
  });
  await new Promise((r) => setTimeout(r, 700));
  const tCmdAbort = Date.now();
  hub.abortJob(turboAbortJob.id, 'E2E中止Turbo命令');
  const turboAborted = await hub.waitForJob(turboAbortJob.id, 8);
  assert.equal(turboAborted.status, 'aborted');
  assert.ok(Date.now() - tCmdAbort < 3000, 'Aborting turbo run_command should kill process tree swiftly');

  // 3.5e: Codex CLI args & developer_instructions verification for turbo-direct vs shadow
  const directDev = buildDeveloperInstructions({ systemPrompt: '人设A' }, { isDirect: true, absSourceDir: turboDir });
  assert.ok(directDev.includes('Turbo 直通模式说明'));
  assert.equal(directDev.includes(ANTI_ESCAPE_GUARDRAIL), false);
  const shadowDev = buildDeveloperInstructions({ systemPrompt: '人设A' }, { isDirect: false, absSourceDir: turboDir });
  assert.ok(shadowDev.includes(ANTI_ESCAPE_GUARDRAIL));

  const directExecArgs = buildCodexArgs({
    isDirect: true,
    isResume: false,
    sandbox: 'turbo-direct',
    workDir: turboDir,
    effectiveModel: 'gpt-6.2-sol',
    effectiveEffort: 'low',
    devInst: directDev,
    lastMsgFile: join(rootTmp, 'lm.txt'),
  });
  assert.ok(directExecArgs.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(directExecArgs.includes('shell_environment_policy.inherit="all"'));
  assert.equal(directExecArgs.includes('-s'), false);
  assert.equal(directExecArgs.includes('approval_policy="never"'), false);

  const directResumeArgs = buildCodexArgs({
    isDirect: true,
    isResume: true,
    sandbox: 'turbo-direct',
    workDir: turboDir,
    effectiveModel: 'gpt-6.2-sol',
    effectiveEffort: 'low',
    devInst: directDev,
    lastMsgFile: join(rootTmp, 'lm.txt'),
    codexThreadId: 'th-abc',
  });
  assert.equal(directResumeArgs[0], 'exec');
  assert.equal(directResumeArgs[1], 'resume');
  assert.equal(directResumeArgs[2], '--all');
  assert.ok(directResumeArgs.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(directResumeArgs.includes('shell_environment_policy.inherit="all"'));
  assert.equal(directResumeArgs.some((a) => String(a).startsWith('sandbox_mode=')), false);

  pass(
    '3.5. ⚡ Turbo 直通全链路（绕过 maxFiles:1 熔断 / 零影子副本 / 外部只读 + 原目录直写 + run_command / 秒级中止命令树 / Codex 直通参数校验）',
    `turboStart=${turboDispatchMs}ms`
  );

  // -------------------------------------------------------------------------
  // 3.6. v0.3 Features: User Profile Injection + 3-Group Permissions + Image Attachments + Topic Lifecycle
  // -------------------------------------------------------------------------
  // 3.6a: User profile name & themeMode persistence + injection into both Codex dev instructions & OpenAI system prompt
  assert.equal(store.getUserProfile().themeMode, 'auto', 'Default themeMode must be auto');
  store.saveUserProfile({ userName: '老板阿明', userAvatar: '👑', themeMode: 'dark' });
  assert.equal(store.getUserProfile().themeMode, 'dark');
  const reloadedProfileStore = new SideDeskStore(dataDir);
  assert.equal(reloadedProfileStore.getUserProfile().themeMode, 'dark', 'themeMode must persist across store reload');
  store.saveUserProfile({ themeMode: 'invalid-mode' });
  assert.equal(store.getUserProfile().themeMode, 'dark', 'Invalid themeMode must not overwrite valid value');
  store.saveUserProfile({ themeMode: 'auto' });
  assert.equal(store.getUserProfile().themeMode, 'auto');
  const profDevInst = buildDeveloperInstructions(
    { systemPrompt: '人设B' },
    {
      isDirect: false,
      absSourceDir: turboDir,
      permissions: { fileScope: 'shadow', commandPolicy: 'disabled', networkPolicy: 'allow' },
      userProfile: store.getUserProfile(),
    }
  );
  assert.ok(profDevInst.includes('称呼对方为「老板阿明」'));
  assert.ok(profDevInst.includes('禁止执行 Shell/终端命令'));

  // 3.6b: 3-Group Permission Capsules -> Codex CLI args & OpenAI tool gating
  const shadowNetAllowArgs = buildCodexArgs({
    isDirect: false,
    isResume: false,
    permissions: { fileScope: 'shadow', commandPolicy: 'disabled', networkPolicy: 'allow' },
    workDir: turboDir,
    effectiveModel: 'gpt-6.2-sol',
    effectiveEffort: 'low',
    devInst: profDevInst,
    validImages: [extRefFile],
    lastMsgFile: join(rootTmp, 'lm2.txt'),
  });
  assert.ok(shadowNetAllowArgs.includes('sandbox_workspace_write.network_access=true'));
  assert.ok(shadowNetAllowArgs.includes('features.shell_tool=false'));
  assert.ok(shadowNetAllowArgs.includes('features.unified_exec=false'));
  assert.ok(shadowNetAllowArgs.includes('-i') && shadowNetAllowArgs.includes(extRefFile));

  const shadowNetDenyArgs = buildCodexArgs({
    isDirect: false,
    isResume: false,
    permissions: { fileScope: 'shadow', commandPolicy: 'auto', networkPolicy: 'deny' },
    workDir: turboDir,
    effectiveModel: 'gpt-6.2-sol',
    effectiveEffort: 'low',
    devInst: profDevInst,
    lastMsgFile: join(rootTmp, 'lm3.txt'),
  });
  assert.ok(shadowNetDenyArgs.includes('sandbox_workspace_write.network_access=false'));
  assert.equal(shadowNetDenyArgs.includes('features.shell_tool=false'), false);

  // Direct mode with commandPolicy=disabled MUST block run_command in OpenAI engine
  const cmdDisabledBlock = await executeToolAsync(
    turboDir,
    { fileScope: 'direct', commandPolicy: 'disabled', networkPolicy: 'allow' },
    'run_command',
    { command: 'Write-Output NOPE' }
  );
  assert.equal(cmdDisabledBlock.ok, false);
  assert.match(cmdDisabledBlock.error, /禁止/);

  // 3.6c: Image attachment persistence + multimodal OpenAI dispatch + commandPolicy=disabled tool check
  const tinyPngDataUrl =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const savedAtt = store.saveAttachmentFromDataUrl(tinyPngDataUrl, 'bug_shot.png');
  assert.equal(existsSync(savedAtt.filePath), true);

  const { job: inspectJob1, session: v03Sess } = hub.startJob({
    sourceDir: turboDir,
    personaId: 'ds-r1',
    permissions: { fileScope: 'direct', commandPolicy: 'disabled', networkPolicy: 'allow' },
    attachments: [{ ...savedAtt, dataUrl: tinyPngDataUrl, previewDataUrl: tinyPngDataUrl }],
    createdBy: 'boss',
    title: '初始话题A',
    prompt: 'V03_INSPECT_CALL 检查称呼、附图与禁命令策略',
  });
  const inspectDone1 = await hub.waitForJob(inspectJob1.id, 20);
  assert.equal(inspectDone1.status, 'completed', `v03 inspect failed: ${inspectDone1.error}`);
  const parsed1 = JSON.parse(inspectDone1.finalReply.replace(/^INSPECT=/, ''));
  assert.equal(parsed1.hasUserName, true, 'User profile name must be injected');
  assert.equal(parsed1.hasImageBlock, true, 'Image attachment must be sent as image_url block');
  assert.equal(parsed1.hasRunCommand, false, 'commandPolicy=disabled must omit run_command');
  assert.equal(parsed1.hasInherited, false);
  assert.equal(v03Sess.messages[0].attachments?.length, 1);

  // 3.6d: Topic Rename + Export Markdown + In-place Compress + Zero-quota Reuse + Inherit + Unbind ("不再延续") + Clear + Delete
  store.renameSession(v03Sess.id, '支付回调重构话题');
  assert.equal(store.getSession(v03Sess.id).title, '支付回调重构话题');

  const exp = store.exportSessionMarkdown(v03Sess.id);
  assert.equal(existsSync(exp.savedPath), true);
  assert.ok(exp.markdown.includes('# 支付回调重构话题') && exp.markdown.includes('老板阿明'));

  // In-place compress resets codexThreadId & openaiMessages and sets fresh latestSummary + inheritedSummary
  v03Sess.codexThreadId = 'fake-old-thread';
  const reqCountBeforeCompress = mockRequests.length;
  const compRes = await hub.compressSessionInPlaceAsync({
    sessionId: v03Sess.id,
    summarizerPersonaId: 'ds-r1',
  });
  assert.equal(compRes.ok, true);
  assert.equal(mockRequests.length, reqCountBeforeCompress + 1, 'Compression should call summarizer once');
  assert.equal(v03Sess.codexThreadId, null, 'In-place compress must reset codexThreadId');
  assert.equal(v03Sess.openaiMessages.length, 0, 'In-place compress must reset openaiMessages');
  assert.equal(hasFreshSessionSummary(v03Sess), true, 'Fresh summary flag must stay true after compress');

  // Opening a new topic inheriting from v03Sess right away MUST reuse cached summary with ZERO extra quota!
  const reqCountBeforeReuse = mockRequests.length;
  const reuseRes = await hub.summarizeSessionAsync({
    sessionId: v03Sess.id,
    summarizerPersonaId: 'ds-r1',
    reuseIfFresh: true,
  });
  assert.equal(reuseRes.reused, true, 'Must reuse fresh summary with zero extra quota');
  assert.equal(mockRequests.length, reqCountBeforeReuse, 'Zero API calls when reusing fresh summary');

  const inheritedSess = store.createSession({
    personaId: 'ds-r1',
    provider: 'openai-compatible',
    title: '延续新话题B',
    sourceDir: turboDir,
    inheritedSummary: {
      sourceSessionId: v03Sess.id,
      sourceTitle: v03Sess.title,
      summary: reuseRes.summary,
    },
  });

  // Turn 1 in inheritedSess MUST receive inheritedSummary in system prompt
  const { job: inhJob1 } = hub.startJob({
    sourceDir: turboDir,
    sessionId: inheritedSess.id,
    permissions: { fileScope: 'direct', commandPolicy: 'auto', networkPolicy: 'allow' },
    createdBy: 'boss',
    prompt: 'V03_INSPECT_CALL 检查是否收到继承摘要',
  });
  const inhDone1 = await hub.waitForJob(inhJob1.id, 20);
  const parsedInh1 = JSON.parse(inhDone1.finalReply.replace(/^INSPECT=/, ''));
  assert.equal(parsedInh1.hasInherited, true, 'New topic must receive inherited summary');
  assert.equal(parsedInh1.hasRunCommand, true, 'commandPolicy=auto in direct mode must mount run_command');

  // Unbind inherited summary ("不再延续") -> Turn 2 MUST NOT inject inheritedSummary anymore!
  store.clearSessionInheritedSummary(inheritedSess.id);
  assert.equal(inheritedSess.inheritedSummary, null);
  const { job: inhJob2 } = hub.startJob({
    sourceDir: turboDir,
    sessionId: inheritedSess.id,
    permissions: { fileScope: 'direct', commandPolicy: 'auto', networkPolicy: 'allow' },
    createdBy: 'boss',
    prompt: 'V03_INSPECT_CALL 解绑后不应再注入继承摘要',
  });
  const inhDone2 = await hub.waitForJob(inhJob2.id, 20);
  const parsedInh2 = JSON.parse(inhDone2.finalReply.replace(/^INSPECT=/, ''));
  assert.equal(parsedInh2.hasInherited, false, 'Unbound inherited summary must no longer be injected');

  // Adding a new message invalidates fresh summary -> summarize triggers a new call
  store.appendSessionMessage(v03Sess.id, { role: 'boss', text: '追加一条新问题' });
  assert.equal(hasFreshSessionSummary(v03Sess), false);
  const freshAgain = await hub.summarizeSessionAsync({
    sessionId: v03Sess.id,
    summarizerPersonaId: 'ds-r1',
    reuseIfFresh: true,
  });
  assert.equal(freshAgain.reused, false);

  // Clear & Delete topic
  store.clearSessionMessages(inheritedSess.id);
  assert.equal(store.getSession(inheritedSess.id).messages.length, 0);
  store.deleteSession(inheritedSess.id);
  assert.equal(store.getSession(inheritedSess.id), null);

  pass(
    '3.6. v0.3 核心机制全链路（个人资料称呼注入 / 三组权限胶囊 / 附图传递 / 话题改名导出 / 原地压缩 / 零额度复用摘要 / 不再延续解绑 / 清空删除）'
  );

  // -------------------------------------------------------------------------
  // 3.7. v0.3.1 Features: 6-Level Dynamic Reasoning + Fast Mode + Clean Launch + Global Emergency Trip
  // -------------------------------------------------------------------------
  const codexDefs = readCodexUserDefaults();
  assert.ok(codexDefs.modelReasoningLevels && typeof codexDefs.modelReasoningLevels === 'object');
  const solLevels = codexDefs.modelReasoningLevels['gpt-6.2-sol'] || [];
  assert.ok(solLevels.includes('max') && solLevels.includes('ultra'), `Expected max & ultra in gpt-6.2-sol levels, got ${JSON.stringify(solLevels)}`);

  // Fast mode + cleanCodexConfig arg checks (exec & resume)
  const fastCleanExec = buildCodexArgs({
    isDirect: false,
    isResume: false,
    workDir: turboDir,
    effectiveModel: 'gpt-6.2-sol',
    effectiveEffort: 'ultra',
    fastMode: true,
    cleanCodexConfig: true,
    windowsSandbox: 'elevated',
    devInst: 'test',
    lastMsgFile: join(rootTmp, 'lm_fast.txt'),
  });
  assert.ok(fastCleanExec.includes('--ignore-user-config'));
  assert.ok(fastCleanExec.includes('windows.sandbox="elevated"'));
  assert.ok(fastCleanExec.includes('service_tier="fast"'));
  assert.ok(fastCleanExec.includes('model_reasoning_effort="ultra"'));

  const fastOffDirtyResume = buildCodexArgs({
    isDirect: true,
    isResume: true,
    workDir: turboDir,
    effectiveModel: 'gpt-6.2-sol',
    effectiveEffort: 'max',
    fastMode: false,
    cleanCodexConfig: false,
    devInst: 'test',
    lastMsgFile: join(rootTmp, 'lm_dirty.txt'),
    codexThreadId: 'th-xyz',
  });
  assert.equal(fastOffDirtyResume.includes('--ignore-user-config'), false);
  assert.ok(fastOffDirtyResume.includes('service_tier="default"'));
  assert.ok(fastOffDirtyResume.includes('model_reasoning_effort="max"'));

  // Persona persists max/ultra + fastMode + cleanCodexConfig
  const fastPersona = store.savePersona({
    id: 'codex-default',
    name: 'Codex',
    reasoningEffort: 'ultra',
    fastMode: true,
    cleanCodexConfig: true,
  });
  assert.equal(fastPersona.reasoningEffort, 'ultra');
  assert.equal(fastPersona.fastMode, true);
  assert.equal(fastPersona.cleanCodexConfig, true);
  // Restore default low/fastMode=false for real codex smoke test below
  store.savePersona({ id: 'codex-default', name: 'Codex', reasoningEffort: 'high', fastMode: false, cleanCodexConfig: true });

  // Global Emergency Trip: simultaneously kills 2 running jobs across engines & downgrades global Turbo -> shadow
  store.saveDefaultPermissions({ fileScope: 'direct', commandPolicy: 'auto', networkPolicy: 'allow' });
  const { job: tripApiJob } = hub.startJob({
    sourceDir: turboDir,
    personaId: 'ds-r1',
    sandbox: 'read-only',
    createdBy: 'boss',
    prompt: 'SLOW_STREAM_ABORT',
  });
  const { job: tripCodexJob } = hub.codex.startJob({
    sourceDir,
    persona: store.getPersona('codex-default'),
    sandbox: 'read-only',
    prompt: 'trip subprocess probe',
    coldStartTimeoutMs: 20000,
    _overrideCommand: {
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 30000)'],
    },
  });
  await new Promise((r) => setTimeout(r, 400));
  const tripRes = hub.emergencyTrip('E2E全局急停测试');
  assert.equal(tripRes.ok, true);
  assert.ok(tripRes.abortedCount >= 2, `Expected >=2 aborted jobs, got ${tripRes.abortedCount}`);
  assert.equal(tripRes.downgradedGlobalToShadow, true);
  assert.equal(store.getDefaultPermissions().fileScope, 'shadow');
  const [tDone1, tDone2] = await Promise.all([
    hub.waitForJob(tripApiJob.id, 6),
    hub.waitForJob(tripCodexJob.id, 6),
  ]);
  assert.equal(tDone1.status, 'aborted');
  assert.equal(tDone2.status, 'aborted');

  pass('3.7. v0.3.1 升级全链路（全 6 档动态推理解析 / 闪电加速与纯净启动参数 / 全局急停一键双杀并降级 Turbo）');

  // -------------------------------------------------------------------------
  // 3.8. v0.4 Anchor Engine + Anti-Over-Engineering Guidance + Memories + Disk Rollback Notice + Purity
  // -------------------------------------------------------------------------
  // 3.8a: 5-part composePersonaProfileBlock unit checks (addressUserAs override, memory filter, decoupling)
  const blockWithOverride = composePersonaProfileBlock(
    {
      name: '小副',
      role: '架构搭档',
      addressUserAs: '主人',
      systemPrompt: '语气温和但结论精准',
      memories: [
        { id: 'm1', text: '偏好使用严格类型检查', enabled: true },
        { id: 'm2', text: '这条停用记忆绝不能出现', enabled: false },
      ],
    },
    { userName: '老板阿明' }
  );
  assert.ok(blockWithOverride.includes('成员「小副」（职责定位：架构搭档）'));
  assert.ok(blockWithOverride.includes('称呼对方为「主人」'));
  assert.equal(blockWithOverride.includes('老板阿明'), false, 'Persona addressUserAs must override global userName');
  assert.ok(blockWithOverride.includes('偏好使用严格类型检查'));
  assert.equal(blockWithOverride.includes('这条停用记忆绝不能出现'), false, 'Disabled memory must be excluded');
  assert.ok(blockWithOverride.includes('表达风格与工程严谨度解耦说明'));

  const blockWithFallback = composePersonaProfileBlock(
    { name: '小副', addressUserAs: '', systemPrompt: '简洁', memories: [] },
    { userName: '老板阿明' }
  );
  assert.ok(blockWithFallback.includes('称呼对方为「老板阿明」'));

  // 3.8b: 4-condition evaluateAnchorSync state machine unit checks
  const mockUnitSess = { anchorState: { digest: '', turnsSinceSync: 0, charsSinceSync: 0, forceSync: false } };
  const t1 = evaluateAnchorSync(mockUnitSess, blockWithOverride, 'hi 1');
  assert.equal(t1.shouldInjectRecencySync, false, 'Turn 1 anchors initially without redundant sync block');
  assert.equal(mockUnitSess.anchorState.turnsSinceSync, 0);

  for (let turn = 2; turn <= 4; turn++) {
    const tn = evaluateAnchorSync(mockUnitSess, blockWithOverride, `hi ${turn}`);
    assert.equal(tn.shouldInjectRecencySync, false, `Turn ${turn} must skip recency sync`);
  }
  assert.equal(mockUnitSess.anchorState.turnsSinceSync, 3);

  // Turn 5 (full 4 turns since last sync) MUST trigger turn_threshold and reset counters!
  const t5 = evaluateAnchorSync(mockUnitSess, blockWithOverride, 'hi 5');
  assert.equal(t5.shouldInjectRecencySync, true, 'Turn 5 must trigger turn_threshold');
  assert.ok(t5.reasons.includes('turn_threshold'));
  assert.equal(mockUnitSess.anchorState.turnsSinceSync, 0);
  assert.equal(mockUnitSess.anchorState.charsSinceSync, 0);

  // Condition 2: Single turn > 24,000 chars MUST immediately trigger char_threshold!
  const tChar = evaluateAnchorSync(mockUnitSess, blockWithOverride, 'X'.repeat(24_100));
  assert.equal(tChar.shouldInjectRecencySync, true);
  assert.ok(tChar.reasons.includes('char_threshold'));
  assert.equal(mockUnitSess.anchorState.charsSinceSync, 0);

  // Condition 3: Digest change (hot persona edit) MUST immediately trigger digest_changed!
  const tHot = evaluateAnchorSync(mockUnitSess, blockWithFallback, 'hi after edit');
  assert.equal(tHot.shouldInjectRecencySync, true);
  assert.ok(tHot.reasons.includes('digest_changed'));

  // Condition 4: forceSync (e.g. after compaction/inherit) MUST trigger force_sync and clear!
  mockUnitSess.anchorState.forceSync = true;
  const tForce = evaluateAnchorSync(mockUnitSess, blockWithFallback, 'hi after compact');
  assert.equal(tForce.shouldInjectRecencySync, true);
  assert.ok(tForce.reasons.includes('force_sync'));
  assert.equal(mockUnitSess.anchorState.forceSync, false);

  // 3.8c: Live multi-turn OpenAI engine E2E (Turns 1..5, hot edit, compress forceSync, discard rollback notice, purity)
  store.savePersona({
    id: 'ds-r1',
    name: 'DeepSeek 审计官',
    addressUserAs: '主人',
    memories: [
      { id: 'mem-en', text: '偏好使用严格类型检查', enabled: true },
      { id: 'mem-off', text: '这条停用记忆绝不能出现', enabled: false },
    ],
  });

  const runV04Turn = async (sid, text, opts = {}) => {
    const { job, session } = hub.startJob({
      sourceDir: turboDir,
      personaId: 'ds-r1',
      sessionId: sid || '',
      sandbox: opts.sandbox || 'turbo-direct',
      createdBy: 'boss',
      prompt: text,
    });
    const done = await hub.waitForJob(job.id, 20);
    assert.equal(done.status, 'completed', `v04 turn failed: ${done.error}`);
    return {
      session,
      data: JSON.parse(done.finalReply.replace(/^V04=/, '')),
    };
  };

  // Turn 1: initial anchor -> guidance present, NO recency sync, address override + active memory only
  const r1 = await runV04Turn('', 'V04_ANCHOR_PROBE 第1轮问候');
  const v04Sess = r1.session;
  assert.equal(r1.data.hasGuidance, true);
  assert.equal(r1.data.hasAntiOverEng, true);
  assert.equal(r1.data.hasRecencySync, false);
  assert.equal(r1.data.sysHasAddressOwner, true);
  assert.equal(r1.data.sysHasEnabledMem, true);
  assert.equal(r1.data.sysHasDisabledMem, false);

  // Turns 2, 3, 4: NO recency sync
  for (let i = 2; i <= 4; i++) {
    const ri = await runV04Turn(v04Sess.id, `V04_ANCHOR_PROBE 第${i}轮对话`);
    assert.equal(ri.data.hasRecencySync, false, `Live Turn ${i} must NOT repeat recency sync`);
    assert.equal(ri.data.priorHistoryLeakedHeader, false, 'Persisted openaiMessages MUST NOT leak headers');
  }

  // Turn 5: auto-triggers recency sync on turn 5!
  const r5 = await runV04Turn(v04Sess.id, 'V04_ANCHOR_PROBE 第5轮触发重锚');
  assert.equal(r5.data.hasRecencySync, true, 'Live Turn 5 must trigger recency sync');
  assert.equal(r5.data.priorHistoryLeakedHeader, false);

  // Hot persona edit mid-session: change memories & clear addressUserAs -> Turn 6 IMMEDIATELY hot-syncs!
  store.savePersona({
    id: 'ds-r1',
    name: 'DeepSeek 审计官',
    addressUserAs: '',
    memories: [
      { id: 'mem-en', text: '偏好使用严格类型检查', enabled: true },
      { id: 'mem-hot', text: '热更新新增记忆条款', enabled: true },
    ],
  });
  const r6 = await runV04Turn(v04Sess.id, 'V04_ANCHOR_PROBE 第6轮热改卡验证');
  assert.equal(r6.data.hasRecencySync, true, 'Hot persona edit must immediately trigger recency sync');
  assert.equal(r6.data.sysHasAddressFallback, true, 'Clearing addressUserAs must fall back to global userName');
  assert.equal(r6.data.sysHasHotNewMem, true);
  assert.equal(r6.data.userHasHotNewMem, true);

  // In-place compaction sets anchorState.forceSync = true -> Turn 7 triggers recency sync!
  await hub.compressSessionInPlaceAsync({ sessionId: v04Sess.id, summarizerPersonaId: 'ds-r1' });
  assert.equal(v04Sess.anchorState.forceSync, true);
  const r7 = await runV04Turn(v04Sess.id, 'V04_ANCHOR_PROBE 第7轮压缩后强刷');
  assert.equal(r7.data.hasRecencySync, true, 'Post-compaction turn must trigger forceSync');
  assert.equal(v04Sess.anchorState.forceSync, false);

  // Discard shadow (and undo) sets pendingDiskRollbackNotice -> consumed ONCE on next turn then cleared!
  const rbShadow = createShadowCopy(store, sourceDir);
  const rbSess = store.createSession({
    personaId: 'ds-r1',
    provider: 'openai-compatible',
    title: '回退提醒测试',
    sourceDir,
    shadowId: rbShadow.id,
  });
  discardShadow(store, rbShadow.id);
  assert.equal(rbSess.pendingDiskRollbackNotice, true, 'discardShadow must arm pendingDiskRollbackNotice');
  const rbTurn1 = await runV04Turn(rbSess.id, 'V04_ANCHOR_PROBE 回退后首轮', { sandbox: 'turbo-direct' });
  assert.equal(rbTurn1.data.hasRollbackNotice, true, 'Next turn after discard must inject disk rollback notice');
  assert.equal(rbSess.pendingDiskRollbackNotice, false, 'Rollback notice must clear after consumption');
  const rbTurn2 = await runV04Turn(rbSess.id, 'V04_ANCHOR_PROBE 回退后第二轮', { sandbox: 'turbo-direct' });
  assert.equal(rbTurn2.data.hasRollbackNotice, false, 'Rollback notice must NOT repeat on second turn');

  // Strict UI & API History Purity checks: ZERO headers/sync blocks in session.messages OR session.openaiMessages!
  for (const m of v04Sess.messages.filter((x) => x.role === 'boss')) {
    assert.equal(m.text.includes('【本轮态势与协作提醒】'), false, 'UI bubble must NEVER contain guidance header');
    assert.equal(m.text.includes('【最新角色设定与记忆同步】'), false, 'UI bubble must NEVER contain recency sync block');
    assert.equal(m.text.includes('【用户本轮消息】'), false, 'UI bubble must contain ONLY raw prompt');
  }
  for (const m of v04Sess.openaiMessages.filter((x) => x.role === 'user')) {
    assert.equal(String(m.content).includes('【本轮态势与协作提醒】'), false, 'Persisted API history must stay clean');
    assert.equal(String(m.content).includes('【最新角色设定与记忆同步】'), false, 'Persisted API history must not accumulate anchors');
  }

  // Verify header & outbound composer sanity
  const testHeader = composeTurnGuidanceHeader({ workDir: turboDir, directMode: true, hadRollback: true });
  const testPayload = composeOutboundUserPayload({ userPrompt: '你好', turnGuidanceHeader: testHeader });
  assert.ok(testPayload.includes('你好') && testPayload.includes('避免过度工程化') && testPayload.includes('磁盘回退提示'));

  pass(
    '3.8. v0.4 防掉皮锚点引擎全链路（5段式档案 / 专属称呼与记忆开关 / 4条件状态机 / 热改卡 / 压缩强刷 / 回退一次性提醒 / 气泡与历史 100% 纯净）'
  );

  // -------------------------------------------------------------------------
  // 3.9. v1.1 Zero-Overhead Codex Quota Reader + Dual-Engine Context Usage
  // -------------------------------------------------------------------------
  const mockCodexSessionsDir = join(rootTmp, 'mock_codex_sessions');
  const mockDayDir = join(mockCodexSessionsDir, '2026', '11', '22');
  mkdirSync(mockDayDir, { recursive: true });

  const mockThreadId = '01a1ff2f-ce81-7f42-817f-d8bc1b28d013';
  const mockReset5h = Math.floor(Date.now() / 1000) + 7200 + 840; // ~2h14m from now
  const mockReset7d = Math.floor(Date.now() / 1000) + 3 * 86400; // 3d from now
  const mockRolloutFile = join(mockDayDir, `rollout-2026-11-22T02-38-05-${mockThreadId}.jsonl`);
  // Pad > 140KB before the trailing token_count events to verify tail-128KB slice skips partial line cleanly
  const padPayload = 'x'.repeat(1000);
  const padLines = Array.from({ length: 150 }, (_, idx) =>
    JSON.stringify({ timestamp: '2026-11-22T02:38:06.000Z', type: 'response_item', idx, pad: padPayload })
  );
  const mockRolloutLines = [
    JSON.stringify({
      timestamp: '2026-11-22T02:38:05.000Z',
      type: 'session_meta',
      payload: { id: mockThreadId, session_id: mockThreadId },
    }),
    ...padLines,
    JSON.stringify({
      timestamp: '2026-11-22T02:38:15.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 10000, cached_input_tokens: 2000, output_tokens: 80, reasoning_output_tokens: 0, total_tokens: 10080 },
          last_token_usage: { input_tokens: 10000, cached_input_tokens: 2000, output_tokens: 80, reasoning_output_tokens: 0, total_tokens: 10080 },
          model_context_window: 475000,
        },
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: 1.0, window_minutes: 300, resets_at: mockReset5h },
          secondary: { used_percent: 28.0, window_minutes: 10080, resets_at: mockReset7d },
          plan_type: 'plus',
          credits: { has_credits: false, unlimited: false, balance: '0' },
        },
      },
    }),
    JSON.stringify({
      timestamp: '2026-11-22T02:38:24.925Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 67574, cached_input_tokens: 58240, output_tokens: 274, reasoning_output_tokens: 0, total_tokens: 67848 },
          last_token_usage: { input_tokens: 20984, cached_input_tokens: 14208, output_tokens: 102, reasoning_output_tokens: 0, total_tokens: 21086 },
          model_context_window: 475000,
        },
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: 2.0, window_minutes: 300, resets_at: mockReset5h },
          secondary: { used_percent: 29.0, window_minutes: 10080, resets_at: mockReset7d },
          plan_type: 'plus',
          credits: { has_credits: false, unlimited: false, balance: '0' },
        },
      },
    }),
  ];
  writeFileSync(mockRolloutFile, mockRolloutLines.join('\n') + '\n', 'utf8');

  // Second newer file without rate_limits and with meta-only thread id matching
  const metaOnlyThreadId = 'th-meta-only-9988';
  const mockMetaOnlyFile = join(mockDayDir, 'rollout-2026-11-22T02-39-00-customname.jsonl');
  writeFileSync(
    mockMetaOnlyFile,
    [
      JSON.stringify({
        timestamp: '2026-11-22T02:39:00.000Z',
        type: 'session_meta',
        payload: { id: metaOnlyThreadId },
      }),
      JSON.stringify({
        timestamp: '2026-11-22T02:39:05.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 300000, cached_input_tokens: 120000, output_tokens: 15000, reasoning_output_tokens: 4000, total_tokens: 315000 },
            model_context_window: 400000,
          },
          rate_limits: null,
        },
      }),
    ].join('\n') + '\n',
    'utf8'
  );

  // Tail read sanity check on >140KB file
  const tailSlice = await readTailTextAsync(mockRolloutFile);
  assert.equal(tailSlice.truncated, true, 'File > 128KB must be tail-sliced');
  const parsedTail = parseTokenCountFromJsonlText(tailSlice.text);
  assert.equal(parsedTail.rateLimits.primary.used_percent, 2.0);
  assert.equal(parsedTail.contextUsage.usedTokens, 21086);

  const mockQuotaReader = new CodexQuotaReader({ sessionsDir: mockCodexSessionsDir });
  const snapQuota = await mockQuotaReader.getQuota({ force: true });
  assert.equal(snapQuota.available, true);
  assert.equal(snapQuota.planType, 'plus');
  assert.equal(snapQuota.primary.usedPercent, 2);
  assert.equal(snapQuota.primary.remainingPercent, 98);
  assert.equal(snapQuota.primary.resetsAt, mockReset5h);
  assert.equal(snapQuota.secondary.usedPercent, 29);
  assert.equal(snapQuota.secondary.remainingPercent, 71);
  assert.equal(snapQuota.secondary.resetsAt, mockReset7d);

  const threadCtx = await mockQuotaReader.getThreadContextUsage(mockThreadId, { force: true });
  assert.equal(threadCtx.usedTokens, 21086, 'Must read last_token_usage (21086), NOT cumulative total (67848)');
  assert.equal(threadCtx.cachedTokens, 14208);
  assert.equal(threadCtx.maxTokens, 475000);
  assert.equal(threadCtx.usedPercent, 4.4);

  const metaThreadCtx = await mockQuotaReader.getThreadContextUsage(metaOnlyThreadId, { force: true });
  assert.equal(metaThreadCtx.usedTokens, 315000);
  assert.equal(metaThreadCtx.maxTokens, 400000);
  assert.equal(metaThreadCtx.usedPercent, 78.8);

  // Missing sessions directory must gracefully return available: false with ZERO throw
  const missingReader = new CodexQuotaReader({ sessionsDir: join(rootTmp, 'does_not_exist_dir') });
  const emptyQuota = await missingReader.getQuota({ force: true });
  assert.equal(emptyQuota.available, false);
  assert.equal(await missingReader.getThreadContextUsage(mockThreadId), null);

  // OpenAI-compatible engine context usage: DeepSeek prompt_cache_hit_tokens + custom contextWindow
  store.savePersona({ id: 'ds-r1', name: 'DeepSeek 审计官', contextWindow: 100000 });
  const { job: dsCtxJob, session: dsCtxSess } = hub.startJob({
    sourceDir: turboDir,
    personaId: 'ds-r1',
    sandbox: 'turbo-direct',
    createdBy: 'boss',
    prompt: 'QUOTA_CTX_PROBE_DS',
  });
  const dsCtxDone = await hub.waitForJob(dsCtxJob.id, 15);
  assert.equal(dsCtxDone.status, 'completed');
  assert.equal(dsCtxSess.contextUsage?.usedTokens, 43500);
  assert.equal(dsCtxSess.contextUsage?.cachedTokens, 28000);
  assert.equal(dsCtxSess.contextUsage?.maxTokens, 100000);
  assert.equal(dsCtxSess.contextUsage?.usedPercent, 43.5);

  // OpenAI multi-round tool loop: default 128000 contextWindow + prompt_tokens_details.cached_tokens + LAST round only!
  store.savePersona({ id: 'ds-r1', name: 'DeepSeek 审计官', contextWindow: 0 });
  const { job: oaiCtxJob } = hub.startJob({
    sourceDir: turboDir,
    personaId: 'ds-r1',
    sessionId: dsCtxSess.id,
    sandbox: 'turbo-direct',
    createdBy: 'boss',
    prompt: 'QUOTA_CTX_PROBE_OAI',
  });
  const oaiCtxDone = await hub.waitForJob(oaiCtxJob.id, 15);
  assert.equal(oaiCtxDone.status, 'completed');
  assert.equal(oaiCtxSessUsageCheck(dsCtxSess).usedTokens, 87200, 'Must capture LAST round (87200), not sum across tool rounds');
  assert.equal(dsCtxSess.contextUsage?.cachedTokens, 51000);
  assert.equal(dsCtxSess.contextUsage?.maxTokens, 128000);
  assert.equal(dsCtxSess.contextUsage?.usedPercent, 68.1);
  assert.equal(buildOpenAiContextUsage({ prompt_tokens: 1000, completion_tokens: 200 }, { contextWindow: 64000 }).usedPercent, 1.9);

  // In-place compress resets session.contextUsage to null
  await hub.compressSessionInPlaceAsync({ sessionId: dsCtxSess.id, summarizerPersonaId: 'ds-r1' });
  assert.equal(dsCtxSess.contextUsage, null, 'Compressing session must reset contextUsage');

  function oaiCtxSessUsageCheck(s) {
    assert.ok(s.contextUsage, 'session.contextUsage must be populated');
    return s.contextUsage;
  }

  pass('3.9. v1.1 零开销配额读取器（128KB 尾部切片 / 5h&周剩余换算 / thread_id 精确水位 / 空态兜底）+ 双引擎上下文统计（DeepSeek/OpenAI 缓存命中 + 自定义窗口 + 压缩清零）');

  // -------------------------------------------------------------------------
  // 4. Codex 0ms Cache Warm-up + Cold-Start Watchdog
  // -------------------------------------------------------------------------
  await hub.refreshCodexBinaryAsync();
  const tFast = Date.now();
  const fastBin = hub.getCodexBinaryFast();
  const fastMs = Date.now() - tFast;
  assert.ok(fastBin.path, 'codex.exe must be cached');
  assert.ok(fastMs < 30, `getCodexBinaryFast must be ~0ms, got ${fastMs}ms`);
  assert.equal(existsSync(join(dataDir, 'codex-cache.json')), true, 'codex-cache.json must persist');

  // Watchdog test: silent child process gets killed cleanly after coldStartTimeoutMs
  const { job: wdJob } = hub.codex.startJob({
    sourceDir,
    persona: store.getPersona('codex-default'),
    sandbox: 'read-only',
    prompt: 'watchdog probe',
    coldStartTimeoutMs: 900,
    _overrideCommand: {
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 30000)'],
    },
  });
  const wdDone = await hub.waitForJob(wdJob.id, 10);
  assert.equal(wdDone.status, 'failed');
  assert.match(wdDone.error, /冷启动超时/);
  assert.equal(hub.codex.hasRunningJob(wdJob.id), false);
  pass('4. Codex 0ms 磁盘缓存预热 + 冷启动超时看门狗自动强杀', `fastLookup=${fastMs}ms`);

  // -------------------------------------------------------------------------
  // 5. Real codex.exe Regression (Turn 1 + Resume + Conflict + Apply + Undo + Crash Recovery)
  // -------------------------------------------------------------------------
  console.log('⏳ [RUN ] Test 5: 真实 codex.exe 回归测试（异步建副本 + Codex 改文件 + resume + 应用/撤销）...');
  const { job: cJob1, session: cSess } = hub.startJob({
    sourceDir,
    personaId: 'codex-default',
    model: 'gpt-6-luna',
    sandbox: 'workspace-write',
    reasoningEffort: 'low',
    createdBy: 'hakimi',
    title: 'Codex 回归测试',
    prompt:
      '请审计当前目录的 app.py：\n1. 修复 divide(a, b) 缺少除零保护的 Bug。\n2. 新建 codex_note.md 写一句简短中文说明修复内容。\n完成后简短回复。',
  });
  const cDone1 = await hub.waitForJob(cJob1.id, 120);
  assert.equal(cDone1.status, 'completed', `Codex Turn 1 failed: ${cDone1.error}`);
  assert.ok(cDone1.codexThreadId);
  assert.ok(cDone1.sourceIntegrity?.untouched === true);
  assert.equal(sha256File(join(sourceDir, 'app.py')), origAppHash);

  const cShadow = store.getShadow(cDone1.shadowId);
  const { job: cJob2 } = hub.startJob({
    sourceDir,
    sessionId: cSess.id,
    model: 'gpt-6-luna',
    sandbox: 'workspace-write',
    reasoningEffort: 'low',
    createdBy: 'boss',
    prompt: '请直接修改文件（使用 apply_patch 或 UTF-8 写入），在 codex_note.md 末尾追加一行「回归通过」，完成后简短回复。',
  });
  const cDone2 = await hub.waitForJob(cJob2.id, 120);
  assert.equal(cDone2.status, 'completed', `Codex Turn 2 failed: ${cDone2.error}`);
  assert.equal(cDone2.resumed, true);
  assert.ok(readFileSync(join(cShadow.workDir, 'codex_note.md'), 'utf8').includes('回归通过'));

  // Conflict -> Restore -> Apply -> 1-Click Undo -> Discard
  writeFileSync(join(sourceDir, 'app.py'), '# conflict\n', 'utf8');
  assert.equal(applyShadowToSource(store, cShadow, { force: false }).conflict, true);
  writeFileSync(join(sourceDir, 'app.py'), origAppPy, 'utf8');
  const applied = applyShadowToSource(store, cShadow, { force: false });
  assert.equal(applied.applied, true);
  assert.equal(existsSync(join(sourceDir, 'codex_note.md')), true);
  const undone = undoLastApply(store, { backupId: applied.backupId });
  assert.equal(undone.undone, true);
  assert.equal(cSess.pendingDiskRollbackNotice, true, 'undoLastApply must arm pendingDiskRollbackNotice on session');
  assert.equal(cSess.messages.some((m) => m.text.includes('【本轮态势与协作提醒】')), false, 'Codex UI bubbles must stay 100% clean');
  assert.equal(sha256File(join(sourceDir, 'app.py')), origAppHash);
  assert.equal(existsSync(join(sourceDir, 'codex_note.md')), false);
  discardShadow(store, cShadow.id);

  // Crash recovery check
  store.addJob({ id: 'job-crash-v2', sessionId: cSess.id, status: 'running', events: [], createdAt: Date.now() });
  const restarted = new SideDeskStore(dataDir);
  assert.equal(restarted.getJob('job-crash-v2').status, 'needs_review');

  // 5b: Real codex.exe turbo-direct smoke test (bypasses maxFiles: 1, writes directly to Git repo, populates directSummary)
  console.log('⏳ [RUN ] Test 5b: 真实 codex.exe ⚡ Turbo 直通实测（跳过熔断 + 原目录直写 + Git 摘要）...');
  const { job: cTurboJob } = hub.startJob({
    sourceDir: turboDir,
    personaId: 'codex-default',
    model: 'gpt-6-luna',
    sandbox: 'turbo-direct',
    shadowLimits: { maxFiles: 1 },
    reasoningEffort: 'low',
    createdBy: 'boss',
    title: 'Codex Turbo 实测',
    prompt: '在当前目录新建文件 codex_turbo_ok.txt，内容为 TURBO_CODEX_VERIFIED，完成后仅简短回复 OK。',
  });
  const cTurboDone = await hub.waitForJob(cTurboJob.id, 120);
  assert.equal(cTurboDone.status, 'completed', `Codex turbo-direct failed: ${cTurboDone.error}`);
  assert.equal(cTurboDone.shadowId, null);
  assert.equal(cTurboDone.directMode, true);
  assert.ok(readFileSync(join(turboDir, 'codex_turbo_ok.txt'), 'utf8').includes('TURBO_CODEX_VERIFIED'));
  assert.equal(cTurboDone.directSummary?.isGitRepo, true);
  assert.ok(cTurboDone.directSummary?.files?.some((f) => f.path === 'codex_turbo_ok.txt'));
  pass('5. 真机 codex.exe 回归（影子 Turn1/Resume/冲突/写回/撤销 + 重启自愈 + ⚡ Turbo 直通实测）');

  // -------------------------------------------------------------------------
  // 6. Real MCP JSON-RPC Stdio Protocol E2E (Renamed SideDesk Tools + Zero Key Leak + v1.1 Quota)
  // -------------------------------------------------------------------------
  // Create a Codex session bound to mockThreadId so app_get_state & app_refresh_quota can be verified end-to-end
  const mockCodexQuotaSess = store.createSession({
    personaId: 'codex-default',
    provider: 'codex-cli',
    title: '配额透出验证话题',
    sourceDir,
    model: 'gpt-6.2-sol',
    reasoningEffort: 'low',
  });
  mockCodexQuotaSess.codexThreadId = mockThreadId;
  store.flush();

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      resolve(__dirname, 'index.mjs'),
      `--data_dir=${dataDir}`,
      `--codex_sessions_dir=${mockCodexSessionsDir}`,
    ],
  });
  const client = new Client({ name: 'sidedesk-e2e', version: '1.1.0' });
  await client.connect(transport);

  const toolsList = await client.listTools();
  const names = toolsList.tools.map((t) => t.name);
  for (const reqTool of [
    'sidedesk_open',
    'sidedesk_list_personas',
    'sidedesk_dispatch',
    'sidedesk_job_status',
    'sidedesk_abort_job',
    'app_get_state',
    'app_refresh_quota',
    'app_test_provider',
    'app_paste_clipboard_image',
    'app_save_user_profile',
    'app_set_theme',
    'app_save_default_permissions',
    'app_clear_inherited_summary',
    'app_update_inherited_summary',
    'app_compress_session',
    'app_rename_session',
    'app_export_session',
    'app_clear_session',
    'app_delete_session',
    'app_emergency_trip',
  ]) {
    assert.ok(names.includes(reqTool), `Missing tool: ${reqTool}`);
  }
  const dispatchTool = toolsList.tools.find((t) => t.name === 'sidedesk_dispatch');
  const sandboxEnum = dispatchTool?.inputSchema?.properties?.sandbox?.enum || [];
  assert.deepEqual(sandboxEnum, ['read-only', 'workspace-write', 'turbo-direct']);
  const effortEnum = dispatchTool?.inputSchema?.properties?.reasoningEffort?.enum || [];
  assert.ok(effortEnum.includes('max') && effortEnum.includes('ultra'), 'MCP reasoningEffort enum must include max & ultra');
  assert.ok(dispatchTool?.inputSchema?.properties?.fastMode, 'MCP sidedesk_dispatch must expose fastMode');
  const openMeta = toolsList.tools.find((t) => t.name === 'sidedesk_open')._meta;
  assert.equal(openMeta?.ui?.resourceUri, 'ui://sidedesk/app.html');
  assert.equal(openMeta?.['com.google.antigravity/ui']?.entrypoints?.[0]?.type, 'aux_pane');

  const uiRead = await client.readResource({ uri: 'ui://sidedesk/app.html' });
  assert.equal(uiRead.contents[0].mimeType, 'text/html;profile=mcp-app');

  const listRes = await client.callTool({ name: 'sidedesk_list_personas', arguments: {} });
  assert.equal(JSON.stringify(listRes).includes('sk-secret-99887766'), false, 'Model tool MUST NOT leak API key');
  const stateRes = await client.callTool({
    name: 'app_get_state',
    arguments: { sessionId: mockCodexQuotaSess.id },
  });
  assert.equal(JSON.stringify(stateRes).includes('sk-secret-99887766'), false, 'App state MUST NOT leak raw API key');
  assert.equal(stateRes.structuredContent.quota?.available, true, 'app_get_state must expose Codex quota');
  assert.equal(stateRes.structuredContent.quota?.primary?.remainingPercent, 98);
  assert.equal(stateRes.structuredContent.quota?.secondary?.remainingPercent, 71);
  assert.equal(stateRes.structuredContent.activeSession?.contextUsage?.usedTokens, 21086);
  assert.equal(stateRes.structuredContent.activeSession?.contextUsage?.maxTokens, 475000);
  assert.equal(stateRes.structuredContent.activeSession?.contextUsage?.usedPercent, 4.4);

  const refreshQuotaRes = await client.callTool({
    name: 'app_refresh_quota',
    arguments: { sessionId: mockCodexQuotaSess.id },
  });
  assert.equal(refreshQuotaRes.structuredContent?.ok, true);
  assert.equal(refreshQuotaRes.structuredContent?.quota?.primary?.remainingPercent, 98);
  assert.equal(refreshQuotaRes.structuredContent?.contextUsage?.usedTokens, 21086);

  assert.equal(stateRes.structuredContent.userProfile?.userName, '老板阿明');
  assert.ok(stateRes.structuredContent.defaultPermissions?.fileScope);
  assert.ok(stateRes.structuredContent.modelReasoningLevels?.['gpt-6.2-sol']?.includes('ultra'));
  const dsApp = stateRes.structuredContent.personas.find((p) => p.id === 'ds-r1');
  assert.equal(dsApp.hasApiKey, true);
  assert.equal(dsApp.apiKeyHint, 'sk-...7766');
  assert.equal(stateRes.structuredContent.userProfile?.themeMode, 'auto');

  const setThemeRes = await client.callTool({ name: 'app_set_theme', arguments: { themeMode: 'light' } });
  assert.equal(setThemeRes.structuredContent?.ok, true);
  assert.equal(setThemeRes.structuredContent?.themeMode, 'light');
  const stateAfterTheme = await client.callTool({ name: 'app_get_state', arguments: {} });
  assert.equal(stateAfterTheme.structuredContent.userProfile?.themeMode, 'light');
  const saveProfTheme = await client.callTool({
    name: 'app_save_user_profile',
    arguments: { userName: '老板阿明', themeMode: 'dark' },
  });
  assert.equal(saveProfTheme.structuredContent?.userProfile?.themeMode, 'dark');
  await client.callTool({ name: 'app_set_theme', arguments: { themeMode: 'auto' } });

  await client.close();
  pass('6. MCP Stdio 协议实测（SideDesk 全套工具 + app_set_theme 明暗主题持久化 + 全 6 档推理 + 专属称呼与记忆 + app_emergency_trip + 零 Key 泄露）');

  // -------------------------------------------------------------------------
  // 7. Red-Team Security Audit Suite (Prefix Collision, Symlink/Junction Escape,
  //    Git Option Injection, Random-Nonce Markdown XSS, SVG Interception, Zero Key Leak,
  //    State Pruning & Prototype Guard, Zero-Personal-Path Launcher)
  // -------------------------------------------------------------------------
  const projDir = join(rootTmp, 'proj');
  const projEvilDir = join(rootTmp, 'proj_evil');
  mkdirSync(projDir, { recursive: true });
  mkdirSync(projEvilDir, { recursive: true });
  writeFileSync(join(projDir, 'ok.txt'), 'safe content\n', 'utf8');
  writeFileSync(join(projEvilDir, 'secret.txt'), 'TOP_SECRET_EVIL_DATA\n', 'utf8');

  // 7a: Sibling prefix collision (`proj` vs `proj_evil`) + Windows drive-case normalization
  assert.equal(isSameOrInsideRealPath(projDir, projEvilDir), false, 'proj MUST NOT match proj_evil');
  assert.equal(
    isSameOrInsideRealPath(projDir, join(projEvilDir, 'secret.txt')),
    false,
    'proj MUST NOT match proj_evil/secret.txt'
  );
  if (process.platform === 'win32') {
    const flippedDrive = projDir[0] === projDir[0].toUpperCase()
      ? projDir[0].toLowerCase() + projDir.slice(1)
      : projDir[0].toUpperCase() + projDir.slice(1);
    assert.equal(isSameOrInsideRealPath(flippedDrive, join(projDir, 'ok.txt')), true, 'Windows drive-letter case must normalize');
  }
  assert.throws(
    () => assertInsideRoot(projDir, join(projEvilDir, 'secret.txt')),
    /路径越界拦截/,
    'assertInsideRoot must block proj_evil sibling prefix collision'
  );
  assert.throws(
    () => resolveSafeShadowPath(projDir, '../proj_evil/secret.txt'),
    /路径越界拦截/,
    'resolveSafeShadowPath must block ../proj_evil'
  );
  const evilRead = executeShadowTool(projDir, 'workspace-write', 'read_file', {
    path: '../proj_evil/secret.txt',
  });
  assert.equal(evilRead.ok, false);
  assert.match(evilRead.error, /路径越界拦截/);

  // 7b: Symlink / Windows Junction Escape Defense across prescan, shadow tools, diff & apply
  const srcJunc = join(projDir, 'evil_junc');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(projEvilDir, srcJunc, linkType);

  const prescanRes = prescanSourceDir(projDir);
  assert.equal(prescanRes.fileCount, 1, 'prescan must skip junction pointing outside root');
  assert.ok(prescanRes.skippedSymlinks.includes('evil_junc'));
  assert.equal(prescanRes.files.some((f) => f.relPosix.includes('secret.txt')), false);

  const rtShadow = createShadowCopy(store, projDir);
  assert.equal(existsSync(join(rtShadow.workDir, 'evil_junc')), false);

  // Plant a junction INSIDE shadow workDir pointing to proj_evil
  const workJunc = join(rtShadow.workDir, 'escape_junc');
  symlinkSync(projEvilDir, workJunc, linkType);

  assert.throws(
    () => resolveSafeShadowPath(rtShadow.workDir, 'escape_junc/secret.txt'),
    /路径越界拦截/,
    'resolveSafeShadowPath must block existing file through junction'
  );
  assert.throws(
    () => resolveSafeShadowPath(rtShadow.workDir, 'escape_junc/new_pwn.txt', { allowMissingLeaf: true }),
    /路径越界拦截/,
    'resolveSafeShadowPath must block new file creation through junction'
  );
  const juncRead = executeShadowTool(rtShadow.workDir, 'workspace-write', 'read_file', {
    path: 'escape_junc/secret.txt',
  });
  assert.equal(juncRead.ok, false);
  const juncWrite = executeShadowTool(rtShadow.workDir, 'workspace-write', 'write_file', {
    path: 'escape_junc/pwn.txt',
    content: 'owned',
  });
  assert.equal(juncWrite.ok, false);
  assert.equal(existsSync(join(projEvilDir, 'pwn.txt')), false, 'Junction write MUST NOT touch proj_evil');
  const juncList = executeShadowTool(rtShadow.workDir, 'workspace-write', 'list_files', {});
  assert.equal(juncList.ok, true);
  assert.equal(juncList.files.some((f) => f.includes('secret.txt') || f.includes('escape_junc')), false);
  const juncSearch = executeShadowTool(rtShadow.workDir, 'workspace-write', 'search_text', {
    query: 'TOP_SECRET_EVIL_DATA',
  });
  assert.equal(juncSearch.ok, true);
  assert.equal(juncSearch.count, 0, 'search_text must never traverse junction');

  const diffWithJunc = computeShadowDiff(rtShadow);
  assert.equal(diffWithJunc.fullPatch.includes('TOP_SECRET_EVIL_DATA'), false, 'computeShadowDiff must never read through junction');

  // Remove planted junction from shadow, add legitimate file inside sub/, then plant junction sub -> proj_evil in sourceDir
  rmSync(workJunc, { recursive: true, force: true });
  rmSync(srcJunc, { recursive: true, force: true });
  mkdirSync(join(rtShadow.workDir, 'sub'), { recursive: true });
  writeFileSync(join(rtShadow.workDir, 'sub', 'payload.txt'), 'legit\n', 'utf8');
  symlinkSync(projEvilDir, join(projDir, 'sub'), linkType);
  assert.throws(
    () => applyShadowToSource(store, rtShadow, { force: true }),
    /路径越界拦截/,
    'applyShadowToSource must refuse writing through sourceDir junction'
  );
  assert.equal(existsSync(join(projEvilDir, 'payload.txt')), false, 'applyShadowToSource must NOT write into proj_evil');
  rmSync(join(projDir, 'sub'), { recursive: true, force: true });

  // 7c: Git option injection defense (filename starting with `-`)
  rmSync(join(rtShadow.workDir, 'sub'), { recursive: true, force: true });
  writeFileSync(join(rtShadow.workDir, '--help.txt'), 'safe dash file\n', 'utf8');
  const dashDiff = computeShadowDiff(rtShadow);
  assert.ok(dashDiff.files.some((f) => f.path === '--help.txt' && f.status === 'added'));
  const dashApply = applyShadowToSource(store, rtShadow, { force: false });
  assert.equal(dashApply.applied, true);
  assert.equal(existsSync(join(projDir, '--help.txt')), true);
  const dashUndo = undoLastApply(store, { backupId: dashApply.backupId });
  assert.equal(dashUndo.undone, true);
  assert.equal(existsSync(join(projDir, '--help.txt')), false);
  assert.equal(existsSync(join(projEvilDir, 'secret.txt')), true, 'Undo cleanup must NEVER touch proj_evil');
  discardShadow(store, rtShadow.id);

  // 7d: Frontend Markdown Random-Nonce anti-XSS & SVG avatar/attachment interception
  const xssPayload = '@@BLK_0@@ <img src=x onerror="alert(1)">\n```js\nconst a = 1 < 2;\n```\n@@BLK_0@@';
  const renderedMd = renderMarkdown(xssPayload);
  assert.equal(/<img\b/i.test(renderedMd), false, 'Markdown must NEVER emit unescaped <img>');
  assert.ok(renderedMd.includes('@@BLK_0@@'), 'Predictable @@BLK_0@@ literal must stay harmless text (random nonce used)');
  assert.ok(renderedMd.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
  assert.equal(esc("a'b\"c<d>e&f"), 'a&#39;b&quot;c&lt;d&gt;e&amp;f');

  const svgDataUrl = 'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+PC9zdmc+';
  assert.equal(isImageAvatar(svgDataUrl), false, 'Frontend isImageAvatar MUST reject image/svg+xml');
  assert.equal(isImageAvatar('javascript:alert(1)'), false);
  assert.equal(isImageAvatar(tinyPngDataUrl), true, 'Frontend isImageAvatar must allow PNG bitmap');
  assert.throws(
    () => store.saveAttachmentFromDataUrl(svgDataUrl, 'xss.svg'),
    /不安全|仅支持/,
    'Backend saveAttachmentFromDataUrl MUST reject image/svg+xml'
  );
  assert.throws(
    () => store.savePersona({ id: 'ds-r1', name: 'DeepSeek 审计官', avatar: svgDataUrl }),
    /不安全|仅允许/,
    'Backend savePersona MUST reject SVG avatar'
  );
  assert.throws(
    () => store.saveUserProfile({ userAvatar: svgDataUrl }),
    /不安全|仅允许/,
    'Backend saveUserProfile MUST reject SVG avatar'
  );

  // 7e: API Key 100% Zero-Leakage on upstream 401 echo error across connection test, job error, events, logs & session messages
  const leakConn = await hub.testOpenAiConnection({
    baseUrl: mockBaseUrl,
    model: 'leak-test-model',
    existingPersonaId: 'ds-r1',
  });
  assert.equal(leakConn.ok, false);
  assert.equal(JSON.stringify(leakConn).includes('sk-secret-99887766'), false, 'testConnection error MUST NOT leak API key');
  assert.ok(String(leakConn.error).includes('[REDACTED]'));

  const { job: leakJob, session: leakSess } = hub.startJob({
    sourceDir: turboDir,
    personaId: 'ds-r1',
    sandbox: 'turbo-direct',
    createdBy: 'boss',
    prompt: 'LEAK_KEY_ERROR_TEST',
  });
  const leakDone = await hub.waitForJob(leakJob.id, 15);
  assert.equal(leakDone.status, 'failed');
  assert.equal(JSON.stringify(leakDone).includes('sk-secret-99887766'), false, 'Failed job object MUST NOT leak API key');
  assert.equal(JSON.stringify(leakSess.messages).includes('sk-secret-99887766'), false, 'Session messages MUST NOT leak API key');
  const leakLogPath = join(dataDir, 'job_logs', `${leakJob.id}.jsonl`);
  if (existsSync(leakLogPath)) {
    assert.equal(
      readFileSync(leakLogPath, 'utf8').includes('sk-secret-99887766'),
      false,
      'Disk job_logs JSONL MUST NOT leak API key'
    );
  }
  assert.equal(
    redactSecrets('Authorization: Bearer my-super-secret-token-999', ['my-super-secret-token-999']).includes('my-super-secret-token-999'),
    false
  );

  // 7f: Prototype pollution guard + State pruning bounds + Atomic write persistence
  store.saveDraft('__proto__', { text: 'pollute-attempt' });
  assert.equal(({}).text, undefined, 'saveDraft must block __proto__ pollution');
  for (let i = 0; i < 95; i++) {
    store.state.jobs.push({
      id: `job-prune-${i}`,
      sessionId: leakSess.id,
      status: 'completed',
      liveReply: 'redundant-live-copy',
      events: Array.from({ length: 30 }, (_, k) => ({ ts: Date.now(), kind: 'system', text: `ev-${k}` })),
      createdAt: Date.now(),
    });
  }
  store.flush();
  assert.ok(store.state.jobs.length <= 80, `Jobs must be pruned to <= 80, got ${store.state.jobs.length}`);
  const oldestPruned = store.state.jobs.find((j) => j.id.startsWith('job-prune-'));
  assert.ok(oldestPruned && oldestPruned.events.length <= 12, 'Older finished jobs must prune events to <= 12');
  assert.equal(oldestPruned.liveReply, '', 'Finished jobs must clear redundant liveReply');

  // 7g: Cross-platform zero-personal-path launcher (bin/launch.cmd on Windows) real MCP stdio handshake
  if (process.platform === 'win32') {
    const launchCmd = resolve(__dirname, '..', 'bin', 'launch.cmd');
    assert.equal(existsSync(launchCmd), true, 'bin/launch.cmd must exist');
    const launchTransport = new StdioClientTransport({
      command: launchCmd,
      args: [`--data_dir=${dataDir}`],
    });
    const launchClient = new Client({ name: 'sidedesk-launch-e2e', version: '1.0.0' });
    await launchClient.connect(launchTransport);
    const launchList = await launchClient.callTool({ name: 'sidedesk_list_personas', arguments: {} });
    assert.equal(launchList.structuredContent?.ok, true);
    assert.equal(JSON.stringify(launchList).includes('sk-secret-99887766'), false);
    await launchClient.close();
  }

  pass('7. 红队安全审计全套断言（proj_evil 前缀碰撞 / 软链与 Junction 越界全链路拦截 / Git 参数注入 / 随机 Nonce 防 XSS / SVG 头像与附件拦截 / API Key 零泄露 / 状态裁剪防膨胀 / 零私人路径启动器实测）');

  // -------------------------------------------------------------------------
  // 8. v0.1.1 Hardening + Global Extra PATH & Auto-Node PATH Injection
  // -------------------------------------------------------------------------
  {
    // 8a: Auto-Node PATH + extraPath priority + single canonical Path/PATH key
    const autoNode = getAutoNodeDir();
    assert.ok(autoNode && existsSync(autoNode), 'getAutoNodeDir must resolve running Node directory');
    const augEnv = buildAugmentedEnv(
      { Path: 'C:\\Windows\\System32', PATH: 'C:\\Windows' },
      'D:\\custom-tools-alpha\nD:\\custom-tools-beta;D:\\custom-tools-alpha'
    );
    const pathKeys = Object.keys(augEnv).filter((k) => k.toLowerCase() === 'path');
    assert.equal(pathKeys.length, 1, 'Must deduplicate case-variant Path/PATH keys');
    const mergedParts = augEnv[pathKeys[0]].split(process.platform === 'win32' ? ';' : ':');
    assert.equal(mergedParts[0], 'D:\\custom-tools-alpha', 'extraPath entry #1 must take highest priority');
    assert.equal(mergedParts[1], 'D:\\custom-tools-beta', 'extraPath entry #2 must preserve order');
    assert.ok(
      mergedParts.some((p) => p.toLowerCase() === autoNode.toLowerCase()),
      'Auto Node dir must be present in merged PATH'
    );

    // Persist extraPath via store.saveDefaultPermissions
    store.saveDefaultPermissions({ extraPath: 'D:\\my-extra-cli;D:\\my-python' });
    assert.equal(store.getExtraPath(), 'D:\\my-extra-cli;D:\\my-python');

    // 8b: edit_file `$&` / `$$` literal replacement safety (no regex replacement corruption)
    const dollarDir = join(rootTmp, 'dollar_proj');
    mkdirSync(join(dollarDir, 'bin'), { recursive: true });
    writeFileSync(join(dollarDir, 'price.js'), 'const label = "OLD";\n', 'utf8');
    writeFileSync(join(dollarDir, 'bin', 'cli.js'), '#!/usr/bin/env node\nconsole.log(1);\n', 'utf8');
    const dollarShadow = createShadowCopy(store, dollarDir);
    assert.equal(
      existsSync(join(dollarShadow.workDir, 'bin', 'cli.js')),
      true,
      'Non-.NET bin/ scripts directory must NOT be skipped in shadow copies'
    );
    const repOut = executeShadowTool(dollarShadow.workDir, 'workspace-write', 'edit_file', {
      path: 'price.js',
      old_text: 'OLD',
      new_text: 'cost: $& / $$ / $1',
    });
    assert.equal(repOut.ok, true);
    assert.equal(
      readFileSync(join(dollarShadow.workDir, 'price.js'), 'utf8'),
      'const label = "cost: $& / $$ / $1";\n'
    );

    // 8c: Even if an agent runs `git commit` inside shadow.workDir, baseCommit diff STILL catches changes!
    spawnSync('git', ['add', '-A'], { cwd: dollarShadow.workDir, windowsHide: true });
    spawnSync('git', ['commit', '-q', '-m', 'agent-internal-commit'], {
      cwd: dollarShadow.workDir,
      windowsHide: true,
    });
    const postCommitDiff = computeShadowDiff(dollarShadow);
    assert.equal(postCommitDiff.hasChanges, true, 'baseCommit diff must catch committed shadow edits');
    assert.equal(postCommitDiff.files.length, 1);
    assert.equal(postCommitDiff.files[0].path, 'price.js');

    // 8d: Apply -> manual user edit -> undoLastApply blocks clobbering unless force=true
    const appRes = applyShadowToSource(store, dollarShadow);
    assert.equal(appRes.applied, true);
    writeFileSync(join(dollarDir, 'price.js'), 'const label = "USER_MANUAL_EDIT";\n', 'utf8');
    const safeUndo = undoLastApply(store, { backupId: appRes.backupId });
    assert.equal(safeUndo.undone, false);
    assert.equal(safeUndo.conflict, true, 'Undo must pause when user manually edited file after Apply');
    assert.equal(
      readFileSync(join(dollarDir, 'price.js'), 'utf8'),
      'const label = "USER_MANUAL_EDIT";\n'
    );
    const forcedUndo = undoLastApply(store, { backupId: appRes.backupId, force: true });
    assert.equal(forcedUndo.undone, true);
    assert.equal(readFileSync(join(dollarDir, 'price.js'), 'utf8'), 'const label = "OLD";\n');

    // 8e: Cross-host Base URL switch blocks silent credential leak on both testConnection & savePersona
    assert.equal(isSameEndpointHost('https://api.deepseek.com', 'https://api.deepseek.com/v1'), true);
    assert.equal(isSameEndpointHost('https://api.deepseek.com', 'https://evil.example.com/v1'), false);
    const crossHostTest = await hub.testOpenAiConnection({
      baseUrl: 'http://127.0.0.1:65530/v1',
      model: 'deepseek-chat',
      existingPersonaId: 'ds-r1',
    });
    assert.equal(crossHostTest.ok, false);
    assert.match(crossHostTest.error, /接口域名已变更/);
    assert.throws(
      () => store.savePersona({ id: 'ds-r1', baseUrl: 'https://other-host.example.com/v1', apiKey: '' }),
      /接口域名已变更/
    );
  }
  pass('8. v0.1.1 自审加固全套断言（全局附加 PATH + 自动补 Node 路径 / $& 字面替换 / bin 脚本保留 / 副本内 commit 防隐身 / 撤销防覆盖手动编辑 / 跨域名防旧 Key 泄漏）');

  console.log('\n🎉 ALL SIDEDESK v0.1.1 BACKEND + QUOTA + RED-TEAM E2E TESTS PASSED!');
} finally {
  mockServer.close();
  try {
    rmSync(rootTmp, { recursive: true, force: true });
  } catch {
    // ignore Windows lock
  }
}
