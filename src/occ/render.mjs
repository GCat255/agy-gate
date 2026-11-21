import process from 'node:process';

export const COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
export const ALT_SCREEN = Boolean(process.stdout.isTTY);
export const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export const style = {
  dim: (s) => (COLOR ? `\x1b[2m${s}\x1b[22m` : s),
  bar: (s) => (COLOR ? `\x1b[7m${s}\x1b[27m` : s),
  ok: (s) => (COLOR ? `\x1b[32m${s}\x1b[39m` : s),
  warn: (s) => (COLOR ? `\x1b[33m${s}\x1b[39m` : s),
  err: (s) => (COLOR ? `\x1b[31m${s}\x1b[39m` : s),
  accent: (s) => (COLOR ? `\x1b[36m${s}\x1b[39m` : s),
};

export function charWidth(cp) {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f)
    || (cp >= 0x2e80 && cp <= 0xa4cf)
    || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe30 && cp <= 0xfe6f)
    || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x1f300 && cp <= 0x1f64f)
    || (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function width(text) {
  let w = 0;
  for (const ch of String(text)) w += charWidth(ch.codePointAt(0));
  return w;
}

export function columns() {
  return Math.max(30, process.stdout.columns || 80);
}

export function height() {
  return Math.max(6, process.stdout.rows || 24);
}

export function windowFor(total, index, budget) {
  if (total <= budget) return { start: 0, end: total };
  const start = Math.max(0, Math.min(index - Math.floor(budget / 2), total - budget));
  return { start, end: start + budget };
}

export function divider(cols) {
  return style.dim('  ' + '─'.repeat(Math.max(10, cols - 4)));
}

export function truncate(text, max) {
  if (width(text) <= max) return text;
  const limit = Math.max(1, max - 1);
  let out = '';
  let w = 0;
  for (const ch of String(text)) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > limit) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

export function line(left, right, cols) {
  const lw = width(left);
  if (!right) return left;
  if (lw + 4 >= cols) return truncate(left, cols - 1);
  const available = cols - lw - 2;
  const r = width(right) > available ? truncate(right, available) : right;
  const gap = Math.max(1, cols - lw - width(r) - 1);
  return left + ' '.repeat(gap) + r;
}

/**
 * Draw current `occ` TUI screen into terminal stdout.
 * @param {any} state
 * @param {Array<{ id: string, label: string, right: string, enabled: boolean }>} rowsMenu
 * @param {string} spinLabel
 * @param {number} spinFrame
 * @param {number} spinStartedAt
 */
export function drawScreen(state, rowsMenu, { spinLabel, spinFrame, spinStartedAt }) {
  const cols = columns();
  const rows = height();
  const rowWidth = cols - 1;
  const compact = cols < 52;
  const tight = rows < 12;
  const out = [];

  const versions = compact
    ? ''
    : style.dim(`opencode ${state.ocLocal ?? '?'} · agy ${state.agyLocal ?? '?'} · openchamber ${state.obLocal ?? '?'}`);
  out.push(line('  OpenChamber', versions, cols));
  if (!tight) out.push(divider(cols));

  const paintRow = (marker, label, right, enabled, selected) => {
    let text = line(`  ${marker} ${label}`, right, cols);
    const pad = rowWidth - width(text);
    if (pad > 0) text += ' '.repeat(pad);
    if (!enabled) text = style.dim(text);
    if (selected) text = style.bar(text);
    return text;
  };

  const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
  const fit = (s, max) => (width(plain(s)) > max ? truncate(plain(s), max) : s);

  const unknownLine = !state.pick && state.state === 'unknown'
    ? style.err(truncate(`   服务状态未知：${state.statusError ?? ''}`, cols - 1))
    : null;

  let statusLine = null;
  if (spinLabel) {
    const secs = Math.floor((Date.now() - spinStartedAt) / 1000);
    statusLine = '  ' + style.accent(truncate(`${SPIN[spinFrame]} ${spinLabel}${secs >= 1 ? ` ${secs}s` : ''}`, cols - 4));
  } else if (state.message) {
    statusLine = '  ' + fit(state.message, cols - 4);
  }

  const fixed =
    1
    + (tight ? 0 : 2)
    + (tight ? 0 : 1)
    + (state.pick ? 1 : 0)
    + (statusLine ? 1 : 0)
    + (unknownLine ? 1 : 0);
  const budget = Math.max(1, rows - fixed);

  const items = state.pick ? state.pick.items : rowsMenu;
  const index = state.pick ? state.pick.index : state.selected;

  if (!state.pick && (!items[state.selected] || !items[state.selected].enabled)) {
    const firstEnabled = items.findIndex((r) => r.enabled);
    if (firstEnabled >= 0) state.selected = firstEnabled;
  }

  const activeIndex = state.pick ? index : state.selected;
  const win = windowFor(items.length, activeIndex, budget);
  const range = items.length > budget ? `　${win.start + 1}-${win.end}/${items.length}` : '';

  if (state.pick) {
    out.push('  ' + style.accent(truncate(`${state.pick.title}${range}`, cols - 4)));
    for (let i = win.start; i < win.end; i++) {
      const it = items[i];
      out.push(paintRow(i === activeIndex ? '›' : ' ', it.label, it.right ?? '', true, i === activeIndex));
    }
    if (!tight) {
      out.push(divider(cols));
      out.push(style.dim(compact ? '  ↑↓ Enter  Esc 返回' : '  ↑↓ 选择   Enter 确认   Esc 返回'));
    }
  } else {
    if (unknownLine) out.push(unknownLine);
    for (let i = win.start; i < win.end; i++) {
      const r = items[i];
      out.push(paintRow(i === activeIndex ? '›' : ' ', r.label, r.right, r.enabled, i === activeIndex));
    }
    if (!tight) {
      out.push(divider(cols));
      out.push(style.dim(compact ? '  ↑↓ Enter  q 退出' : '  ↑↓ 选择   Enter 执行   q 退出'));
    }
  }

  if (statusLine) out.push(statusLine);

  let chunk = '';
  if (ALT_SCREEN) {
    chunk = '\x1b[H' + out.join('\n') + '\x1b[J';
  } else {
    if (state.renderedLines > 0) chunk += `\x1b[${state.renderedLines}A\x1b[0J`;
    chunk += out.join('\n') + '\n';
    state.renderedLines = out.length;
  }
  process.stdout.write(chunk);
}
