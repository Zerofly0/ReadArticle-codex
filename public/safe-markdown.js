/** Small, dependency-free renderer for model prose. Raw HTML is always text. */
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character]));
const controls = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff\\]/u;
const encodedControls = /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i;

/** Return a canonical absolute HTTP(S) URL, or null. Never guess a URL. */
export function safeExternalUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 8192 || !/^https?:\/\//i.test(value)) return null;
  if (controls.test(value) || /[\s<>"]/u.test(value) || /%(?![0-9a-f]{2})/i.test(value)) return null;
  const authority = /^https?:\/\/([^/?#]*)/i.exec(value)?.[1];
  if (!authority || authority.includes('@')) return null;
  let decoded = value;
  for (let round = 0; round < 8; round++) {
    if (controls.test(decoded) || encodedControls.test(decoded)) return null;
    let next;
    try { next = decodeURIComponent(decoded); }
    catch (_) { if (round === 0) return null; break; }
    if (next === decoded) break;
    decoded = next;
    if (round === 7) return null;
  }
  try {
    const url = new URL(value);
    if (!['https:','http:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch (_) { return null; }
}

function markdownLink(input, start) {
  let cursor = start + 1;
  let nesting = 1;
  for (; cursor < input.length && cursor - start <= 2048; cursor++) {
    if (input[cursor] === '\\') { cursor++; continue; }
    if (input[cursor] === '[' && ++nesting > 16) return null;
    if (input[cursor] === ']' && --nesting === 0) break;
  }
  if (nesting !== 0 || input[cursor + 1] !== '(') return null;
  const label = input.slice(start + 1, cursor);
  cursor += 2;
  while (input[cursor] === ' ') cursor++;
  let destination = '';
  if (input[cursor] === '<') {
    const end = input.indexOf('>', cursor + 1);
    if (end < 0 || end - cursor > 8192) return null;
    destination = input.slice(cursor + 1, end);
    cursor = end + 1;
  } else {
    let parentheses = 0;
    const destinationStart = cursor;
    for (; cursor < input.length && cursor - destinationStart <= 8192; cursor++) {
      const character = input[cursor];
      if (character === '\\' && ['(',')'].includes(input[cursor + 1])) { destination += input[++cursor]; continue; }
      if (character === '(') parentheses++;
      else if (character === ')') { if (!parentheses) break; parentheses--; }
      else if (/\s/u.test(character) && !parentheses) break;
      destination += character;
    }
    if (parentheses) return null;
  }
  while (input[cursor] === ' ') cursor++;
  let title = '';
  const quote = input[cursor];
  if (quote === '"' || quote === "'" || quote === '(') {
    const closing = quote === '(' ? ')' : quote;
    let titleDepth = quote === '(' ? 1 : 0;
    const titleStart = ++cursor;
    for (; cursor < input.length && cursor - titleStart <= 2048; cursor++) {
      if (input[cursor] === '\\' && [quote,closing].includes(input[cursor + 1])) { title += input[++cursor]; continue; }
      if (quote === '(' && input[cursor] === '(') titleDepth++;
      if (input[cursor] === closing && (quote !== '(' || --titleDepth === 0)) break;
      title += input[cursor];
    }
    if (input[cursor] !== closing || cursor - titleStart > 2048 || (quote === '(' && titleDepth !== 0) || controls.test(title)) return null;
    cursor++;
    while (input[cursor] === ' ') cursor++;
  }
  if (input[cursor] !== ')' || !destination) return null;
  return { label, destination, title, end:cursor + 1 };
}

function renderInline(input, allowLinks = true, depth = 0) {
  let html = '', plain = '', cursor = 0;
  const flush = () => { html += escapeHtml(plain); plain = ''; };
  while (cursor < input.length) {
    const character = input[cursor];
    if (character === '\\' && ['(','['].includes(input[cursor + 1])) {
      const closing = input[cursor + 1] === '(' ? '\\)' : '\\]';
      const end = input.indexOf(closing, cursor + 2);
      if (end >= 0) { flush(); html += escapeHtml(input.slice(cursor, end + 2)); cursor = end + 2; continue; }
    }
    if (character === '\\' && /[\\`*\[\]()!]/.test(input[cursor + 1] || '')) { plain += input[cursor + 1]; cursor += 2; continue; }
    if (character === '`') {
      let count = 1;
      while (input[cursor + count] === '`') count++;
      const marker = '`'.repeat(count);
      let end = input.indexOf(marker, cursor + count);
      while (end >= 0 && (input[end - 1] === '`' || input[end + count] === '`')) end = input.indexOf(marker, end + count);
      if (end >= 0 || count >= 3) {
        flush();
        const content = input.slice(cursor + count, end >= 0 ? end : input.length);
        html += `<code>${escapeHtml(content)}</code>`;
        cursor = end >= 0 ? end + count : input.length;
        continue;
      }
    }
    if (input.startsWith('**', cursor) && depth < 6) {
      const end = input.indexOf('**', cursor + 2);
      if (end > cursor + 2 && !input.slice(cursor + 2, end).includes('\n')) {
        flush(); html += `<strong>${renderInline(input.slice(cursor + 2, end), allowLinks, depth + 1)}</strong>`; cursor = end + 2; continue;
      }
    }
    // Markdown images remain text: this renderer never creates remote media.
    if (character === '!' && input[cursor + 1] === '[') {
      const image = markdownLink(input, cursor + 1);
      if (image) { plain += input.slice(cursor, image.end); cursor = image.end; continue; }
    }
    if (character === '[' && allowLinks && depth < 6) {
      const link = markdownLink(input, cursor);
      if (link) {
        const href = safeExternalUrl(link.destination);
        flush();
        html += href ? `<a class="external-source-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"${link.title ? ` title="${escapeHtml(link.title)}"` : ''}>${renderInline(link.label, false, depth + 1)}</a>` : escapeHtml(input.slice(cursor, link.end));
        cursor = link.end;
        continue;
      }
    }
    plain += character;
    cursor++;
  }
  flush();
  return html;
}

/** Preserve text/newlines/math tokens, with only code, bold, and safe links. */
export function renderSafeMarkdown(value) { return renderInline(String(value ?? '')); }
