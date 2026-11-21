import { CodexRunner } from './codex-runner.mjs';
import { OpenAiRunner } from './openai-runner.mjs';
import { CodexQuotaReader } from './quota-reader.mjs';
import { getContentMessageCount, hasFreshSessionSummary } from './store.mjs';

export class RunnerHub {
  constructor(store, { sessionsDir = '' } = {}) {
    this.store = store;
    this.quotaReader = new CodexQuotaReader({ sessionsDir });
    this.codex = new CodexRunner(store, this.quotaReader);
    this.openai = new OpenAiRunner(store);
    // Non-blocking warm-up so local quota snapshot is ready on first panel open
    this.quotaReader.getQuota().catch(() => {});
  }

  async getQuotaAsync({ force = false } = {}) {
    return this.quotaReader.getQuota({ force });
  }

  async getCodexContextUsageAsync(threadId, { force = false } = {}) {
    return this.quotaReader.getThreadContextUsage(threadId, { force });
  }

  async refreshQuotaAsync(sessionId = '') {
    const sess = sessionId ? this.store.getSession(sessionId) : null;
    const threadId =
      sess && sess.provider !== 'openai-compatible' && sess.codexThreadId
        ? sess.codexThreadId
        : '';
    const { quota, contextUsage } = await this.quotaReader.refreshAll({ threadId });
    if (sess && contextUsage) {
      sess.contextUsage = contextUsage;
      this.store.scheduleSave();
    }
    return {
      quota,
      contextUsage: contextUsage || sess?.contextUsage || null,
    };
  }

  getCodexBinaryFast() {
    return this.codex.getCodexBinaryFast();
  }

  async refreshCodexBinaryAsync(customPath = '') {
    return this.codex.refreshCodexBinaryAsync(customPath);
  }

  async testOpenAiConnection(params) {
    return this.openai.testConnection(params);
  }

  startJob(args) {
    if (!args?.prompt || !String(args.prompt).trim()) {
      throw new Error('指令 prompt 不能为空');
    }

    let session = args.sessionId ? this.store.getSession(args.sessionId) : null;
    if (args.sessionId && !session) {
      throw new Error(`未找到副席会话: ${args.sessionId}`);
    }

    const persona =
      this.store.getPersona(args.personaId || session?.personaId) ||
      this.store.listPersonas()[0];
    if (!persona) {
      throw new Error('未找到可用的人物卡');
    }

    const provider = persona.provider || 'codex-cli';
    if (provider === 'openai-compatible') {
      return this.openai.startJob({ ...args, persona, session });
    }
    return this.codex.startJob({ ...args, persona, session });
  }

  buildSessionTranscript(session) {
    const persona = this.store.getPersona(session.personaId);
    const profile = this.store.getUserProfile();
    const parts = [];
    if (session.inheritedSummary?.summary) {
      parts.push(`[前序继承摘要]\n${session.inheritedSummary.summary}`);
    }
    const msgs = (session.messages || []).filter((m) => m && m.role !== 'system').slice(-40);
    for (const m of msgs) {
      const who =
        m.role === 'assistant'
          ? persona?.name || '成员'
          : m.role === 'hakimi'
            ? `${profile.userName}(主对话)`
            : profile.userName;
      parts.push(`【${who}】\n${String(m.text || '').slice(0, 2000)}`);
    }
    let transcript = parts.join('\n\n');
    if (transcript.length > 24000) {
      transcript = transcript.slice(-24000);
    }
    return transcript;
  }

  /**
   * Summarize a session into a concise handoff summary.
   * Reuses cached latestSummary with ZERO extra quota when reuseIfFresh=true and no new messages arrived.
   */
  async summarizeSessionAsync({ sessionId, summarizerPersonaId = '', reuseIfFresh = true } = {}) {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`未找到话题: ${sessionId}`);
    if (getContentMessageCount(session) === 0) {
      throw new Error('当前话题暂无对话记录，无需压缩');
    }

    if (reuseIfFresh && hasFreshSessionSummary(session)) {
      return {
        ok: true,
        reused: true,
        summary: session.latestSummary.summary,
        meta: session.latestSummary,
      };
    }

    const summarizer =
      this.store.getPersona(summarizerPersonaId || session.personaId) ||
      this.store.listPersonas()[0];
    if (!summarizer) {
      throw new Error('未找到可用于整理摘要的成员');
    }

    const transcript = this.buildSessionTranscript(session);
    const sumPrompt = [
      '请将下面的 1v1 工程协作话题浓缩为一份高密度、结构化的上下文交接摘要（控制在 300~600 字以内），方便新话题或压缩后的续聊直接衔接：',
      '1. 目标与背景',
      '2. 已确认的结论、关键文件路径与设计决策',
      '3. 已完成的修改或排查结果',
      '4. 尚未完成的待办或下一步计划（如有）',
      '要求：仅输出摘要正文，禁止寒暄，禁止编造未提及内容。',
      '',
      `=== 话题「${session.title}」记录 ===`,
      transcript,
    ].join('\n');

    let summaryText = '';
    if (summarizer.provider === 'openai-compatible') {
      summaryText = await this.openai.runOneShotCompletion(summarizer, sumPrompt);
    } else {
      summaryText = await this.codex.runOneShotSummary(summarizer, sumPrompt);
    }

    const meta = this.store.setSessionLatestSummary(session.id, summaryText, {
      summarizerPersonaId: summarizer.id,
      summarizerName: summarizer.name,
    });
    return {
      ok: true,
      reused: false,
      summary: meta.summary,
      meta,
    };
  }

  /**
   * Compress a session in place: summarize, reset codexThreadId & openaiMessages,
   * and attach the compressed summary as session.inheritedSummary for lightweight continuation.
   */
  async compressSessionInPlaceAsync({ sessionId, summarizerPersonaId = '' } = {}) {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`未找到话题: ${sessionId}`);
    const running = this.store.state.jobs.find(
      (j) => j.sessionId === sessionId && j.status === 'running'
    );
    if (running) {
      throw new Error('当前话题正在执行任务，请等待完成或先中止后再压缩');
    }

    const res = await this.summarizeSessionAsync({
      sessionId,
      summarizerPersonaId,
      reuseIfFresh: false,
    });

    session.codexThreadId = null;
    session.openaiMessages = [];
    session.contextUsage = null;
    session.inheritedSummary = {
      sourceSessionId: session.id,
      sourceTitle: session.title,
      summary: res.summary,
      updatedAt: Date.now(),
    };
    session.anchorState = {
      digest: String(session.anchorState?.digest || ''),
      turnsSinceSync: 0,
      charsSinceSync: 0,
      forceSync: true,
    };
    this.store.appendSessionMessage(session.id, {
      role: 'system',
      text: `已由「${res.meta.summarizerName || '成员'}」原地压缩上下文摘要并重置底层长线程，后续对话将轻装继续。`,
    });
    this.store.flush();
    return {
      ok: true,
      summary: res.summary,
      meta: res.meta,
      session,
    };
  }

  waitForJob(jobId, timeoutSec = 0) {
    const job = this.store.getJob(jobId);
    if (!job) return Promise.resolve(null);
    if (job.provider === 'openai-compatible') {
      return this.openai.waitForJob(jobId, timeoutSec);
    }
    return this.codex.waitForJob(jobId, timeoutSec);
  }

  abortJob(jobId, reason) {
    const job = this.store.getJob(jobId);
    if (!job) throw new Error(`未找到任务: ${jobId}`);
    if (job.provider === 'openai-compatible' || this.openai.hasRunningJob(jobId)) {
      return this.openai.abortJob(jobId, reason);
    }
    return this.codex.abortJob(jobId, reason);
  }

  /**
   * Global Emergency Trip:
   * 1. Immediately kills ALL running Codex process trees and aborts ALL in-flight OpenAI requests (never auto-restarts).
   * 2. If global default permissions are in Turbo direct mode (fileScope === "direct"), safely downgrades to "shadow".
   */
  emergencyTrip(reason = '全局急停熔断') {
    const abortedSet = new Set([
      ...this.codex.abortAllJobs(reason),
      ...this.openai.abortAllJobs(reason),
    ]);

    // Sweep any lingering "running" jobs across all sessions
    for (const job of this.store.state.jobs) {
      if (job.status === 'running') {
        try {
          const res = this.abortJob(job.id, reason);
          if (res.aborted) abortedSet.add(job.id);
        } catch {
          job.status = 'aborted';
          job.stage = 'aborted';
          job.stageLabel = '已熔断';
          job.abortReason = reason;
          job.finishedAt = Date.now();
          abortedSet.add(job.id);
        }
      }
    }

    let downgradedGlobalToShadow = false;
    const globalPerms = this.store.getDefaultPermissions();
    if (globalPerms.fileScope === 'direct') {
      this.store.saveDefaultPermissions({ ...globalPerms, fileScope: 'shadow' });
      downgradedGlobalToShadow = true;
    }

    this.store.flush();
    return {
      ok: true,
      abortedCount: abortedSet.size,
      abortedJobIds: Array.from(abortedSet),
      downgradedGlobalToShadow,
      defaultPermissions: this.store.getDefaultPermissions(),
    };
  }

  shutdownAll() {
    this.codex.shutdownAll();
    this.openai.shutdownAll();
  }
}
