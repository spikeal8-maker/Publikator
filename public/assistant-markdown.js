/** Small DOM-only Markdown subset for model answers. No HTML parser, images,
 * executable URLs or remote resources; unknown syntax remains visible text. */
function safeLink(document, value) {
  try {
    const url = value.startsWith('/') && !value.startsWith('//')
      ? new URL(value, document.baseURI) : new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function inline(parent, value, depth = 0) {
  const document = parent.ownerDocument;
  if (depth > 4) { parent.append(document.createTextNode(value)); return; }
  const tokens = /`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|\[[^\]\n]+\]\([^\s)]+\)|https?:\/\/[^\s<>"']+/g;
  let previous = 0, count = 0;
  for (const match of value.matchAll(tokens)) {
    if (++count > 500) break;
    parent.append(document.createTextNode(value.slice(previous, match.index)));
    const token = match[0]; let node;
    if (token.startsWith('`')) {
      node = document.createElement('code'); node.textContent = token.slice(1, -1);
    } else if (token.startsWith('**') || token.startsWith('__')) {
      node = document.createElement('strong'); inline(node, token.slice(2, -2), depth + 1);
    } else if (token.startsWith('*')) {
      node = document.createElement('em'); inline(node, token.slice(1, -1), depth + 1);
    } else {
      const link = token.match(/^\[([^\]\n]+)\]\(([^)]+)\)$/);
      const suffix = link ? '' : (token.match(/[.,!?;:)\]]+$/)?.[0] || '');
      const address = link ? link[2] : token.slice(0, token.length - suffix.length);
      const href = safeLink(document, address);
      if (href) {
        node = document.createElement('a'); node.href = href;
        node.target = '_blank'; node.rel = 'noopener noreferrer';
        node.textContent = link ? link[1] : address;
        parent.append(node, document.createTextNode(suffix)); node = null;
      } else node = document.createTextNode(token);
    }
    if (node) parent.append(node);
    previous = match.index + token.length;
  }
  parent.append(document.createTextNode(value.slice(previous)));
}
const listItem = line => line.match(/^\s*(?:([-*+])|(\d{1,6})[.)])\s+(.+)$/);
function blockStart(line) {
  return /^\s*$/.test(line) || /^```/.test(line) || /^(#{1,6})\s+/.test(line) || /^>\s?/.test(line) || Boolean(listItem(line));
}
export function renderAssistantMarkdown(target, value) {
  const document = target.ownerDocument;
  const lines = String(value ?? '').slice(0, 24000).replace(/\r\n?/g, '\n').split('\n');
  target.replaceChildren(); target.classList.add('markdown');
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^```/.test(line)) {
      const body = []; i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      if (i < lines.length) i++;
      const pre = document.createElement('pre'), code = document.createElement('code');
      pre.tabIndex = 0; code.textContent = body.join('\n'); pre.append(code); target.append(pre); continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const node = document.createElement('h' + Math.min(6, Math.max(3, heading[1].length + 1)));
      inline(node, heading[2]); target.append(node); i++; continue;
    }
    const item = listItem(line);
    if (item) {
      const ordered = Boolean(item[2]), node = document.createElement(ordered ? 'ol' : 'ul');
      if (ordered && Number(item[2]) !== 1) node.start = Number(item[2]);
      while (i < lines.length) {
        const next = listItem(lines[i]); if (!next || Boolean(next[2]) !== ordered) break;
        const li = document.createElement('li'); inline(li, next[3]); node.append(li); i++;
      }
      target.append(node); continue;
    }
    if (/^>\s?/.test(line)) {
      const parts = []; while (i < lines.length && /^>\s?/.test(lines[i])) parts.push(lines[i++].replace(/^>\s?/, ''));
      const quote = document.createElement('blockquote'); inline(quote, parts.join('\n')); target.append(quote); continue;
    }
    const parts = [line]; i++;
    while (i < lines.length && !blockStart(lines[i])) parts.push(lines[i++]);
    const p = document.createElement('p'); inline(p, parts.join('\n')); target.append(p);
  }
}
