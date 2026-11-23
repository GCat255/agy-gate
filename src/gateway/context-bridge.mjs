const SKIPPED_EPHEMERAL_TYPES = new Set(['agent-switched', 'model-switched', 'location-switched', 'idle']);

function messageTimeCreated(msg) {
  const t = msg?.time?.created;
  return typeof t === 'number' && Number.isFinite(t) ? t : 0;
}

function truncateText(text, maxLen) {
  const s = String(text || '').trim();
  if (!s) return '';
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
}

function formatAssistantMessage(msg) {
  const parts = Array.isArray(msg?.content) ? msg.content : [];
  const lines = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      lines.push(truncateText(part.text, 4000));
    } else if (part.type === 'tool') {
      const name = part.name || 'tool';
      const target =
        part.state?.input?.path ||
        part.state?.input?.command ||
        part.state?.input?.pattern ||
        part.state?.input?.query ||
        part.state?.input?.description ||
        '';
      const summary = target ? `${name}(${truncateText(target, 120)})` : name;
      const status = part.state?.status || 'completed';
      lines.push(`[Tool ${summary}: ${status}]`);
    }
  }
  return lines.join('\n');
}

function formatSingleMessage(msg) {
  if (!msg || typeof msg !== 'object') return '';
  if (SKIPPED_EPHEMERAL_TYPES.has(msg.type)) return '';
  if (msg.type === 'compaction') {
    const summary = truncateText(msg.summary || '', 4000);
    return summary ? `[Previous Compaction Summary]\n${summary}` : '';
  }
  if (msg.type === 'user') {
    const body = truncateText(msg.text || '', 4000);
    const fileNames = Array.isArray(msg.files)
      ? msg.files.map((f) => f?.name || f?.filename).filter(Boolean)
      : [];
    const fileNote = fileNames.length > 0 ? ` [Files: ${fileNames.join(', ')}]` : '';
    return body || fileNote ? `User: ${body}${fileNote}`.trim() : '';
  }
  if (msg.type === 'assistant') {
    const body = formatAssistantMessage(msg);
    return body ? `Assistant:\n${body}` : '';
  }
  if (msg.type === 'synthetic') {
    const body = truncateText(msg.text || '', 1500);
    return body ? `[Context]: ${body}` : '';
  }
  return '';
}

function fitFormattedBlocks(blocks, maxChars) {
  if (blocks.length === 0) return '';
  const selected = [];
  let total = 0;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const item = blocks[i];
    const sep = selected.length > 0 ? 2 : 0;
    if (total + sep + item.length > maxChars) {
      if (selected.length === 0) {
        selected.unshift(truncateText(item, maxChars));
      } else {
        selected.unshift('...(earlier turns omitted)...');
      }
      break;
    }
    selected.unshift(item);
    total += sep + item.length;
  }
  return selected.join('\n\n');
}

/**
 * Filter upstream OpenCode messages to those originating outside local `agy-cli` storage
 * and trim everything strictly before the latest completed compaction summary.
 * @param {any[]} upstreamMessages
 * @param {any[]} localMessages
 * @param {Set<string>} [alreadySyncedIds]
 */
export function extractUpstreamOnlyMessages(upstreamMessages, localMessages, alreadySyncedIds = new Set()) {
  const localIds = new Set((localMessages || []).map((m) => m?.id).filter(Boolean));
  const sorted = (Array.isArray(upstreamMessages) ? upstreamMessages : [])
    .filter((m) => m?.id && !localIds.has(m.id) && !alreadySyncedIds.has(m.id))
    .sort((a, b) => {
      const ta = messageTimeCreated(a);
      const tb = messageTimeCreated(b);
      if (ta !== tb) return ta - tb;
      return String(a.id).localeCompare(String(b.id));
    });

  let latestCompactionIdx = -1;
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const m = sorted[i];
    if (m.type === 'compaction' && m.status === 'completed' && typeof m.summary === 'string' && m.summary.trim()) {
      latestCompactionIdx = i;
      break;
    }
  }
  return latestCompactionIdx >= 0 ? sorted.slice(latestCompactionIdx) : sorted;
}

/**
 * Format cross-engine conversation turns into a compact handover context block
 * so the target engine continues seamlessly after a model switch.
 * @param {any[]} messages
 * @param {{ header?: string, maxChars?: number }} [options]
 */
export function formatMessagesAsHandoverContext(messages, options = {}) {
  const maxChars = options.maxChars ?? 16_000;
  const header =
    options.header
    || 'Previous conversation context in this session before switching to agy-cli (continue from here seamlessly):';
  const blocks = (Array.isArray(messages) ? messages : [])
    .map(formatSingleMessage)
    .filter(Boolean);
  if (blocks.length === 0) return '';
  const body = fitFormattedBlocks(blocks, Math.max(500, maxChars - header.length - 64));
  if (!body) return '';
  return `<cross_engine_context>\n${header}\n\n${body}\n</cross_engine_context>`;
}

/**
 * Build a concise summarization prompt for compacting upstream pre-switch conversation turns.
 * @param {string} formattedHistory
 */
export function buildUpstreamCompactionPrompt(formattedHistory) {
  return [
    'Summarize the following conversation history concisely in the same language the user used.',
    'Preserve key user goals, decisions, constraints, unresolved questions, and concrete files/symbols discussed so the next turn can continue seamlessly.',
    'Output only the summary without preamble.',
    '',
    formattedHistory,
  ].join('\n');
}
