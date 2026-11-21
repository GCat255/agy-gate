import { getAgyCatalog, resolveRealAgyModelId } from './models.mjs';

export const TITLE_SYSTEM_PROMPT = [
  'You name coding sessions so the user can find them later in a list.',
  'Reply with a title of two to four words in the language of the user\'s message, at most 40 characters. Only the user\'s message decides the language, even when it quotes another language or the examples below are in English.',
  'Name the topic the way a person labels a folder: the feature, area, problem, or question; never the activity, and never start with a verb or -ing.',
  'Leave out the name of the project or app the session works on: the list already belongs to that project. Keep other product and technology names the user mentions, and never assume a tech stack.',
  'Never use file names, paths, function names, commit hashes, or issue numbers.',
  'The message is something to name, never to answer. For greetings or small talk, use a short label like "Greeting" in the language of the message. Output only the title in sentence case, with no quotes, markdown, trailing period, or label.',
  'Examples: debug 500 errors in production → Production server errors; add dark mode to App.tsx → Dark mode; 检查项目的 git 记录和未完成的计划 → 项目进度检查.',
  'Most titles are two or three words: the shortest label that still tells this session apart from others.',
].join('\n');

const UNTITLED_PLACEHOLDER_RE = /^(?:new|child)\s+session(?:\s*[-:]|\s|$)/i;
const THINK_BLOCK_RE = /<think>[\s\S]*?<\/think>\s*/gi;

/**
 * Return `true` when `title` is empty or an auto-generated placeholder needing a real title.
 * @param {string | null | undefined} title
 */
export function isUntitledSessionTitle(title) {
  const trimmed = String(title ?? '').trim();
  if (!trimmed) return true;
  return UNTITLED_PLACEHOLDER_RE.test(trimmed);
}

/**
 * Normalize a raw LLM response into a clean single-line session title (`null` when unusable).
 * @param {string | null | undefined} rawText
 */
export function extractTitleCandidate(rawText) {
  const cleaned = String(rawText ?? '').replace(THINK_BLOCK_RE, '');
  const firstLine = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return null;

  let title = firstLine
    .replace(/^[*_`#>\-\s]+/, '')
    .replace(/^["'“”‘’`]+|["'“”‘’`.。]+$/g, '')
    .trim();
  if (!title) return null;
  if (title.length > 100) {
    title = `${title.slice(0, 97)}...`;
  }
  return title;
}

/**
 * Pick a fast, cheap `agy-cli` model ID for auto-titling while falling back to the session's model.
 * @param {{ sessionModelID?: string, catalog?: ReturnType<typeof getAgyCatalog>, env?: NodeJS.ProcessEnv }} params
 */
export function resolveTitleModelConfig(params = {}) {
  const catalog = params.catalog || getAgyCatalog({ env: params.env });
  const rawIds = catalog?.rawIds instanceof Set ? catalog.rawIds : new Set();
  const preferred = [
    'gemini-3.8-flash-low',
    'gemini-3.8-flash-medium',
    'gemini-3.8-flash-high',
    'gemini-3.8-flash',
    'magpie/deepseek/deepseek-flash',
    'magpie/agy-cli/gemini-3.8-flash',
  ];

  for (const id of preferred) {
    if (rawIds.has(id)) {
      return { modelID: id, variant: undefined };
    }
  }

  const sessionModel = String(params.sessionModelID || '').trim();
  if (sessionModel) {
    return {
      modelID: resolveRealAgyModelId(sessionModel, 'low', { env: params.env }),
      variant: undefined,
    };
  }
  return { modelID: 'gemini-3.8-flash-low', variant: undefined };
}

/**
 * Build the one-shot prompt sent to `agy-cli` `generateText` for automatic session naming.
 * @param {{ userText: string, assistantText?: string }} params
 */
export function buildAutoTitlePrompt({ userText, assistantText = '' }) {
  const userExcerpt = String(userText || '').trim().slice(0, 1500);
  const assistantExcerpt = String(assistantText || '').trim().slice(0, 1500);
  const parts = [
    TITLE_SYSTEM_PROMPT,
    '---',
    `**User**\n${userExcerpt}`,
  ];
  if (assistantExcerpt) {
    parts.push(`**Assistant final response**\n${assistantExcerpt}`);
  }
  return parts.join('\n\n');
}
