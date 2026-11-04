/** Stateless OpenAI Responses adapter. Provider protocol state is persisted only
 * inside the already-encrypted conversation and redacted from browser/tool DTOs. */
export type OpenAiContext = { connectionId: string; revision: number; model: string };
export type OpenAiTransport = (suffix: string, body: unknown, signal?: AbortSignal) => Promise<unknown>;
type JsonObject = Record<string, any>;
const STATE_FIELD = 'openai_raw_response';
const MAX_ITEMS = 96;
const MAX_CONTEXT = 2 * 1024 * 1024;

export class OpenAiProtocolError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
function invalid(message = 'OpenAI вернул некорректный ответ.'): never {
  throw new OpenAiProtocolError('MODEL_INVALID_RESPONSE', message);
}
function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function callIdentity(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 200 || /[\u0000-\u001f]/.test(value)) invalid('Некорректный идентификатор команды OpenAI.');
  return value;
}
function toolCall(value: unknown): JsonObject {
  if (!object(value) || !/^[A-Za-z0-9_-]{1,64}$/.test(value.name || '') || typeof value.arguments !== 'string' || value.arguments.length > 65536) invalid('Некорректная команда OpenAI.');
  const callId = callIdentity(value.call_id);
  let args: unknown;
  try { args = JSON.parse(value.arguments); } catch { invalid('OpenAI вернул некорректные аргументы команды.'); }
  if (!object(args)) invalid('Аргументы команды OpenAI должны быть объектом.');
  return { id: callId, type: 'function', function: { name: value.name, arguments: value.arguments } };
}
function outputItems(value: unknown): JsonObject[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ITEMS || JSON.stringify(value).length > MAX_CONTEXT) invalid();
  for (const item of value) {
    if (!object(item) || !['message', 'reasoning', 'function_call'].includes(item.type)) invalid('OpenAI вернул неподдерживаемый тип результата.');
    if (item.type === 'function_call') toolCall(item);
    if (item.type === 'message') {
      if (item.role !== 'assistant' || !Array.isArray(item.content)) invalid();
      for (const part of item.content) {
        if (!object(part) || !['output_text', 'refusal'].includes(part.type) || typeof (part.type === 'output_text' ? part.text : part.refusal) !== 'string') invalid();
      }
    }
  }
  return value;
}

export function buildOpenAiRequest(context: OpenAiContext, messages: JsonObject[], tools: JsonObject[]): JsonObject {
  const input: JsonObject[] = [];
  for (const message of messages) {
    if (!object(message)) invalid('Повреждена история диалога.');
    const state = message[STATE_FIELD];
    if (message.role === 'assistant' && object(state) && state.protocol === 'responses-v1' && state.connectionId === context.connectionId && state.revision === context.revision && state.model === context.model) {
      input.push(...outputItems(state.items));
      continue;
    }
    if (message.role === 'tool') {
      if (typeof message.content !== 'string') invalid('Повреждён результат инструмента.');
      input.push({ type: 'function_call_output', call_id: callIdentity(message.tool_call_id), output: message.content });
      continue;
    }
    if (!['system', 'developer', 'user', 'assistant'].includes(message.role) || (message.content !== undefined && message.content !== null && typeof message.content !== 'string')) invalid('Повреждена история диалога.');
    if (message.content) input.push({ role: message.role, content: message.content });
    if (message.role === 'assistant' && message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls) || message.tool_calls.length > 12) invalid();
      for (const call of message.tool_calls) {
        if (!object(call) || !object(call.function)) invalid();
        const item = { type: 'function_call', call_id: call.id, name: call.function.name, arguments: typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments) };
        toolCall(item);
        input.push(item);
      }
    }
  }
  const mappedTools = tools.map(tool => {
    if (tool?.type !== 'function' || !object(tool.function) || !/^[A-Za-z0-9_-]{1,64}$/.test(tool.function.name || '') || !object(tool.function.parameters)) invalid('Некорректное описание инструмента.');
    return { type: 'function', name: tool.function.name, description: tool.function.description || '', parameters: tool.function.parameters, strict: false };
  });
  const body: JsonObject = { model: context.model, input, store: false, include: ['reasoning.encrypted_content'], stream: false, max_output_tokens: 4096 };
  if (mappedTools.length) { body.tools = mappedTools; body.tool_choice = 'auto'; }
  if (JSON.stringify(body).length > MAX_CONTEXT) throw new OpenAiProtocolError('MODEL_CONTEXT_TOO_LARGE', 'Контекст слишком большой. Начните новый диалог; предыдущие действия сохранены.');
  return body;
}

export function parseOpenAiResponse(context: OpenAiContext, value: unknown): JsonObject {
  if (!object(value)) invalid();
  // Never execute a partial function call, a failed/monitored response, or an
  // unsupported background result. Retrying actions implicitly is not safe.
  if (value.status !== 'completed' || value.error) {
    const code = value.status === 'incomplete' ? 'MODEL_INCOMPLETE' : 'MODEL_RESPONSE_FAILED';
    throw new OpenAiProtocolError(code, 'OpenAI не завершил ответ. Действия из этого ответа не выполнялись; проверьте журнал перед повтором.');
  }
  const items = outputItems(value.output);
  const calls = items.filter(item => item.type === 'function_call').map(toolCall);
  if (calls.length > 12 || new Set(calls.map(call => call.id)).size !== calls.length) invalid('Некорректный список команд OpenAI.');
  const text = items.filter(item => item.type === 'message').flatMap(item => item.content.map((part: JsonObject) => part.type === 'output_text' ? part.text : part.refusal)).join('\n');
  if (!calls.length && !text.trim()) invalid('OpenAI не вернул текст или команду.');
  return {
    role: 'assistant', content: text.slice(0, 24000), ...(calls.length ? { tool_calls: calls } : {}),
    // safeOutput redacts every *_raw_response field. Normalized messages sent
    // to other providers must remove this state, not disclose reasoning data.
    [STATE_FIELD]: { protocol: 'responses-v1', ...context, items }
  };
}

export async function completeOpenAi(context: OpenAiContext, messages: JsonObject[], tools: JsonObject[], transport: OpenAiTransport, signal?: AbortSignal): Promise<JsonObject> {
  return parseOpenAiResponse(context, await transport('/responses', buildOpenAiRequest(context, messages, tools), signal));
}
