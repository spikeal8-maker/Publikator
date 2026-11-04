import dns from 'node:dns/promises';
import net from 'node:net';
import { Agent, request } from 'undici';
import { db, id, nowIso } from './db.js';
import { encryptJson, decryptJson } from './crypto.js';
import { OwnerAutomationError, boundedString, objectValue } from './owner-automation.js';

export type AiConnection = { id: string; owner_id: string; name: string; provider: 'openai'|'deepseek'|'compatible'|'ollama'; base_url: string; model: string; credentials_encrypted: string; revision: number; enabled: number; tool_verified: number };
const DEFAULT_URLS: Record<string,string> = { openai: 'https://api.openai.com/v1', deepseek: 'https://api.deepseek.com', ollama: 'http://host.docker.internal:11434' };
function addressForbidden(address: string, localAllowed: boolean): boolean {
  const a = address.toLowerCase().replace(/^::ffff:/, '');
  if (a === '0.0.0.0' || a === '::' || /^169\.254\./.test(a) || /^fe[89ab]/.test(a)) return true;
  if (localAllowed) return false;
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.|224\.|255\.)/.test(a)
    || a === '::1' || /^f[cd]/.test(a) || !net.isIP(a);
}
function normalizedEndpoint(provider: string, input: unknown): string {
  const value = typeof input === 'string' && input.trim() ? input.trim() : DEFAULT_URLS[provider];
  if (!value) throw new OwnerAutomationError('INVALID_ENDPOINT', 'Укажите адрес API.');
  let url: URL;
  try { url = new URL(value); } catch { throw new OwnerAutomationError('INVALID_ENDPOINT', 'Некорректный адрес API.'); }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new OwnerAutomationError('INVALID_ENDPOINT', 'Адрес API не должен содержать пароль или параметры.');
  if (provider === 'openai' && (url.origin !== 'https://api.openai.com' || !['/v1','/v1/'].includes(url.pathname))) throw new OwnerAutomationError('INVALID_ENDPOINT', 'OpenAI использует https://api.openai.com/v1.');
  if (provider === 'deepseek' && (url.origin !== 'https://api.deepseek.com' || !['/','/v1','/v1/'].includes(url.pathname))) throw new OwnerAutomationError('INVALID_ENDPOINT', 'DeepSeek использует https://api.deepseek.com.');
  if (provider !== 'ollama' && url.protocol !== 'https:') throw new OwnerAutomationError('INVALID_ENDPOINT', 'Для облачного провайдера требуется HTTPS.');
  if (provider === 'ollama' && !['/','/api','/api/'].includes(url.pathname)) throw new OwnerAutomationError('INVALID_ENDPOINT', 'Для Ollama укажите адрес сервера без /v1.');
  return provider === 'ollama' ? url.origin : url.toString().replace(/\/$/, '');
}
export function connectionView(c: AiConnection): any {
  let hasKey = false;
  try { hasKey = Boolean(decryptJson<any>(c.credentials_encrypted).apiKey); } catch { /* invalid key stays unavailable */ }
  return { id:c.id, name:c.name, provider:c.provider, baseUrl:c.base_url, model:c.model, revision:c.revision, enabled:Boolean(c.enabled), toolVerified:Boolean(c.tool_verified), hasKey };
}
export function listAiConnections(ownerId: string): any[] {
  return (db.prepare('SELECT * FROM owner_ai_connections WHERE owner_id=? ORDER BY name,id').all(ownerId) as AiConnection[]).map(connectionView);
}
export function getAiConnection(ownerId: string, connectionId: string): AiConnection {
  const c = db.prepare('SELECT * FROM owner_ai_connections WHERE owner_id=? AND id=? AND enabled=1').get(ownerId, connectionId) as AiConnection|undefined;
  if (!c) throw new OwnerAutomationError('CONNECTION_NOT_FOUND', 'Подключение модели не найдено или выключено.', 404);
  return c;
}
export function saveAiConnection(ownerId: string, value: unknown): any {
  const b = objectValue(value);
  if (!['openai','deepseek','compatible','ollama'].includes(b.provider)) throw new OwnerAutomationError('INVALID_PROVIDER', 'Выберите провайдера модели.');
  const name = boundedString(b.name, 'name', 120), model = boundedString(b.model, 'model', 160);
  const baseUrl = normalizedEndpoint(b.provider, b.baseUrl);
  const old = typeof b.id === 'string' ? db.prepare('SELECT * FROM owner_ai_connections WHERE id=? AND owner_id=?').get(b.id, ownerId) as AiConnection|undefined : undefined;
  if (b.id && !old) throw new OwnerAutomationError('NOT_FOUND', 'Подключение не найдено.', 404);
  if (old && b.expectedRevision !== old.revision) throw new OwnerAutomationError('VERSION_CONFLICT', 'Настройки изменены. Обновите страницу.', 409);
  let apiKey = typeof b.apiKey === 'string' ? b.apiKey.trim() : '';
  if (!apiKey && old && old.provider === b.provider && old.base_url === baseUrl) apiKey = decryptJson<any>(old.credentials_encrypted).apiKey || '';
  if (b.clearKey === true) apiKey = '';
  if (b.provider !== 'ollama' && !apiKey) throw new OwnerAutomationError('KEY_REQUIRED', 'Введите API-ключ. При изменении адреса старый ключ не переносится.');
  if (apiKey.length > 8192 || /[\r\n\u0000]/.test(apiKey)) throw new OwnerAutomationError('INVALID_KEY', 'Некорректный API-ключ.');
  const connectionId = old?.id || id('aic'), now = nowIso();
  const credentials = encryptJson({ apiKey });
  if (old) {
    const r = db.prepare(`UPDATE owner_ai_connections SET name=?,provider=?,base_url=?,model=?,credentials_encrypted=?,revision=revision+1,tool_verified=0,enabled=?,updated_at=? WHERE id=? AND owner_id=? AND revision=?`)
      .run(name,b.provider,baseUrl,model,credentials,b.enabled === false ? 0 : 1,now,connectionId,ownerId,old.revision);
    if (!r.changes) throw new OwnerAutomationError('VERSION_CONFLICT', 'Настройки изменены.', 409);
  } else db.prepare(`INSERT INTO owner_ai_connections(id,owner_id,name,provider,base_url,model,credentials_encrypted,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(connectionId,ownerId,name,b.provider,baseUrl,model,credentials,now,now);
  return connectionView(db.prepare('SELECT * FROM owner_ai_connections WHERE id=?').get(connectionId) as AiConnection);
}
export async function aiRequest(connection: AiConnection, suffix: string, body?: unknown, signal?: AbortSignal): Promise<any> {
  const url = new URL(connection.base_url + suffix);
  const local = connection.provider === 'ollama';
  const host = url.hostname.replace(/^\[|\]$/g,'');
  const addresses = net.isIP(host) ? [{ address:host, family:net.isIP(host) }] : await dns.lookup(host,{all:true});
  if (!addresses.length || addresses.some(a => addressForbidden(a.address, local))) throw new OwnerAutomationError('ENDPOINT_BLOCKED', 'Адрес провайдера недопустим. Метаданные облака и непредусмотренные внутренние адреса запрещены.');
  const pinned = addresses[0]!;
  const dispatcher = new Agent({ connect: { lookup: ((_hostname: string, options: any, callback: any) => options?.all ? callback(null, [{address:pinned.address,family:pinned.family}]) : callback(null, pinned.address, pinned.family)) as any } });
  const key = decryptJson<any>(connection.credentials_encrypted).apiKey;
  const abort = signal ? AbortSignal.any([signal,AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000);
  try {
    const response = await request(url, { dispatcher, method: body === undefined ? 'GET' : 'POST', maxRedirections:0,
      headers: { accept:'application/json', ...(body === undefined ? {} : {'content-type':'application/json'}), ...(key ? { authorization:'Bearer '+key } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: abort, headersTimeout:90000, bodyTimeout:90000 });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      await response.body.dump();
      throw new OwnerAutomationError('MODEL_HTTP_ERROR', `Провайдер вернул HTTP ${response.statusCode}. Проверьте ключ, модель, баланс и поддержку инструментов.`, 502);
    }
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of response.body) {
      const b = Buffer.from(chunk); bytes += b.length;
      if (bytes > 2*1024*1024) { response.body.destroy(); throw new OwnerAutomationError('MODEL_RESPONSE_TOO_LARGE','Ответ модели слишком большой.',502); }
      chunks.push(b);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new OwnerAutomationError('MODEL_INVALID_JSON','Провайдер вернул не JSON.',502); }
  } catch (error) {
    if (error instanceof OwnerAutomationError) throw error;
    if (signal?.aborted) throw new OwnerAutomationError('CANCELLED','Запрос остановлен.',409);
    throw new OwnerAutomationError('MODEL_UNAVAILABLE','Модель не ответила. Проверьте адрес и доступность сервера.',502);
  } finally { await dispatcher.close(); }
}
export async function listAiModels(connection: AiConnection): Promise<string[]> {
  const r = await aiRequest(connection, connection.provider === 'ollama' ? '/api/tags' : '/models');
  const rows = connection.provider === 'ollama' ? r.models : r.data;
  if (!Array.isArray(rows)) throw new OwnerAutomationError('MODEL_INVALID_RESPONSE','Провайдер не вернул список моделей.',502);
  return rows.map((m:any) => String(m.id || m.name || m.model || '')).filter(Boolean).slice(0,200);
}
export async function modelCompletion(connection: AiConnection, messages: any[], tools: any[], signal?: AbortSignal): Promise<any> {
  const native = connection.provider === 'ollama';
  const normalized = messages.map(m => {
    const n = {...m}; if(connection.provider!=='deepseek')delete n.reasoning_content; if(!native)delete n.thinking;
    if (native && n.tool_calls) n.tool_calls = n.tool_calls.map((c:any) => ({ function:{name:c.function.name,arguments: typeof c.function.arguments === 'string' ? JSON.parse(c.function.arguments) : c.function.arguments} }));
    if (n.role === 'tool') { if(native){n.tool_name = n.name;delete n.tool_call_id;} delete n.name; }
    return n;
  });
  const body: any = { model:connection.model, messages:normalized, tools, stream:false };
  if (native) {body.options = { num_predict:4096, num_ctx:16384 };body.think=false;}
  else { body.tool_choice = 'auto'; if (connection.provider === 'openai') body.max_completion_tokens = 4096; else body.max_tokens = 4096; }
  const r = await aiRequest(connection, native ? '/api/chat' : '/chat/completions', body, signal);
  const message = native ? r.message : r.choices?.[0]?.message;
  if (!message || message.role !== 'assistant') throw new OwnerAutomationError('MODEL_INVALID_RESPONSE','Модель не вернула сообщение.',502);
  const output: any = {role:'assistant',content: typeof message.content === 'string' ? message.content.slice(0,24000) : ''};
  if (typeof message.thinking === 'string') output.thinking=message.thinking.slice(0,64000);
  if (typeof message.reasoning_content === 'string') output.reasoning_content=message.reasoning_content.slice(0,64000);
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length > 12) throw new OwnerAutomationError('MODEL_INVALID_TOOLS','Некорректный список команд модели.',502);
    output.tool_calls = message.tool_calls.map((call:any) => {
      if (!call?.function || typeof call.function.name !== 'string') throw new OwnerAutomationError('MODEL_INVALID_TOOLS','Некорректная команда модели.',502);
      const args = typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments || {});
      if (args.length > 65536) throw new OwnerAutomationError('MODEL_INVALID_TOOLS','Команда модели слишком большая.',502);
      return { id: typeof call.id === 'string' && call.id.length <= 200 ? call.id : id('call'), type:'function', function:{name:call.function.name,arguments:args} };
    });
  }
  return output;
}

/** Discover models before saving; credentials are used only for this owner-requested lookup. */
export async function discoverAiModels(ownerId:string,value:unknown):Promise<any>{
  const b=objectValue(value);
  if(!['openai','deepseek','compatible','ollama'].includes(b.provider))throw new OwnerAutomationError('INVALID_PROVIDER','Выберите провайдера.');
  const baseUrl=normalizedEndpoint(b.provider,b.baseUrl);
  let apiKey=typeof b.apiKey==='string'?b.apiKey.trim():'';
  if(!apiKey&&typeof b.id==='string'){
    const old=db.prepare('SELECT * FROM owner_ai_connections WHERE id=? AND owner_id=?').get(b.id,ownerId) as AiConnection|undefined;
    if(old&&old.provider===b.provider&&old.base_url===baseUrl)apiKey=decryptJson<any>(old.credentials_encrypted).apiKey||'';
  }
  if(b.provider!=='ollama'&&!apiKey)throw new OwnerAutomationError('KEY_REQUIRED','Введите API-ключ для получения списка моделей.');
  if(apiKey.length>8192||/[\r\n\u0000]/.test(apiKey))throw new OwnerAutomationError('INVALID_KEY','Некорректный API-ключ.');
  const ephemeral:AiConnection={id:'discovery',owner_id:ownerId,name:'discovery',provider:b.provider,base_url:baseUrl,model:'discovery',credentials_encrypted:encryptJson({apiKey}),revision:1,enabled:1,tool_verified:0};
  const models=await listAiModels(ephemeral);
  const candidates=models.filter(name=>!/(?:embed|whisper|tts|audio|realtime|transcrib|moderation|dall-e|image|sora|babbage|davinci|instruct)/i.test(name));
  const order=(name:string):number=>{
    if(b.provider==='ollama'&&name==='gemma4:12b')return 0;
    if(b.provider==='deepseek'&&/^deepseek-(flash|chat)$/.test(name))return 0;
    if(/mini|flash|small|:([3-9]|1[0-2])b/i.test(name))return 1;
    if(/gpt|deepseek|qwen|gemma|llama|ornith/i.test(name))return 2;
    return 3;
  };
  candidates.sort((a,b)=>order(a)-order(b)||a.localeCompare(b));
  return {models,suggestedModel:candidates[0]||models[0]||null,toolCallingVerified:false};
}
