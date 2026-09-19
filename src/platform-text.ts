import type { Platform } from './db.js';
import {
  normalizeRichText,
  parseRichTextJson,
  plainTextToRichText,
  richTextToPlain,
  type RichTextBlockNode,
  type RichTextDocument,
  type RichTextInlineNode,
  type RichTextMarkType,
  type RichTextTextNode
} from './rich-text.js';

export type PlatformTextContext = 'text' | 'media_caption' | 'story_caption';
export type PlatformTextDiagnosticSeverity = 'info' | 'warning' | 'error';

export type PlatformTextDiagnostic = {
  severity: PlatformTextDiagnosticSeverity;
  code: string;
  message: string;
  nodeType?: string;
  markType?: string;
};

export type TelegramTextEntity = {
  type: 'bold' | 'italic' | 'underline' | 'strikethrough' | 'code' | 'pre' | 'text_link' | 'blockquote';
  offset: number;
  length: number;
  url?: string;
};

export type PlatformTextTransport =
  | { kind: 'telegram_entities'; text: string; entities: TelegramTextEntity[] }
  | { kind: 'max_html'; text: string; format: 'html' }
  | { kind: 'plain'; text: string };

export type PlatformTextCompilation = {
  platform: Platform;
  context: PlatformTextContext;
  plainText: string;
  transport: PlatformTextTransport;
  diagnostics: PlatformTextDiagnostic[];
};

export type TargetTextSource = 'platform_override' | 'legacy_override' | 'legacy_rendition_plain' | 'base';

export type TargetTextResolution = {
  source: TargetTextSource;
  document: RichTextDocument;
  plainText: string;
  diagnostics: PlatformTextDiagnostic[];
};

export type TargetTextResolutionInput = {
  baseRichJson: string;
  basePlain: string;
  renditionRichJson?: string | null;
  renditionPlain?: string | null;
  legacyOverride?: string | null;
};

const MARK_DIAGNOSTIC_CODE: Record<RichTextMarkType, string> = {
  bold: 'RICH_BOLD_DOWNGRADED',
  italic: 'RICH_ITALIC_DOWNGRADED',
  underline: 'RICH_UNDERLINE_DOWNGRADED',
  strike: 'RICH_STRIKE_DOWNGRADED',
  code: 'RICH_INLINE_CODE_DOWNGRADED'
};

function addDiagnostic(
  diagnostics: PlatformTextDiagnostic[],
  diagnostic: PlatformTextDiagnostic
): void {
  const key = `${diagnostic.severity}\u0000${diagnostic.code}\u0000${diagnostic.nodeType ?? ''}\u0000${diagnostic.markType ?? ''}`;
  if (diagnostics.some((item) =>
    `${item.severity}\u0000${item.code}\u0000${item.nodeType ?? ''}\u0000${item.markType ?? ''}` === key
  )) return;
  diagnostics.push(diagnostic);
}

function normalizedDocument(document: RichTextDocument): RichTextDocument {
  return normalizeRichText(document);
}

export function resolveTargetRichText(input: TargetTextResolutionInput): TargetTextResolution {
  const diagnostics: PlatformTextDiagnostic[] = [];

  if (input.renditionRichJson) {
    const document = parseRichTextJson(input.renditionRichJson);
    const plainText = richTextToPlain(document);
    if (input.renditionPlain != null && input.renditionPlain !== plainText) {
      addDiagnostic(diagnostics, {
        severity: 'error',
        code: 'RICH_TEXT_PLAIN_MISMATCH',
        message: 'TargetRendition text_plain не соответствует authoritative text_rich_json.'
      });
    }
    return { source: 'platform_override', document, plainText, diagnostics };
  }

  if (input.legacyOverride != null && input.legacyOverride !== '') {
    const document = plainTextToRichText(input.legacyOverride);
    return {
      source: 'legacy_override',
      document,
      plainText: input.legacyOverride,
      diagnostics
    };
  }

  if (input.renditionPlain != null && input.renditionPlain !== '') {
    addDiagnostic(diagnostics, {
      severity: 'info',
      code: 'RICH_LEGACY_RENDITION_PLAIN',
      message: 'Исторический TargetRendition содержит только plain text; он преобразован в literal canonical AST.'
    });
    const document = plainTextToRichText(input.renditionPlain);
    return {
      source: 'legacy_rendition_plain',
      document,
      plainText: input.renditionPlain,
      diagnostics
    };
  }

  const document = parseRichTextJson(input.baseRichJson);
  const plainText = richTextToPlain(document);
  if (plainText !== input.basePlain) {
    addDiagnostic(diagnostics, {
      severity: 'error',
      code: 'RICH_BASE_PLAIN_MISMATCH',
      message: 'Base revision body не соответствует authoritative body_rich_json.'
    });
  }
  return { source: 'base', document, plainText, diagnostics };
}

function utf16Units(value: string): number {
  let units = 0;
  for (const char of value) units += char.length;
  return units;
}

function richFeatures(document: RichTextDocument): {
  marks: Set<RichTextMarkType>;
  links: boolean;
  quote: boolean;
  bulletList: boolean;
  orderedList: boolean;
  codeBlock: boolean;
} {
  const marks = new Set<RichTextMarkType>();
  let links = false;
  let quote = false;
  let bulletList = false;
  let orderedList = false;
  let codeBlock = false;

  const visitInline = (node: RichTextInlineNode): void => {
    if (node.type === 'text') for (const mark of node.marks) marks.add(mark.type);
    if (node.type === 'link') {
      links = true;
      for (const child of node.content) visitInline(child);
    }
  };
  const visitBlock = (node: RichTextBlockNode): void => {
    if (node.type === 'paragraph') node.content.forEach(visitInline);
    else if (node.type === 'code_block') codeBlock = true;
    else if (node.type === 'blockquote') {
      quote = true;
      node.content.forEach(visitBlock);
    } else if (node.type === 'bullet_list') {
      bulletList = true;
      node.content.forEach(visitBlock);
    } else if (node.type === 'ordered_list') {
      orderedList = true;
      node.content.forEach(visitBlock);
    } else if (node.type === 'list_item') {
      node.content.forEach(visitBlock);
    }
  };
  document.content.forEach(visitBlock);
  return { marks, links, quote, bulletList, orderedList, codeBlock };
}

type TelegramBuilder = {
  text: string;
  utf16Offset: number;
  entities: TelegramTextEntity[];
  diagnostics: PlatformTextDiagnostic[];
};

function telegramAppend(builder: TelegramBuilder, text: string): void {
  builder.text += text;
  builder.utf16Offset += utf16Units(text);
}

function telegramEntity(
  builder: TelegramBuilder,
  entity: TelegramTextEntity
): void {
  if (entity.length <= 0) return;
  const key = `${entity.type}:${entity.offset}:${entity.length}:${entity.url ?? ''}`;
  if (builder.entities.some((item) =>
    `${item.type}:${item.offset}:${item.length}:${item.url ?? ''}` === key
  )) return;
  builder.entities.push(entity);
}

function telegramTextNode(builder: TelegramBuilder, node: RichTextTextNode): void {
  const start = builder.utf16Offset;
  telegramAppend(builder, node.text);
  const length = builder.utf16Offset - start;
  const markTypes = node.marks.map((mark) => mark.type);
  const code = markTypes.includes('code');
  const active = code ? ['code' as const] : markTypes;

  if (code && markTypes.length > 1) {
    addDiagnostic(builder.diagnostics, {
      severity: 'warning',
      code: 'RICH_TELEGRAM_CODE_OVERLAP_DOWNGRADED',
      message: 'Telegram не получает overlapping presentation marks внутри inline code; сохранён только code.',
      nodeType: 'text',
      markType: 'code'
    });
  }

  for (const mark of active) {
    const type: TelegramTextEntity['type'] =
      mark === 'bold' ? 'bold'
        : mark === 'italic' ? 'italic'
          : mark === 'underline' ? 'underline'
            : mark === 'strike' ? 'strikethrough'
              : 'code';
    telegramEntity(builder, { type, offset: start, length });
  }
}

function telegramInline(builder: TelegramBuilder, node: RichTextInlineNode): void {
  if (node.type === 'text') {
    telegramTextNode(builder, node);
    return;
  }
  if (node.type === 'hard_break') {
    telegramAppend(builder, '\n');
    return;
  }

  const hasCode = node.content.some((child) => child.marks.some((mark) => mark.type === 'code'));
  const start = builder.utf16Offset;
  for (const child of node.content) telegramTextNode(builder, child);
  const length = builder.utf16Offset - start;
  if (hasCode) {
    telegramAppend(builder, node.content.map((child) => child.text).join('') === node.attrs.href ? '' : ` (${node.attrs.href})`);
    addDiagnostic(builder.diagnostics, {
      severity: 'warning',
      code: 'RICH_TELEGRAM_LINK_CODE_OVERLAP_DOWNGRADED',
      message: 'Telegram link поверх inline code преобразован в читаемый URL, чтобы не создавать недопустимое overlap.',
      nodeType: 'link'
    });
  } else {
    telegramEntity(builder, { type: 'text_link', offset: start, length, url: node.attrs.href });
  }
}

function telegramParagraph(builder: TelegramBuilder, node: Extract<RichTextBlockNode, { type: 'paragraph' }>): void {
  node.content.forEach((child) => telegramInline(builder, child));
}

function telegramListItem(builder: TelegramBuilder, node: Extract<RichTextBlockNode, { type: 'list_item' }>): void {
  node.content.forEach((child, index) => {
    if (index > 0) telegramAppend(builder, '\n');
    telegramBlock(builder, child);
  });
}

function telegramBlock(builder: TelegramBuilder, node: RichTextBlockNode): void {
  if (node.type === 'paragraph') {
    telegramParagraph(builder, node);
    return;
  }
  if (node.type === 'code_block') {
    const start = builder.utf16Offset;
    for (const child of node.content) {
      if (child.type === 'hard_break') telegramAppend(builder, '\n');
      else telegramAppend(builder, child.text);
    }
    telegramEntity(builder, { type: 'pre', offset: start, length: builder.utf16Offset - start });
    return;
  }
  if (node.type === 'blockquote') {
    const start = builder.utf16Offset;
    node.content.forEach((child, index) => {
      if (index > 0) telegramAppend(builder, '\n\n');
      telegramBlock(builder, child);
    });
    telegramEntity(builder, { type: 'blockquote', offset: start, length: builder.utf16Offset - start });
    return;
  }
  if (node.type === 'bullet_list' || node.type === 'ordered_list') {
    addDiagnostic(builder.diagnostics, {
      severity: 'info',
      code: node.type === 'bullet_list' ? 'RICH_BULLET_LIST_TRANSFORMED' : 'RICH_ORDERED_LIST_TRANSFORMED',
      message: node.type === 'bullet_list'
        ? 'Маркированный список преобразован в текстовые bullet-prefixes с сохранением допустимого inline formatting.'
        : 'Нумерованный список преобразован в текстовые numeric-prefixes с сохранением допустимого inline formatting.',
      nodeType: node.type
    });
    node.content.forEach((item, index) => {
      if (index > 0) telegramAppend(builder, '\n');
      telegramAppend(builder, node.type === 'bullet_list' ? '• ' : `${index + 1}. `);
      telegramListItem(builder, item);
    });
    return;
  }
  if (node.type === 'list_item') telegramListItem(builder, node);
}

function compileTelegram(document: RichTextDocument, context: PlatformTextContext): PlatformTextCompilation {
  const canonical = normalizedDocument(document);
  const diagnostics: PlatformTextDiagnostic[] = [];
  const plainText = richTextToPlain(canonical);

  if (context === 'story_caption') {
    const features = richFeatures(canonical);
    if (features.marks.size || features.links || features.quote || features.codeBlock) {
      addDiagnostic(diagnostics, {
        severity: 'warning',
        code: 'RICH_TELEGRAM_STORY_FORMATTING_DOWNGRADED',
        message: 'Текущий Publikator Story transport отправляет caption как plain text; presentation formatting упрощено.'
      });
    }
    if (features.bulletList) addDiagnostic(diagnostics, {
      severity: 'info',
      code: 'RICH_BULLET_LIST_TRANSFORMED',
      message: 'Маркированный список сохранён текстовыми bullet-prefixes.'
    });
    if (features.orderedList) addDiagnostic(diagnostics, {
      severity: 'info',
      code: 'RICH_ORDERED_LIST_TRANSFORMED',
      message: 'Нумерованный список сохранён текстовыми numeric-prefixes.'
    });
    return { platform: 'telegram', context, plainText, transport: { kind: 'plain', text: plainText }, diagnostics };
  }

  const builder: TelegramBuilder = { text: '', utf16Offset: 0, entities: [], diagnostics };
  canonical.content.forEach((block, index) => {
    if (index > 0) telegramAppend(builder, '\n\n');
    telegramBlock(builder, block);
  });
  builder.entities.sort((a, b) =>
    a.offset - b.offset || b.length - a.length || a.type.localeCompare(b.type) || String(a.url ?? '').localeCompare(String(b.url ?? ''))
  );
  return {
    platform: 'telegram',
    context,
    plainText,
    transport: { kind: 'telegram_entities', text: builder.text, entities: builder.entities },
    diagnostics
  };
}

function escapeHtmlText(value: string): string {
  return value.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]!));
}

function escapeHtmlAttr(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]!));
}

function maxTextNode(node: RichTextTextNode, diagnostics: PlatformTextDiagnostic[]): string {
  let value = escapeHtmlText(node.text);
  const marks = node.marks.map((mark) => mark.type);
  if (marks.includes('code')) {
    if (marks.length > 1) {
      addDiagnostic(diagnostics, {
        severity: 'warning',
        code: 'RICH_MAX_CODE_OVERLAP_DOWNGRADED',
        message: 'MAX inline code сохранён без дополнительных presentation marks.',
        nodeType: 'text',
        markType: 'code'
      });
    }
    return `<code>${value}</code>`;
  }
  const tags: Record<Exclude<RichTextMarkType, 'code'>, string> = {
    bold: 'strong',
    italic: 'em',
    underline: 'u',
    strike: 's'
  };
  for (const mark of [...marks].reverse()) {
    if (mark === 'code') continue;
    const tag = tags[mark];
    value = `<${tag}>${value}</${tag}>`;
  }
  return value;
}

function maxInline(node: RichTextInlineNode, diagnostics: PlatformTextDiagnostic[]): string {
  if (node.type === 'text') return maxTextNode(node, diagnostics);
  if (node.type === 'hard_break') return '<br>';
  const content = node.content.map((child) => maxTextNode(child, diagnostics)).join('');
  return `<a href="${escapeHtmlAttr(node.attrs.href)}">${content}</a>`;
}

function maxListItem(node: Extract<RichTextBlockNode, { type: 'list_item' }>, diagnostics: PlatformTextDiagnostic[]): string {
  return node.content.map((child) => maxBlock(child, diagnostics)).join('<br>');
}

function maxBlock(node: RichTextBlockNode, diagnostics: PlatformTextDiagnostic[]): string {
  if (node.type === 'paragraph') return node.content.map((child) => maxInline(child, diagnostics)).join('');
  if (node.type === 'code_block') {
    const value = node.content.map((child) => child.type === 'hard_break' ? '\n' : child.text).join('');
    return `<pre>${escapeHtmlText(value)}</pre>`;
  }
  if (node.type === 'blockquote') {
    return `<blockquote>${node.content.map((child) => maxBlock(child, diagnostics)).join('<br><br>')}</blockquote>`;
  }
  if (node.type === 'bullet_list' || node.type === 'ordered_list') {
    addDiagnostic(diagnostics, {
      severity: 'info',
      code: node.type === 'bullet_list' ? 'RICH_BULLET_LIST_TRANSFORMED' : 'RICH_ORDERED_LIST_TRANSFORMED',
      message: node.type === 'bullet_list'
        ? 'MAX не получает native list markup: список преобразован в текстовые bullet-prefixes.'
        : 'MAX не получает native list markup: список преобразован в текстовые numeric-prefixes.',
      nodeType: node.type
    });
    return node.content.map((item, index) =>
      `${node.type === 'bullet_list' ? '• ' : `${index + 1}. `}${maxListItem(item, diagnostics)}`
    ).join('<br>');
  }
  if (node.type === 'list_item') return maxListItem(node, diagnostics);
  return '';
}

function compileMax(document: RichTextDocument, context: PlatformTextContext): PlatformTextCompilation {
  const canonical = normalizedDocument(document);
  const diagnostics: PlatformTextDiagnostic[] = [];
  const plainText = richTextToPlain(canonical);
  const text = canonical.content.map((block) => maxBlock(block, diagnostics)).join('<br><br>');
  return { platform: 'max', context, plainText, transport: { kind: 'max_html', text, format: 'html' }, diagnostics };
}

function addPlainDowngradeDiagnostics(
  platform: 'vk' | 'instagram',
  document: RichTextDocument,
  diagnostics: PlatformTextDiagnostic[]
): void {
  const features = richFeatures(document);
  for (const mark of [...features.marks].sort()) {
    addDiagnostic(diagnostics, {
      severity: 'warning',
      code: MARK_DIAGNOSTIC_CODE[mark],
      message: `${platform === 'vk' ? 'VK' : 'Instagram'} публикует этот mark как plain text; оформление упрощено.`,
      markType: mark
    });
  }
  if (features.links) addDiagnostic(diagnostics, {
    severity: 'info',
    code: 'RICH_LINK_TRANSFORMED',
    message: 'Ссылка преобразована в читаемый plain text с URL.',
    nodeType: 'link'
  });
  if (features.quote) addDiagnostic(diagnostics, {
    severity: 'info',
    code: 'RICH_BLOCKQUOTE_TRANSFORMED',
    message: 'Цитата преобразована в plain lines с префиксом >.',
    nodeType: 'blockquote'
  });
  if (features.bulletList) addDiagnostic(diagnostics, {
    severity: 'info',
    code: 'RICH_BULLET_LIST_TRANSFORMED',
    message: 'Маркированный список преобразован в textual bullet-prefixes.',
    nodeType: 'bullet_list'
  });
  if (features.orderedList) addDiagnostic(diagnostics, {
    severity: 'info',
    code: 'RICH_ORDERED_LIST_TRANSFORMED',
    message: 'Нумерованный список преобразован в textual numeric-prefixes.',
    nodeType: 'ordered_list'
  });
  if (features.codeBlock) addDiagnostic(diagnostics, {
    severity: 'info',
    code: 'RICH_CODE_BLOCK_TRANSFORMED',
    message: 'Блок кода сохраняет текст и переносы строк без rich presentation.',
    nodeType: 'code_block'
  });
}

function compilePlainPlatform(
  platform: 'vk' | 'instagram',
  document: RichTextDocument,
  context: PlatformTextContext
): PlatformTextCompilation {
  const canonical = normalizedDocument(document);
  const diagnostics: PlatformTextDiagnostic[] = [];
  const plainText = richTextToPlain(canonical);
  addPlainDowngradeDiagnostics(platform, canonical, diagnostics);
  return { platform, context, plainText, transport: { kind: 'plain', text: plainText }, diagnostics };
}

export function compilePlatformText(
  platform: Platform,
  document: RichTextDocument,
  context: PlatformTextContext
): PlatformTextCompilation {
  if (platform === 'telegram') return compileTelegram(document, context);
  if (platform === 'max') return compileMax(document, context);
  if (platform === 'vk') return compilePlainPlatform('vk', document, context);
  return compilePlainPlatform('instagram', document, context);
}

export function compileLiteralPlainText(
  platform: Platform,
  text: string,
  context: PlatformTextContext
): PlatformTextCompilation {
  return compilePlatformText(platform, plainTextToRichText(text), context);
}
