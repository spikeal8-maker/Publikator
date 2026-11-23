import {createModelPicker} from './assistant-model-picker.js';
import {renderAssistantMarkdown} from './assistant-markdown.js';
import {setupAssistantConsole} from './assistant-console.js';
const $=id=>document.getElementById(id);
let connections=[],threads=[],threadId=null,runId=null,pollEpoch=0,attachments=[],editId=null,statusInfo=null,busy=false;
const defaults={openai:'https://api.openai.com/v1',deepseek:'https://api.deepseek.com',ollama:'',compatible:''};
const providerGroups = { local: { ollama: 'Ollama' }, cloud: {
  openai: 'OpenAI', deepseek: 'DeepSeek', compatible: 'Совместимый API',
} };
const connectionChecks = new Map();
const defaultConnectionKey = 'publikator.assistant.defaultConnection';
let modelPanel = null;
let defaultConnectionId = '';
try { defaultConnectionId = localStorage.getItem(defaultConnectionKey) || ''; } catch {}
const modelPicker=createModelPicker({api,getConnections:()=>connections,getEditId:()=>editId});
const toolLabels={publikator_list_projects:'Чтение проектов',publikator_list_accounts:'Проверка подключений',publikator_list_posts:'Чтение публикаций',publikator_get_post:'Чтение материала',publikator_preview_post:'Предпросмотр',publikator_create_post:'Создание черновика',publikator_update_post:'Редактирование материала',publikator_set_targets:'Выбор получателей',publikator_mark_ready:'Проверка готовности',publikator_publish_now:'Отправка публикации',publikator_set_schedule:'Изменение расписания',publikator_import_cloud_media:'Импорт вложения',publikator_attach_uploaded_media:'Прикрепление файла',publikator_call_operation:'Операция Publikator',publikator_list_operations:'Поиск доступных операций',publikator_list_uploads:'Чтение вложений',model:'Модель готовит ответ'};
function toast(text,error=false){$('toast').textContent=text;$('toast').classList.toggle('error',error);$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,6500);}
async function api(url,options={}){const headers={...(options.body instanceof FormData?{}:{'content-type':'application/json'}),...options.headers};const response=await fetch(url,{...options,headers,credentials:'same-origin'});let data;try{data=await response.json();}catch{throw new Error('Сервер вернул непонятный ответ.');}if(response.status===401){$('login-notice').hidden=false;$('shell').hidden=true;throw new Error('Сессия завершена. Войдите в Publikator.');}if(!response.ok)throw new Error(typeof data.error==='string'?data.error:data.error?.message||data.message||'Не удалось выполнить запрос.');return data;}
function guarded(fn){return async event=>{try{await fn(event);}catch(error){toast(error.message||'Ошибка',true);}};}
function element(tag,className,text){const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;return el;}
function textWithLinks(target,text){const regex=/https?:\/\/[^\s<>"']+/g;let pos=0;for(const match of text.matchAll(regex)){target.append(document.createTextNode(text.slice(pos,match.index)));const a=document.createElement('a');a.href=match[0];a.textContent=match[0];a.target='_blank';a.rel='noopener noreferrer';target.append(a);pos=match.index+match[0].length;}target.append(document.createTextNode(text.slice(pos)));}
function renderMessages(messages){const root=$('messages');root.replaceChildren();if(!messages.length){const empty=element('div','empty');empty.append(element('h2','', 'Что нужно сделать?'),element('p','','Попросите проверить расписание, подготовить публикацию или настроить подключение.'));root.append(empty);return;}for(const message of messages){if(message.role==='tool'){const item=element('details','message tool');item.append(element('summary','',toolLabels[message.name]||message.name||'Результат операции'));let result=message.content||'';try{result=JSON.stringify(JSON.parse(result),null,2);}catch{}item.append(element('pre','',result));root.append(item);continue;}if(!message.content)continue;const item=element('article','message '+(message.role==='user'?'user':'assistant'));item.append(element('div','label',message.role==='user'?'Вы':'Помощник'));const text=element('div','text');if(message.role==='assistant')renderAssistantMarkdown(text,message.content);else textWithLinks(text,message.content);item.append(text);root.append(item);}root.scrollTop=root.scrollHeight;}
function renderThreads(){const root=$('threads');root.replaceChildren();for(const thread of threads){const b=element('button',thread.id===threadId?'active':'',thread.title);b.type='button';b.title=thread.title;b.addEventListener('click',guarded(()=>loadThread(thread.id)));root.append(b);}}
async function refreshThreads(){threads=(await api('/api/assistant/threads')).threads;renderThreads();}
function setBusy(value){busy=value;$('send-message').disabled=value;$('stop-run').hidden=!value;$('run-state').classList.toggle('busy',value);}
async function loadThread(id){pollEpoch++;threadId=id;runId=null;setBusy(false);const data=await api('/api/assistant/threads/'+encodeURIComponent(id));$('thread-title').textContent=data.thread.title;renderMessages(data.messages);renderThreads();$('run-state').textContent='';if(data.activeRunId){runId=data.activeRunId;setBusy(true);void pollRun(runId,++pollEpoch);}}
async function newThread(){const result=await api('/api/assistant/threads',{method:'POST',body:'{}'});await refreshThreads();await loadThread(result.id);$('message-input').focus();}
function renderConnections(){
  const picker = $('connection-select');
  const previous = picker.value;
  const enabled = connections.filter((connection) => connection.enabled);
  const options = () => ['local','cloud'].flatMap((group) => {
    const choices = enabled.filter((connection) => connectionGroup(connection) === group);
    if (!choices.length) return [];
    const label = group === 'local' ? 'Локальные модели' : 'Облачные модели';
    const optionGroup = document.createElement('optgroup');
    optionGroup.label = label;
    optionGroup.append(...choices.map((connection) => new Option(connection.name + ' · ' + connection.model, connection.id)));
    return [optionGroup];
  });
  picker.replaceChildren(...(enabled.length ? options() : [new Option('Подключите модель', '')]));
  picker.value = [previous, defaultConnectionId, enabled[0]?.id]
    .find((id) => enabled.some((connection) => connection.id === id)) || '';
  const defaultsPicker = $('default-connection');
  defaultsPicker.replaceChildren(new Option('Первая доступная модель', ''), ...options());
  defaultsPicker.value = enabled.some((connection) => connection.id === defaultConnectionId) ? defaultConnectionId : '';
  defaultsPicker.disabled = !enabled.length;
  renderConnectionCards();
  renderModelAccessConnections();
  updateChatAccess();
}

function connectionGroup(connection) {
  return connection.provider === 'ollama' ? 'local' : 'cloud';
}

function renderConnectionCards() {
  const statusText = (c) => {
    if (!c.enabled) return 'Выключено';
    return connectionChecks.get(c.id) || (c.toolVerified ? 'Инструменты проверены ранее' : 'Требуется проверка');
  };
  const local = connections.filter(c => connectionGroup(c) === 'local');
  const cloud = connections.filter(c => connectionGroup(c) === 'cloud');
  $('overview-local-count').textContent = local.filter(c => c.enabled).length;
  $('overview-cloud-count').textContent = cloud.filter(c => c.enabled).length;
  const card = c => {
    const item = element('div','connection-card');
    const info = element('div','connection-card-info');
    const provider = providerGroups[connectionGroup(c)][c.provider];
    info.append(element('strong','',c.name),
      element('span','muted',provider + ' · ' + c.model),
      element('span','connection-check',statusText(c)));
    const edit = element('button','','Настроить');
    edit.type = 'button';
    edit.setAttribute('aria-label','Настроить ' + c.name);
    edit.onclick = () => openConnectionEditor(c.provider,c.id);
    item.append(info,edit);
    return item;
  };
  const fill = (id, items, empty) => $(id).replaceChildren(...(items.length ? items.map(card) :
    [element('p','muted',empty)]));
  fill('overview-models', connections.filter(c => c.enabled), 'Добавьте модель во вкладке локальных или облачных моделей.');
  fill('local-connections', local, 'Локальных подключений пока нет.');
  fill('cloud-connections', cloud, 'Облачных подключений пока нет.');
}
function updateChatAccess() {
  const connection = connections.find((item) => item.id === $('connection-select').value);
  const readOnly = connection?.accessMode === 'READ_ONLY';
  $('allow-writes').disabled = readOnly;
  if (readOnly) $('allow-writes').checked = false;
  $('allow-writes').closest('label').title = readOnly ? 'Для этой модели включён режим «Только чтение».' : '';
}

function currentAccessConnection() {
  return connections.find((item) => item.id === $('model-access-connection').value);
}

function syncAccessForm() {
  const connection = currentAccessConnection();
  $('model-access-mode').disabled = !connection;
  $('model-access-mode').value = connection?.accessMode || 'READ_ONLY';
  $('model-access-save').disabled = !connection;
  $('model-access-confirm-row').hidden = true;
  $('model-access-confirm').checked = false;
  $('model-access-status').textContent = connection ? '' : 'Сначала подключите модель.';
}

function renderModelAccessConnections() {
  const picker = $('model-access-connection');
  const previous = picker.value;
  picker.replaceChildren(...(connections.length ? connections.map(({ id, name, model }) =>
    new Option(name + ' · ' + model, id)) : [new Option('Нет подключений', '')]));
  if (connections.some(({ id }) => id === previous)) picker.value = previous;
  syncAccessForm();
}

$('connection-select').addEventListener('change', updateChatAccess);
$('model-access-connection').addEventListener('change', syncAccessForm);
$('model-access-mode').addEventListener('change', () => {
  const elevation = currentAccessConnection()?.accessMode === 'READ_ONLY' && $('model-access-mode').value === 'OWNER_TOOLS';
  $('model-access-confirm-row').hidden = !elevation;
  $('model-access-confirm').checked = false;
});
$('model-access-form').addEventListener('submit', guarded(async (event) => {
  event.preventDefault();
  const connection = currentAccessConnection();
  if (!connection) return;
  const button = $('model-access-save');
  button.disabled = true;
  try {
    await api('/api/assistant/connections/' + encodeURIComponent(connection.id) + '/access', {
      method: 'PATCH', body: JSON.stringify({
        expectedRevision: connection.revision,
        accessMode: $('model-access-mode').value,
        confirmElevation: $('model-access-confirm').checked,
      }),
    });
    await refreshConnections();
    $('model-access-status').textContent = 'Права модели сохранены.';
  } finally {
    button.disabled = !currentAccessConnection();
  }
}));

async function refreshConnections(){connections=(await api('/api/assistant/connections')).connections;renderConnections();}
function closeConnectionEditor() {
  $('model-editor').hidden = true;
  $('provider-key').value = '';
  $('local-provider-key').value = '';
  modelPicker.cancel();
  editId = null;
}
function openConnectionEditor(provider, id = null) {
  const group = connectionGroup({provider});
  if (modelPanel !== group) activateSettings(group);
  const connection = connections.find(c => c.id === id && c.provider === provider);
  editId = connection?.id || null;
  const label = providerGroups[group][provider];
  $('provider-kind').replaceChildren(new Option(label, provider));
  const local = group === 'local';
  $('provider-name').value = connection?.name || '';
  $('provider-url').value = connection?.baseUrl || defaults[provider];
  $('provider-url-label').textContent = local ? 'Сетевой адрес сервера' : 'Адрес API';
  $('provider-url-row').hidden = !local && provider !== 'compatible';
  $('provider-url').placeholder = local ? 'http://192.168.1.50:11434' : 'https://example.com/v1';
  $('provider-key').value = '';
  $('local-provider-key').value = '';
  $('provider-help').open = false;
  $('model-editor-title').textContent = connection ? 'Настроить ' + connection.name : 'Подключить ' + label;
  $('settings-panel-' + group).append($('model-editor'));
  $('model-editor').hidden = false;
  $('test-connection').hidden = !connection;
  $('test-connection').disabled = false;
  $('delete-connection').hidden = !connection;
  modelPicker.selectExisting(connection);
}

const settingsTabs = [...$('settings').querySelectorAll('[role="tab"]')];
let chatGPTGrantLoaded = false;

function activateSettings(tabName, { focus = false } = {}) {
  const selected = $('settings-tab-' + tabName);
  for (const tab of settingsTabs) {
    const active = tab === selected;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    $(tab.getAttribute('aria-controls')).hidden = !active;
  }
  if (tabName !== 'mcp') clearNewMcpKey();
  if (modelPanel !== tabName) closeConnectionEditor();
  modelPanel = tabName;
  if (tabName === 'access' && !chatGPTGrantLoaded) {
    chatGPTGrantLoaded = true;
    void loadChatGPTGrant();
  }
  if (focus) selected.focus();
}

async function openSettings(tab = 'general'){
  chatGPTGrantLoaded = false;
  activateSettings(tab);
  $('settings').showModal();
  await Promise.all([refreshConnections(), refreshKeys()]);
  statusInfo = await api('/api/assistant/status');
  $('mcp-url').value = statusInfo.mcpUrl;
  renderChatGPTMcp();
}

document.querySelectorAll('[data-new-provider]').forEach(button =>
  button.addEventListener('click', () => {
    openConnectionEditor(button.dataset.newProvider);
    $('model-editor').querySelector('input:not([type=hidden])').focus();
  }));
$('model-editor-close').onclick = closeConnectionEditor;

function clearNewMcpKey() {
  $('new-key-value').value = '';
  $('new-key').hidden = true;
}

for (const [index, tab] of settingsTabs.entries()) {
  const activate = () => activateSettings(tab.id.replace('settings-tab-', ''), { focus: true });
  tab.addEventListener('click', activate);
  tab.addEventListener('keydown', (event) => {
    const next = { ArrowRight: (index + 1) % settingsTabs.length,
      ArrowLeft: (index + settingsTabs.length - 1) % settingsTabs.length, Home: 0, End: settingsTabs.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    settingsTabs[next].click();
  });
}
$('settings').querySelectorAll('[data-settings-tab]').forEach((button) =>
  button.addEventListener('click', () => activateSettings(button.dataset.settingsTab, { focus: true })));
$('default-connection').addEventListener('change', (event) => {
  defaultConnectionId = event.target.value;
  try { localStorage.setItem(defaultConnectionKey, defaultConnectionId); } catch {}
  if (!busy) $('connection-select').value = defaultConnectionId || $('connection-select').querySelector('option')?.value || '';
  updateChatAccess();
});
function renderChatGPTMcp(){
  const url=statusInfo?.chatgptMcpUrl||'';
  $('chatgpt-mcp-url').textContent=url;
  $('overview-mcp-state').textContent = url ? 'Настроен' : 'Не настроен';
  $('chatgpt-mcp-guide').hidden=!url;
  $('chatgpt-mcp-state').textContent=url
    ? 'Адрес настроен. Завершите подключение и подтвердите доступ в ChatGPT.'
    : 'OAuth для ChatGPT ещё не настроен на сервере. Для встроенного чата выберите локальную модель или облачный API.';
}
$('copy-chatgpt-url').addEventListener('click',guarded(async()=>{
  await navigator.clipboard.writeText($('chatgpt-mcp-url').textContent);
  toast('Адрес ChatGPT MCP скопирован.');
}));
$('test-chatgpt-url').addEventListener('click',guarded(async()=>{
  const status=$('chatgpt-mcp-state');
  const address=statusInfo?.chatgptMcpUrl;
  if(!address||new URL(address).origin!==location.origin)return;
  status.textContent='Проверяем адрес…';
  try {
    const response=await fetch(address,{
      method:'POST',credentials:'omit',
      headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{
        protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'publikator-setup',version:'1'},
      }}),
    });
    const challenge=response.headers.get('www-authenticate')||'';
    await response.body?.cancel();
    status.textContent=response.status===401&&challenge.includes('resource_metadata=')
      ? 'Адрес доступен и запрашивает OAuth. Теперь можно добавить его в ChatGPT.'
      : `Адрес MCP ещё не готов (HTTP ${response.status}). Проверьте настройку сервера и прокси.`;
  } catch {
    status.textContent='Не удалось связаться с адресом MCP.';
  }
}));
const chatGPTScopeLabels = new Map([
  ['projects:read', 'Просматривать проекты'],
  ['accounts:read', 'Просматривать аккаунты и доступные форматы'],
  ['posts:read', 'Читать публикации, тексты и статистику разрешённых проектов'],
  ['posts:write', 'Создавать и редактировать текстовые черновики'],
  ['sources:read', 'Просматривать разрешённые источники медиа'],
  ['media:import', 'Прикреплять изображения и MP4 из выбранных источников'],
]);
let editingChatGPTGrant = null;
let editableChatGPTSources = [];
let preparedChatGPTAgentId = '';
let chatGPTProfileRequestId = null;
let chatGPTGrantLoad = 0;

function renderGrantOptions(container, entries, selected) {
  const chosen = new Set(selected);
  container.replaceChildren(...entries.map(([value, text]) => {
    const label = element('label', '');
    const input = element('input', '');
    input.type = 'checkbox';
    input.value = value;
    input.checked = chosen.has(value);
    label.append(input, ' ' + text);
    return label;
  }));
  if (!entries.length) container.textContent = 'Пока нет доступных вариантов.';
}

async function selectChatGPTProfile() {
  const configured = statusInfo?.chatgptAgentId;
  $('chatgpt-profile-setup').hidden = Boolean(configured);
  if (configured) return configured;
  const { items } = await api('/api/owner/agents?limit=100');
  const agents = items.filter((agent) => agent.clientKind === 'chatgpt' && agent.status === 'ACTIVE');
  const select = $('chatgpt-profile-select');
  select.replaceChildren(...agents.map((agent) => {
    const option = element('option', '', agent.name);
    option.value = agent.agentId;
    return option;
  }));
  if (agents.some((agent) => agent.agentId === preparedChatGPTAgentId)) {
    select.value = preparedChatGPTAgentId;
  }
  preparedChatGPTAgentId = select.value;
  $('chatgpt-create-profile').hidden = agents.length > 0;
  $('chatgpt-profile-id').value = preparedChatGPTAgentId;
  $('chatgpt-profile-id-row').hidden = !preparedChatGPTAgentId;
  return preparedChatGPTAgentId;
}

async function loadChatGPTGrant() {
  const run = ++chatGPTGrantLoad;
  const status = $('chatgpt-permission-status');
  const form = $('chatgpt-grant-form');
  form.hidden = true;
  editingChatGPTGrant = null;
  status.textContent = 'Загружаем текущие права…';
  try {
    const agentId = await selectChatGPTProfile();
    if (run !== chatGPTGrantLoad) return;
    if (!agentId) {
      status.textContent = 'Создайте профиль, чтобы выбрать его права.';
      return;
    }
    const [agent, projects, accounts, drive, disk] = await Promise.all([
      api('/api/owner/agents/' + encodeURIComponent(agentId)),
      api('/api/projects'), api('/api/accounts'),
      api('/api/google-drive/connectors'), api('/api/yandex-disk/connectors'),
    ]);
    if (run !== chatGPTGrantLoad) return;
    const grant = agent.grant;
    if (agent.status !== 'ACTIVE' || grant.publishMode === 'PREAPPROVED_POLICY') {
      status.textContent = 'Для этого подключения требуется проверка настроек владельцем.';
      return;
    }
    editingChatGPTGrant = grant;
    const sources = [...drive.connectors, ...disk.connectors];
    editableChatGPTSources = sources.map(({id}) => id);
    renderGrantOptions($('chatgpt-grant-sources'), sources.map(({id, name}) => [id, name]), grant.sourceConnectorIds);
    renderGrantOptions($('chatgpt-grant-scopes'), [...chatGPTScopeLabels], grant.scopeIds);
    renderGrantOptions($('chatgpt-grant-projects'), projects.map(({id, name}) => [id, name]), grant.projectIds);
    renderGrantOptions($('chatgpt-grant-accounts'), accounts.map(({id, name}) => [id, name]), grant.accountIds);
    $('chatgpt-grant-confirm').checked = false;
    status.textContent = 'После изменения прав ChatGPT потребуется заново подключить. Права отправки здесь не меняются.';
    form.hidden = false;
  } catch (error) {
    if (run === chatGPTGrantLoad) status.textContent = error.message;
  }
}

$('chatgpt-profile-select').addEventListener('change', () => {
  preparedChatGPTAgentId = $('chatgpt-profile-select').value;
  void loadChatGPTGrant();
});
$('chatgpt-create-profile').addEventListener('click',guarded(async()=>{
  const button = $('chatgpt-create-profile');
  button.disabled = true;
  chatGPTProfileRequestId ||= crypto.randomUUID();
  try {
    const agent = await api('/api/owner/agents', {
      method: 'POST', headers: { 'Idempotency-Key': chatGPTProfileRequestId },
      body: JSON.stringify({ name: 'ChatGPT', clientKind: 'chatgpt' }),
    });
    preparedChatGPTAgentId = agent.agentId;
    chatGPTProfileRequestId = null;
    await loadChatGPTGrant();
  } finally {
    button.disabled = false;
  }
}));
$('chatgpt-grant-all').addEventListener('click', () => {
  for (const field of $('chatgpt-grant-form').querySelectorAll('fieldset input[type="checkbox"]')) field.checked = true;
});
$('chatgpt-grant-form').addEventListener('submit', guarded(async (event) => {
  event.preventDefault();
  const grant = editingChatGPTGrant;
  if (!grant || !$('chatgpt-grant-confirm').checked) return;
  const selected = (name) => [...$(name).querySelectorAll('input:checked')].map((field) => field.value);
  const scopeIds = [...grant.scopeIds.filter((scope) => !chatGPTScopeLabels.has(scope)), ...selected('chatgpt-grant-scopes')];
  await api('/api/owner/agents/' + encodeURIComponent(grant.agentId) + '/grant', {
    method: 'PUT', headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({
      expectedGrantVersion: grant.grantVersion, presetId: 'CUSTOM', publishMode: grant.publishMode,
      scopeIds, projectIds: selected('chatgpt-grant-projects'), accountIds: selected('chatgpt-grant-accounts'),
      sourceConnectorIds: [
        ...grant.sourceConnectorIds.filter((id) => !editableChatGPTSources.includes(id)),
        ...selected('chatgpt-grant-sources'),
      ],
      confirmElevation: true,
    }),
  });
  await loadChatGPTGrant();
  toast('Права ChatGPT сохранены.');
}));

async function saveConnection(event){
  event.preventDefault();
  const editingGroup = modelPanel;
  const editingConnection = editId;
  let model=modelPicker.selected();
  if(!model){
    await modelPicker.discover({quiet:false});
    if (modelPanel !== editingGroup || editId !== editingConnection) return;
    model=modelPicker.selected();
  }
  if(!model)throw new Error('Сервер не вернул доступных моделей. Откройте диагностику или обновите список.');
  const old=connections.find(c=>c.id===editId);
  const data={
    name:$('provider-name').value.trim()||$('provider-kind').selectedOptions[0].text,
    provider:$('provider-kind').value,baseUrl:$('provider-url').value,
    model,apiKey:modelPicker.key(),...(old?{id:old.id,expectedRevision:old.revision}:{})
  };
  const btn=$('connection-form').querySelector('button[type=submit]');
  btn.disabled=true;
  try{
    modelPicker.message('Сохраняю подключение…','pending');
    const saved=await api('/api/assistant/connections',{method:'POST',body:JSON.stringify(data)});
    $('provider-key').value='';
    $('local-provider-key').value='';
    connectionChecks.delete(saved.id);
    await refreshConnections();
    if (modelPanel !== editingGroup || editId !== editingConnection) {
      toast('Подключение сохранено. Проверку можно запустить в его разделе.');
      return;
    }
    openConnectionEditor(data.provider, saved.id);
    $('connection-select').value=saved.id;
    updateChatAccess();
    try{
      await testConnection();
      toast('Подключение сохранено. Результат проверки показан ниже.');
    }catch(error){
      const message=error instanceof Error?error.message:'Ошибка';
      if (editId !== saved.id) return;
      $('provider-test-result').textContent='Подключение сохранено, но вызов инструмента не подтверждён: '+message;
      $('provider-test-result').className='test-result error';
      toast('Подключение сохранено, но модель ещё не проверена.',true);
    }
  }finally{btn.disabled=false;}
}
async function testConnection(){
  if(!editId)throw new Error('Сначала сохраните подключение.');
  const checkingId = editId;
  const result = $('provider-test-result');
  $('test-connection').disabled=true;
  result.textContent='Проверяем ответ модели и вызов инструмента…';
  result.className='test-result';
  try{
    const r=await api('/api/assistant/connections/'+encodeURIComponent(checkingId)+'/test',
      {method:'POST',body:'{}'});
    connectionChecks.set(checkingId,r.toolCalling ? 'Инструменты проверены' : 'Отвечает, инструменты не подтверждены');
    if (editId === checkingId) {
      result.textContent=r.message;
      result.className='test-result '+(r.toolCalling?'ok':'error');
    }
    await refreshConnections();
  }catch(error){
    connectionChecks.set(checkingId,'Проверка завершилась ошибкой');
    renderConnectionCards();
    if (editId === checkingId) {
      result.textContent=error.message;
      result.className='test-result error';
    }
    throw error;
  }finally{if (editId === checkingId) $('test-connection').disabled=false;}
}
async function refreshKeys(){const keys=(await api('/api/assistant/keys')).keys;const root=$('key-list');root.replaceChildren();for(const k of keys){const row=element('div','key-row');const info=element('div','',k.name);info.append(element('small','',k.revoked_at?'Отключён':`${k.prefix}… · до ${new Date(k.expires_at).toLocaleDateString('ru-RU')}`));row.append(info);if(!k.revoked_at){const b=element('button','danger','Отозвать');b.type='button';b.addEventListener('click',guarded(async()=>{if(!confirm('Отключить доступ этому боту?'))return;await api('/api/assistant/keys/'+encodeURIComponent(k.id)+'/revoke',{method:'POST',body:'{}'});await refreshKeys();}));row.append(b);}root.append(row);}}
function renderAttachments(){const root=$('attachments');root.replaceChildren();for(const file of attachments){const chip=element('span','file-chip',file.name);const remove=element('button','','×');remove.type='button';remove.setAttribute('aria-label','Не использовать '+file.name);remove.addEventListener('click',()=>{attachments=attachments.filter(x=>x.id!==file.id);renderAttachments();});chip.append(remove);root.append(chip);}}
async function uploadFiles(event){const files=[...event.target.files];event.target.value='';if(files.length>12)throw new Error('За один раз выберите не больше 12 файлов.');for(const file of files){$('run-state').textContent='Загрузка: '+file.name;const form=new FormData();form.append('file',file,file.name);const result=await api('/api/assistant/uploads',{method:'POST',body:form});attachments.push(result);renderAttachments();}$('run-state').textContent='Вложения загружены. Укажите, что с ними сделать.';}
async function sendMessage(event){event.preventDefault();if(busy)return;let message=$('message-input').value.trim();if(!message)return;const connectionId=$('connection-select').value;if(!connectionId){await openSettings('local');throw new Error('Подключите модель для чата.');}if(!threadId)await newThread();if(attachments.length)message+='\n\nВложения к моему сообщению (используй uploadId через publikator_attach_uploaded_media):\n'+attachments.map(a=>`${a.name}; uploadId=${a.id}; тип=${a.mimeType}; размер=${a.sizeBytes}`).join('\n');const body={threadId,connectionId,message,allowWrites:!$('allow-writes').disabled&&$('allow-writes').checked,idempotencyKey:crypto.randomUUID()};setBusy(true);$('run-state').textContent='Запрос принят к выполнению…';try{const run=await api('/api/assistant/runs',{method:'POST',body:JSON.stringify(body)});runId=run.id;$('message-input').value='';attachments=[];renderAttachments();await refreshThreads();void pollRun(runId,++pollEpoch);}catch(error){setBusy(false);$('run-state').textContent='';throw error;}}
async function pollRun(id,epoch){try{while(epoch===pollEpoch){const [run,thread]=await Promise.all([api('/api/assistant/runs/'+encodeURIComponent(id)),api('/api/assistant/threads/'+encodeURIComponent(threadId))]);if(epoch!==pollEpoch)return;renderMessages(thread.messages);$('thread-title').textContent=thread.thread.title;$('run-state').textContent=run.status==='RUNNING'?(toolLabels[run.currentOperation]||run.currentOperation||'Подготовка запроса…'):run.status==='COMPLETED'?'Готово':run.result?.text||({'FAILED':'Запрос завершился ошибкой','CANCELLED':'Запрос остановлен','INTERRUPTED':'Запрос прерван перезапуском сервера'}[run.status]||run.status);if(run.status!=='RUNNING'){setBusy(false);runId=null;await refreshThreads();return;}await new Promise(r=>setTimeout(r,1500));}}catch(error){if(epoch===pollEpoch){setBusy(false);toast(error.message,true);$('run-state').textContent='Связь с сервером прервалась. Обновите диалог для проверки результата.';}}}
$('new-thread').addEventListener('click',guarded(newThread));$('settings-open').addEventListener('click',guarded(()=>openSettings()));$('settings-close').addEventListener('click',()=>$('settings').close());$('settings').addEventListener('close',()=>{clearNewMcpKey();closeConnectionEditor();modelPanel=null;});$('composer').addEventListener('submit',guarded(sendMessage));$('message-input').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();$('composer').requestSubmit();}});$('file-input').addEventListener('change',guarded(uploadFiles));$('stop-run').addEventListener('click',guarded(async()=>{if(runId){await api('/api/assistant/runs/'+encodeURIComponent(runId)+'/stop',{method:'POST',body:'{}'});$('run-state').textContent='Остановка новых действий…';}}));
$('connection-form').addEventListener('submit',guarded(saveConnection));
$('provider-url').addEventListener('input',()=>modelPicker.onEndpointChange());
$('provider-key').addEventListener('input',()=>modelPicker.onEndpointChange());
$('local-provider-key').addEventListener('input',()=>modelPicker.onEndpointChange());
$('load-models').addEventListener('click',guarded(()=>modelPicker.discover({quiet:false})));
$('provider-manual-model').addEventListener('change',()=>{
  if($('provider-manual-model').value.trim())modelPicker.message('Используется вручную указанная модель. Проверка инструментов выполняется после сохранения.','info');
});
$('test-connection').addEventListener('click',guarded(testConnection));
$('delete-connection').addEventListener('click',guarded(async()=>{
 if(!editId||!confirm('Удалить это подключение модели?'))return;
 await api('/api/assistant/connections/'+encodeURIComponent(editId),{method:'DELETE'});
 connectionChecks.delete(editId);closeConnectionEditor();await refreshConnections();
}));
$('key-form').addEventListener('submit',guarded(async event=>{event.preventDefault();const key=await api('/api/assistant/keys',{method:'POST',body:JSON.stringify({name:$('key-name').value,days:Number($('key-days').value),confirmOwnerAdmin:$('confirm-owner').checked})});$('new-key-value').value=key.token;$('new-key').hidden=false;$('confirm-owner').checked=false;await refreshKeys();}));$('copy-key').addEventListener('click',guarded(async()=>{await navigator.clipboard.writeText($('new-key-value').value);toast('Ключ скопирован.');}));$('hide-key').addEventListener('click',()=>{$('new-key-value').value='';$('new-key').hidden=true;});document.querySelectorAll('[data-prompt]').forEach(b=>b.addEventListener('click',()=>{$('message-input').value=b.dataset.prompt;$('message-input').focus();}));
async function boot(){const auth=await api('/api/auth/state');if(!auth.authenticated||auth.mode!=='login'){$('login-notice').hidden=false;$('connection-state').textContent='Требуется вход';return;}statusInfo=await api('/api/assistant/status');$('shell').hidden=false;$('console-open').hidden=false;$('connection-state').textContent=`MCP · ${statusInfo.operationCount} операций`;await Promise.all([refreshConnections(),refreshThreads()]);if(threads.length)await loadThread(threads[0].id);if(!connections.length)$('run-state').textContent='Откройте «Настройки», чтобы подключить модель.';}
setupAssistantConsole({ api });
void boot().catch(error=>toast(error.message,true));
