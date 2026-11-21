import { createHash } from 'node:crypto';
import { normalizePermissions } from './store.mjs';

export const ANCHOR_TURN_THRESHOLD = 4;
export const ANCHOR_CHAR_THRESHOLD = 24_000;

/**
 * Resolves who the member should address the user as:
 * 1. Persona-specific `addressUserAs` (if non-empty)
 * 2. Global `userProfile.userName` (if non-empty and not default "我")
 * 3. Empty string (no forced form of address)
 */
export function resolvePreferredUserTitle(persona, userProfile) {
  const custom = typeof persona?.addressUserAs === 'string' ? persona.addressUserAs.trim() : '';
  if (custom) return custom;
  const globalName =
    typeof userProfile?.userName === 'string' ? userProfile.userName.trim() : '';
  if (globalName && globalName !== '我') return globalName;
  return '';
}

/**
 * Builds the 5-part structured character & memory profile block:
 * 1. Member self-identity & role
 * 2. User address priority (persona override > global profile)
 * 3. Personality & expression guidelines (persona.systemPrompt)
 * 4. Enabled long-term memory entries
 * 5. Tone vs. engineering rigor decoupling notice
 */
export function composePersonaProfileBlock(persona, userProfile = null) {
  const sections = [];

  // 1. Identity
  const name = String(persona?.name || '副席成员').trim();
  const role = String(persona?.role || '').trim();
  sections.push(
    role
      ? `你是当前副席 1v1 工位中的成员「${name}」（职责定位：${role}）。`
      : `你是当前副席 1v1 工位中的成员「${name}」。`
  );

  // 2. User addressing priority
  const callName = resolvePreferredUserTitle(persona, userProfile);
  if (callName) {
    sections.push(`请在交流中自然地称呼对方为「${callName}」，保持前后一致的称谓习惯。`);
  }

  // 3. Persona style & system prompt
  const promptBody = typeof persona?.systemPrompt === 'string' ? persona.systemPrompt.trim() : '';
  if (promptBody) {
    sections.push(`【角色性格与表达设定】\n${promptBody}`);
  }

  // 4. Active long-term memories
  const activeMemories = Array.isArray(persona?.memories)
    ? persona.memories
        .filter((m) => m && m.enabled !== false && String(m.text || '').trim())
        .map((m) => String(m.text).trim())
    : [];
  if (activeMemories.length > 0) {
    sections.push(
      `【生效中的长期记忆与约定】\n${activeMemories.map((line) => `- ${line}`).join('\n')}`
    );
  }

  // 5. Decoupling statement (eliminates engineering-model resistance to persona voice)
  sections.push(
    [
      '【表达风格与工程严谨度解耦说明】',
      '以上角色设定仅用于确定你的身份视角、称呼习惯与语言表达风格，不会降低你在代码审查、故障排查与事实核查上的严谨标准，也不会放宽或改变当前工作区的权限与安全边界。',
    ].join('\n')
  );

  return sections.join('\n\n');
}

export function computeProfileDigest(profileBlock) {
  return createHash('sha256')
    .update(String(profileBlock || ''), 'utf8')
    .digest('hex')
    .slice(0, 24);
}

/**
 * Per-turn lightweight situational guidance header.
 * Attached ONLY to the outbound model request — NEVER persisted into UI chat bubbles.
 */
export function composeTurnGuidanceHeader({
  workDir = '',
  permissions = null,
  directMode = false,
  hadRollback = false,
  inheritedSummary = null,
  isFirstTurnWithInherited = false,
} = {}) {
  const perms = normalizePermissions(permissions, directMode ? 'turbo-direct' : 'workspace-write');
  const isDirect = Boolean(directMode || perms.fileScope === 'direct');
  let modeDesc = '影子隔离副本（所有修改仅留在隔离副本中，经用户验收后才写回原目录）';
  if (isDirect) {
    modeDesc = '原目录直通读写（跳过影子副本，改动直接保存至原目录）';
  } else if (perms.fileScope === 'read-only') {
    modeDesc = '只读分析（禁止修改或新建任何文件）';
  }
  if (perms.commandPolicy === 'disabled') {
    modeDesc += '；禁止执行终端命令';
  }

  const lines = [
    '【本轮态势与协作提醒】',
    `- 当前工作区：${workDir || '.'}｜生效权限：${modeDesc}`,
    '- 避免过度工程化：若对方本轮只是日常问候、闲聊或纯观点讨论，请直接自然回应，不要无故扫描项目目录、执行终端命令或先列一串工程步骤；仅当对方明确要求查看代码、排查问题或修改文件时再按需调用工具。',
    '- 事实边界：汇报检查与执行结果时，请如实区分「已实际读取或运行验证过的内容」与「尚未实际验证的推测」。',
  ];

  if (hadRollback) {
    lines.push(
      '- 磁盘回退提示：用户刚刚撤回了上一轮的文件改动（或丢弃了未应用的副本），当前目录已恢复至回退后状态；如需继续修改，请务必先重新读取相关文件的最新磁盘内容，切勿依赖上轮记忆中的旧代码。'
    );
  }

  if (isFirstTurnWithInherited && inheritedSummary?.summary?.trim()) {
    lines.push(
      `- 上下文衔接：本话题延续自「${String(inheritedSummary.sourceTitle || '上一话题').trim()}」的压缩摘要，请直接承接推进，无需让对方重头复述。`
    );
  }

  return lines.join('\n');
}

export function composeRecencySyncBlock(profileBlock) {
  return [
    '【最新角色设定与记忆同步】',
    '自本轮起请严格以以下最新角色设定、称呼约定与生效中的记忆条为准；未出现在下方列表中的旧设定或已关闭记忆不再沿用：',
    '',
    String(profileBlock || '').trim(),
  ].join('\n');
}

/**
 * Four-condition dynamic anchor refresh state machine.
 * Mutates `session.anchorState` in place and returns:
 *   { shouldInjectRecencySync, reasons, digest, recencySyncBlock, anchorState }
 *
 * Conditions triggering recency sync on subsequent turns (or pre-armed first turn):
 *  1. Turn interval threshold: turnsSinceSync + 1 >= 4 (Turn 1 anchors; Turns 2..4 skip; Turn 5 triggers)
 *  2. Character washout threshold: charsSinceSync + userPromptText.length >= 24000
 *  3. Hot persona edit: previous digest !== currentDigest
 *  4. Forced re-anchor: anchorState.forceSync === true (after compaction or inherited summary)
 */
export function evaluateAnchorSync(session, profileBlock, userPromptText = '') {
  const currentDigest = computeProfileDigest(profileBlock);
  const promptLen = String(userPromptText || '').length;

  const prev =
    session?.anchorState && typeof session.anchorState === 'object'
      ? {
          digest: String(session.anchorState.digest || ''),
          turnsSinceSync: Number(session.anchorState.turnsSinceSync) || 0,
          charsSinceSync: Number(session.anchorState.charsSinceSync) || 0,
          forceSync: Boolean(session.anchorState.forceSync),
        }
      : { digest: '', turnsSinceSync: 0, charsSinceSync: 0, forceSync: false };

  // Brand-new session first turn (no prior digest yet)
  if (!prev.digest) {
    const forcedFirst = prev.forceSync === true;
    const nextState = {
      digest: currentDigest,
      turnsSinceSync: 0,
      charsSinceSync: 0,
      forceSync: false,
    };
    if (session) session.anchorState = nextState;
    return {
      shouldInjectRecencySync: forcedFirst,
      reasons: forcedFirst ? ['force_sync'] : ['initial_turn'],
      digest: currentDigest,
      recencySyncBlock: forcedFirst ? composeRecencySyncBlock(profileBlock) : '',
      anchorState: nextState,
    };
  }

  const nextTurns = prev.turnsSinceSync + 1;
  const nextChars = prev.charsSinceSync + promptLen;
  const reasons = [];

  if (nextTurns >= ANCHOR_TURN_THRESHOLD) reasons.push('turn_threshold');
  if (nextChars >= ANCHOR_CHAR_THRESHOLD) reasons.push('char_threshold');
  if (prev.digest !== currentDigest) reasons.push('digest_changed');
  if (prev.forceSync) reasons.push('force_sync');

  const shouldInject = reasons.length > 0;
  const nextState = shouldInject
    ? {
        digest: currentDigest,
        turnsSinceSync: 0,
        charsSinceSync: 0,
        forceSync: false,
      }
    : {
        digest: currentDigest,
        turnsSinceSync: nextTurns,
        charsSinceSync: nextChars,
        forceSync: false,
      };

  if (session) session.anchorState = nextState;

  return {
    shouldInjectRecencySync: shouldInject,
    reasons,
    digest: currentDigest,
    recencySyncBlock: shouldInject ? composeRecencySyncBlock(profileBlock) : '',
    anchorState: nextState,
  };
}

/**
 * Composes the outbound prompt text sent to the underlying model/CLI for this turn only.
 * Never written to UI chat history (`session.messages`) or persisted API history.
 */
export function composeOutboundUserPayload({
  userPrompt = '',
  turnGuidanceHeader = '',
  recencySyncBlock = '',
} = {}) {
  const parts = [];
  if (recencySyncBlock && recencySyncBlock.trim()) {
    parts.push(recencySyncBlock.trim());
  }
  if (turnGuidanceHeader && turnGuidanceHeader.trim()) {
    parts.push(turnGuidanceHeader.trim());
  }
  parts.push(`【用户本轮消息】\n${String(userPrompt || '')}`);
  return parts.join('\n\n');
}
