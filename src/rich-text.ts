export const RICH_TEXT_LIMITS = {
  maxAstBytes: 2 * 1024 * 1024,
  maxTextBytes: 1024 * 1024,
  maxNodes: 10_000,
  maxDepth: 32,
  maxLinks: 1_000,
  maxLinkLength: 2_048,
  maxLinkTitleLength: 512
} as const;

export type RichTextMarkType = 'bold' | 'italic' | 'underline' | 'strike' | 'code';
export type RichTextMark = { type: RichTextMarkType };

export type RichTextTextNode = {
  type: 'text';
  text: string;
  marks: RichTextMark[];
};

export type RichTextHardBreakNode = { type: 'hard_break' };

export type RichTextLinkNode = {
  type: 'link';
  attrs: { href: string; title?: string };
  content: RichTextTextNode[];
};

export type RichTextInlineNode = RichTextTextNode | RichTextHardBreakNode | RichTextLinkNode;

export type RichTextParagraphNode = { type: 'paragraph'; content: RichTextInlineNode[] };
export type RichTextBlockquoteNode = { type: 'blockquote'; content: RichTextBlockNode[] };
export type RichTextListItemNode = { type: 'list_item'; content: RichTextBlockNode[] };
export type RichTextBulletListNode = { type: 'bullet_list'; content: RichTextListItemNode[] };
export type RichTextOrderedListNode = { type: 'ordered_list'; content: RichTextListItemNode[] };
export type RichTextCodeBlockNode = { type: 'code_block'; content: Array<RichTextTextNode | RichTextHardBreakNode> };
export type RichTextBlockNode =
  | RichTextParagraphNode
  | RichTextBlockquoteNode
  | RichTextBulletListNode
  | RichTextOrderedListNode
  | RichTextListItemNode
  | RichTextCodeBlockNode;

export type RichTextDocument = { type: 'doc'; content: Exclude<RichTextBlockNode, RichTextListItemNode>[] };

const MARK_ORDER: RichTextMarkType[] = ['bold', 'italic', 'underline', 'strike', 'code'];
const MARK_TYPES = new Set<RichTextMarkType>(MARK_ORDER);
const BLOCK_TYPES = new Set(['paragraph', 'blockquote', 'bullet_list', 'ordered_list', 'list_item', 'code_block']);
const EMPTY_DOCUMENT: RichTextDocument = { type: 'doc', content: [] };

type ValidationState = {
  nodes: number;
  textBytes: number;
  links: number;
};

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function assertKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allow.has(key) || /^on/i.test(key) || /html/i.test(key) || key === 'style' || key === 'class') {
      throw new Error(`${label} contains forbidden property: ${key}`);
    }
  }
}

function touchNode(state: ValidationState, depth: number): void {
  if (depth > RICH_TEXT_LIMITS.maxDepth) throw new Error('Rich-text AST exceeds max depth');
  state.nodes += 1;
  if (state.nodes > RICH_TEXT_LIMITS.maxNodes) throw new Error('Rich-text AST has too many nodes');
}

function safeLinkAttrs(value: unknown, state: ValidationState): { href: string; title?: string } {
  const attrs = recordOf(value, 'Rich-text link attrs');
  assertKeys(attrs, ['href', 'title'], 'Rich-text link attrs');
  if (typeof attrs.href !== 'string') throw new Error('Rich-text link requires href');
  if (attrs.href.length > RICH_TEXT_LIMITS.maxLinkLength) throw new Error('Rich-text link is too long');
  let url: URL;
  try { url = new URL(attrs.href); } catch { throw new Error('Rich-text link is invalid'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Rich-text link protocol is forbidden');
  if (url.username || url.password) throw new Error('Rich-text link credentials are forbidden');
  if (attrs.title !== undefined && typeof attrs.title !== 'string') throw new Error('Rich-text link title must be text');
  if (typeof attrs.title === 'string' && attrs.title.length > RICH_TEXT_LIMITS.maxLinkTitleLength) {
    throw new Error('Rich-text link title is too long');
  }
  state.links += 1;
  if (state.links > RICH_TEXT_LIMITS.maxLinks) throw new Error('Rich-text AST has too many links');
  return attrs.title === undefined ? { href: attrs.href } : { href: attrs.href, title: attrs.title };
}

function normalizedMarks(value: unknown): RichTextMark[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Rich-text marks must be an array');
  const found = new Set<RichTextMarkType>();
  for (const raw of value) {
    const mark = recordOf(raw, 'Rich-text mark');
    assertKeys(mark, ['type'], 'Rich-text mark');
    if (typeof mark.type !== 'string' || !MARK_TYPES.has(mark.type as RichTextMarkType)) {
      throw new Error(`Rich-text mark is forbidden: ${String(mark.type ?? 'missing')}`);
    }
    found.add(mark.type as RichTextMarkType);
  }
  return MARK_ORDER.filter((type) => found.has(type)).map((type) => ({ type }));
}

function normalizeTextNode(raw: unknown, state: ValidationState, depth: number, marksAllowed = true): RichTextTextNode {
  touchNode(state, depth);
  const node = recordOf(raw, 'Rich-text text node');
  assertKeys(node, ['type', 'text', 'marks'], 'Rich-text text node');
  if (node.type !== 'text') throw new Error('Rich-text textual content must use text nodes');
  if (typeof node.text !== 'string') throw new Error('Rich-text text node requires text');
  state.textBytes += Buffer.byteLength(node.text, 'utf8');
  if (state.textBytes > RICH_TEXT_LIMITS.maxTextBytes) throw new Error('Rich-text text exceeds size limit');
  const marks = normalizedMarks(node.marks);
  if (!marksAllowed && marks.length) throw new Error('Rich-text code block text cannot contain marks');
  return { type: 'text', text: node.text, marks };
}

function mergeTextNodes(nodes: RichTextInlineNode[]): RichTextInlineNode[] {
  const out: RichTextInlineNode[] = [];
  for (const node of nodes) {
    const previous = out.at(-1);
    if (node.type === 'text' && previous?.type === 'text'
      && JSON.stringify(previous.marks) === JSON.stringify(node.marks)) {
      previous.text += node.text;
    } else {
      out.push(node);
    }
  }
  return out.filter((node) => node.type !== 'text' || node.text.length > 0);
}

function normalizeInlineNode(raw: unknown, state: ValidationState, depth: number): RichTextInlineNode {
  const record = recordOf(raw, 'Rich-text inline node');
  const type = String(record.type ?? '');
  if (type === 'text') return normalizeTextNode(raw, state, depth, true);
  touchNode(state, depth);
  if (type === 'hard_break') {
    assertKeys(record, ['type'], 'Rich-text hard_break');
    return { type: 'hard_break' };
  }
  if (type === 'link') {
    assertKeys(record, ['type', 'attrs', 'content'], 'Rich-text link');
    const attrs = safeLinkAttrs(record.attrs, state);
    if (!Array.isArray(record.content)) throw new Error('Rich-text link content must be an array');
    const content = record.content.map((child) => normalizeTextNode(child, state, depth + 1, true));
    const merged = mergeTextNodes(content) as RichTextTextNode[];
    return { type: 'link', attrs, content: merged };
  }
  throw new Error(`Rich-text inline node type is forbidden: ${type || 'missing'}`);
}

function normalizeInlineContent(value: unknown, state: ValidationState, depth: number): RichTextInlineNode[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Rich-text inline content must be an array');
  return mergeTextNodes(value.map((child) => normalizeInlineNode(child, state, depth)));
}

function normalizeCodeContent(value: unknown, state: ValidationState, depth: number): Array<RichTextTextNode | RichTextHardBreakNode> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Rich-text code block content must be an array');
  const out: Array<RichTextTextNode | RichTextHardBreakNode> = [];
  for (const raw of value) {
    const record = recordOf(raw, 'Rich-text code block child');
    if (record.type === 'hard_break') {
      touchNode(state, depth);
      assertKeys(record, ['type'], 'Rich-text hard_break');
      out.push({ type: 'hard_break' });
      continue;
    }
    const text = normalizeTextNode(raw, state, depth, false);
    const previous = out.at(-1);
    if (previous?.type === 'text') previous.text += text.text;
    else if (text.text.length) out.push(text);
  }
  return out;
}

function normalizeBlockNode(raw: unknown, state: ValidationState, depth: number): RichTextBlockNode {
  touchNode(state, depth);
  const node = recordOf(raw, 'Rich-text block node');
  const type = String(node.type ?? '');
  if (!BLOCK_TYPES.has(type)) throw new Error(`Rich-text block node type is forbidden: ${type || 'missing'}`);

  if (type === 'paragraph') {
    assertKeys(node, ['type', 'content'], 'Rich-text paragraph');
    return { type: 'paragraph', content: normalizeInlineContent(node.content, state, depth + 1) };
  }
  if (type === 'code_block') {
    assertKeys(node, ['type', 'content'], 'Rich-text code block');
    return { type: 'code_block', content: normalizeCodeContent(node.content, state, depth + 1) };
  }
  if (type === 'bullet_list' || type === 'ordered_list') {
    assertKeys(node, ['type', 'content'], `Rich-text ${type}`);
    if (!Array.isArray(node.content)) throw new Error(`Rich-text ${type} content must be an array`);
    const content = node.content.map((child) => {
      const childRecord = recordOf(child, 'Rich-text list child');
      if (childRecord.type !== 'list_item') throw new Error('Rich-text list may contain only list_item nodes');
      return normalizeBlockNode(child, state, depth + 1) as RichTextListItemNode;
    });
    return type === 'bullet_list' ? { type: 'bullet_list', content } : { type: 'ordered_list', content };
  }
  if (type === 'list_item') {
    assertKeys(node, ['type', 'content'], 'Rich-text list_item');
    if (!Array.isArray(node.content)) throw new Error('Rich-text list_item content must be an array');
    const content = node.content.map((child) => {
      const childRecord = recordOf(child, 'Rich-text list_item child');
      if (!BLOCK_TYPES.has(String(childRecord.type ?? '')) || childRecord.type === 'list_item') {
        throw new Error('Rich-text list_item may contain block nodes but not a bare list_item');
      }
      return normalizeBlockNode(child, state, depth + 1);
    });
    return { type: 'list_item', content };
  }
  if (type === 'blockquote') {
    assertKeys(node, ['type', 'content'], 'Rich-text blockquote');
    if (!Array.isArray(node.content)) throw new Error('Rich-text blockquote content must be an array');
    const content = node.content.map((child) => {
      const childRecord = recordOf(child, 'Rich-text blockquote child');
      if (!BLOCK_TYPES.has(String(childRecord.type ?? '')) || childRecord.type === 'list_item') {
        throw new Error('Rich-text blockquote may contain block nodes');
      }
      return normalizeBlockNode(child, state, depth + 1);
    });
    return { type: 'blockquote', content };
  }
  throw new Error(`Unsupported rich-text block type: ${type}`);
}

export function normalizeRichText(value: unknown): RichTextDocument {
  let rawJson: string;
  try {
    rawJson = JSON.stringify(value);
  } catch {
    throw new Error('Rich-text AST must be JSON-serializable');
  }
  if (!rawJson || Buffer.byteLength(rawJson, 'utf8') > RICH_TEXT_LIMITS.maxAstBytes) {
    throw new Error('Rich-text AST exceeds serialized size limit');
  }

  const root = recordOf(value, 'Rich-text document');
  assertKeys(root, ['type', 'content'], 'Rich-text document');
  if (root.type !== 'doc') throw new Error('Rich-text root must be doc');
  if (!Array.isArray(root.content)) throw new Error('Rich-text doc content must be an array');

  const state: ValidationState = { nodes: 0, textBytes: 0, links: 0 };
  touchNode(state, 0);
  const content = root.content.map((child) => {
    const childRecord = recordOf(child, 'Rich-text document child');
    if (!BLOCK_TYPES.has(String(childRecord.type ?? '')) || childRecord.type === 'list_item') {
      throw new Error('Rich-text doc may contain block nodes but not a bare list_item');
    }
    return normalizeBlockNode(child, state, 1) as Exclude<RichTextBlockNode, RichTextListItemNode>;
  });
  const document: RichTextDocument = { type: 'doc', content };
  const canonicalJson = JSON.stringify(document);
  if (Buffer.byteLength(canonicalJson, 'utf8') > RICH_TEXT_LIMITS.maxAstBytes) {
    throw new Error('Rich-text AST exceeds serialized size limit');
  }
  return document;
}

export function assertSafeRichTextAst(value: unknown): void {
  normalizeRichText(value);
}

export function serializeRichText(value: unknown): string {
  return JSON.stringify(normalizeRichText(value));
}

export function parseRichTextJson(value: string): RichTextDocument {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('Rich-text JSON is invalid'); }
  return normalizeRichText(parsed);
}

export function plainTextToRichText(text: string): RichTextDocument {
  if (typeof text !== 'string') throw new Error('Plain rich-text fallback must be text');
  if (Buffer.byteLength(text, 'utf8') > RICH_TEXT_LIMITS.maxTextBytes) throw new Error('Rich-text text exceeds size limit');
  if (text.length === 0) return { type: 'doc', content: [] };
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text, marks: [] }] }] };
}

function inlinePlain(nodes: RichTextInlineNode[]): string {
  return nodes.map((node) => {
    if (node.type === 'text') return node.text;
    if (node.type === 'hard_break') return '\n';
    const label = node.content.map((item) => item.text).join('');
    return label === node.attrs.href ? node.attrs.href : `${label} (${node.attrs.href})`;
  }).join('');
}

function indentContinuation(value: string, prefix: string): string {
  const lines = value.split('\n');
  return lines.map((line, index) => index === 0 ? `${prefix}${line}` : `${' '.repeat(prefix.length)}${line}`).join('\n');
}

function blockPlain(node: RichTextBlockNode): string {
  if (node.type === 'paragraph') return inlinePlain(node.content);
  if (node.type === 'code_block') return node.content.map((item) => item.type === 'hard_break' ? '\n' : item.text).join('');
  if (node.type === 'blockquote') return node.content.map(blockPlain).join('\n\n').split('\n').map((line) => `> ${line}`).join('\n');
  if (node.type === 'list_item') return node.content.map(blockPlain).join('\n');
  if (node.type === 'bullet_list') return node.content.map((item) => indentContinuation(blockPlain(item), '• ')).join('\n');
  if (node.type === 'ordered_list') return node.content.map((item, index) => indentContinuation(blockPlain(item), `${index + 1}. `)).join('\n');
  return '';
}

export function richTextToPlain(value: unknown): string {
  const document = normalizeRichText(value);
  return document.content.map(blockPlain).join('\n\n');
}

export function canonicalPlainRichJson(text: string): string {
  return serializeRichText(plainTextToRichText(text));
}

export const EMPTY_RICH_TEXT_JSON = canonicalPlainRichJson('');
