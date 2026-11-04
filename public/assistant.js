import {createModelPicker} from './assistant-model-picker.js';
import {renderAssistantMarkdown} from './assistant-markdown.js';
const $=id=>document.getElementById(id);
let connections=[],threads=[],threadId=null,runId=null,pollEpoch=0,attachments=[],editId=null,statusInfo=null,busy=false;
const defaults={openai:'https://api.openai.com/v1',deepseek:'https://api.deepseek.com',ollama:'http://host.docker.internal:11434',compatible:''};
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
function renderConnections(){const previous=$('connection-select').value;$('connection-select').replaceChildren();$('edit-connection').replaceChildren(new Option('Новое подключение',''));if(!connections.length)$('connection-select').append(new Option('Подключите модель',''));for(const c of connections){if(c.enabled)$('connection-select').append(new Option(c.name+' · '+c.model,c.id));$('edit-connection').append(new Option(c.name,c.id));}if(connections.some(c=>c.id===previous))$('connection-select').value=previous;if(editId)$('edit-connection').value=editId;}
async function refreshConnections(){connections=(await api('/api/assistant/connections')).connections;renderConnections();}
function selectConnection(id){
  editId=id||null;
  const c=connections.find(c=>c.id===id);
  $('provider-name').value=c?.name||'';
  $('provider-kind').value=c?.provider||'ollama';
  $('provider-url').value=c?.baseUrl||defaults[$('provider-kind').value];
  $('provider-key').value='';
  modelPicker.selectExisting(c);
  $('test-connection').disabled=!c;
  $('delete-connection').disabled=!c;
}
async function openSettings(){$('settings').showModal();await Promise.all([refreshConnections(),refreshKeys()]);selectConnection(editId||$('connection-select').value);$('edit-connection').value=editId||'';if(statusInfo)$('mcp-url').value=statusInfo.mcpUrl;}
async function saveConnection(event){
  event.preventDefault();
  let model=modelPicker.selected();
  if(!model){
    await modelPicker.discover({quiet:false});
    model=modelPicker.selected();
  }
  if(!model)throw new Error('Сервер не вернул доступных моделей. Откройте диагностику или обновите список.');
  const old=connections.find(c=>c.id===editId);
  const data={
    name:$('provider-name').value.trim()||$('provider-kind').selectedOptions[0].text,
    provider:$('provider-kind').value,baseUrl:$('provider-url').value,
    model,apiKey:$('provider-key').value,...(old?{id:old.id,expectedRevision:old.revision}:{})
  };
  const btn=$('connection-form').querySelector('button[type=submit]');
  btn.disabled=true;
  try{
    modelPicker.message('Сохраняю подключение…','pending');
    const saved=await api('/api/assistant/connections',{method:'POST',body:JSON.stringify(data)});
    $('provider-key').value='';
    editId=saved.id;
    await refreshConnections();
    selectConnection(saved.id);
    $('connection-select').value=saved.id;
    $('edit-connection').value=saved.id;
    try{
      await testConnection();
      toast('Подключение сохранено. Результат проверки показан ниже.');
    }catch(error){
      const message=error instanceof Error?error.message:'Ошибка';
      $('provider-test-result').textContent='Подключение сохранено, но вызов инструмента не подтверждён: '+message;
      $('provider-test-result').className='test-result error';
      toast('Подключение сохранено, но модель ещё не проверена.',true);
    }
  }finally{btn.disabled=false;}
}
async function testConnection(){
  if(!editId)throw new Error('Сначала сохраните подключение.');
  $('test-connection').disabled=true;
  $('provider-test-result').textContent='Проверяется настоящий вызов инструмента моделью…';
  $('provider-test-result').className='test-result';
  try{
    const r=await api('/api/assistant/connections/'+encodeURIComponent(editId)+'/test',
      {method:'POST',body:'{}'});
    $('provider-test-result').textContent=r.message;
    $('provider-test-result').className='test-result '+(r.toolCalling?'ok':'error');
    await refreshConnections();
  }finally{$('test-connection').disabled=false;}
}
async function refreshKeys(){const keys=(await api('/api/assistant/keys')).keys;const root=$('key-list');root.replaceChildren();for(const k of keys){const row=element('div','key-row');const info=element('div','',k.name);info.append(element('small','',k.revoked_at?'Отключён':`${k.prefix}… · до ${new Date(k.expires_at).toLocaleDateString('ru-RU')}`));row.append(info);if(!k.revoked_at){const b=element('button','danger','Отозвать');b.type='button';b.addEventListener('click',guarded(async()=>{if(!confirm('Отключить доступ этому боту?'))return;await api('/api/assistant/keys/'+encodeURIComponent(k.id)+'/revoke',{method:'POST',body:'{}'});await refreshKeys();}));row.append(b);}root.append(row);}}
function renderAttachments(){const root=$('attachments');root.replaceChildren();for(const file of attachments){const chip=element('span','file-chip',file.name);const remove=element('button','','×');remove.type='button';remove.setAttribute('aria-label','Не использовать '+file.name);remove.addEventListener('click',()=>{attachments=attachments.filter(x=>x.id!==file.id);renderAttachments();});chip.append(remove);root.append(chip);}}
async function uploadFiles(event){const files=[...event.target.files];event.target.value='';if(files.length>12)throw new Error('За один раз выберите не больше 12 файлов.');for(const file of files){$('run-state').textContent='Загрузка: '+file.name;const form=new FormData();form.append('file',file,file.name);const result=await api('/api/assistant/uploads',{method:'POST',body:form});attachments.push(result);renderAttachments();}$('run-state').textContent='Вложения загружены. Укажите, что с ними сделать.';}
async function sendMessage(event){event.preventDefault();if(busy)return;let message=$('message-input').value.trim();if(!message)return;const connectionId=$('connection-select').value;if(!connectionId){await openSettings();throw new Error('Подключите модель для чата.');}if(!threadId)await newThread();if(attachments.length)message+='\n\nВложения к моему сообщению (используй uploadId через publikator_attach_uploaded_media):\n'+attachments.map(a=>`${a.name}; uploadId=${a.id}; тип=${a.mimeType}; размер=${a.sizeBytes}`).join('\n');const body={threadId,connectionId,message,allowWrites:$('allow-writes').checked,idempotencyKey:crypto.randomUUID()};setBusy(true);$('run-state').textContent='Запрос принят к выполнению…';try{const run=await api('/api/assistant/runs',{method:'POST',body:JSON.stringify(body)});runId=run.id;$('message-input').value='';attachments=[];renderAttachments();await refreshThreads();void pollRun(runId,++pollEpoch);}catch(error){setBusy(false);$('run-state').textContent='';throw error;}}
async function pollRun(id,epoch){try{while(epoch===pollEpoch){const [run,thread]=await Promise.all([api('/api/assistant/runs/'+encodeURIComponent(id)),api('/api/assistant/threads/'+encodeURIComponent(threadId))]);if(epoch!==pollEpoch)return;renderMessages(thread.messages);$('thread-title').textContent=thread.thread.title;$('run-state').textContent=run.status==='RUNNING'?(toolLabels[run.currentOperation]||run.currentOperation||'Подготовка запроса…'):run.status==='COMPLETED'?'Готово':run.result?.text||({'FAILED':'Запрос завершился ошибкой','CANCELLED':'Запрос остановлен','INTERRUPTED':'Запрос прерван перезапуском сервера'}[run.status]||run.status);if(run.status!=='RUNNING'){setBusy(false);runId=null;await refreshThreads();return;}await new Promise(r=>setTimeout(r,1500));}}catch(error){if(epoch===pollEpoch){setBusy(false);toast(error.message,true);$('run-state').textContent='Связь с сервером прервалась. Обновите диалог для проверки результата.';}}}
$('new-thread').addEventListener('click',guarded(newThread));$('settings-open').addEventListener('click',guarded(openSettings));$('settings-close').addEventListener('click',()=>{$('settings').close();$('new-key').hidden=true;$('new-key-value').value='';});$('settings').addEventListener('close',()=>{$('new-key-value').value='';$('new-key').hidden=true;});$('composer').addEventListener('submit',guarded(sendMessage));$('message-input').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();$('composer').requestSubmit();}});$('file-input').addEventListener('change',guarded(uploadFiles));$('stop-run').addEventListener('click',guarded(async()=>{if(runId){await api('/api/assistant/runs/'+encodeURIComponent(runId)+'/stop',{method:'POST',body:'{}'});$('run-state').textContent='Остановка новых действий…';}}));
$('connection-form').addEventListener('submit',guarded(saveConnection));
$('edit-connection').addEventListener('change',event=>selectConnection(event.target.value));
$('provider-kind').addEventListener('change',()=>{
  const provider=$('provider-kind').value;
  $('provider-url').value=defaults[provider];
  $('provider-key').value='';
  modelPicker.onProviderChange();
});
$('provider-url').addEventListener('change',()=>modelPicker.schedule());
$('provider-url').addEventListener('blur',()=>modelPicker.schedule());
$('provider-key').addEventListener('change',()=>modelPicker.schedule());
$('provider-key').addEventListener('blur',()=>modelPicker.schedule());
$('load-models').addEventListener('click',guarded(()=>modelPicker.discover({quiet:false})));
$('provider-manual-model').addEventListener('change',()=>{
  if($('provider-manual-model').value.trim())modelPicker.message('Используется вручную указанная модель. Проверка инструментов выполняется после сохранения.','info');
});
$('test-connection').addEventListener('click',guarded(testConnection));
$('delete-connection').addEventListener('click',guarded(async()=>{
 if(!editId||!confirm('Удалить это подключение модели?'))return;
 await api('/api/assistant/connections/'+encodeURIComponent(editId),{method:'DELETE'});
 editId=null;await refreshConnections();selectConnection(null);
}));
$('key-form').addEventListener('submit',guarded(async event=>{event.preventDefault();const key=await api('/api/assistant/keys',{method:'POST',body:JSON.stringify({name:$('key-name').value,days:Number($('key-days').value),confirmOwnerAdmin:$('confirm-owner').checked})});$('new-key-value').value=key.token;$('new-key').hidden=false;$('confirm-owner').checked=false;await refreshKeys();}));$('copy-key').addEventListener('click',guarded(async()=>{await navigator.clipboard.writeText($('new-key-value').value);toast('Ключ скопирован.');}));$('hide-key').addEventListener('click',()=>{$('new-key-value').value='';$('new-key').hidden=true;});$('reload-actions').addEventListener('click',guarded(async()=>{const r=await api('/api/assistant/actions');$('actions-list').replaceChildren(...r.events.map(e=>element('div','action-row',`${new Date(e.created_at).toLocaleString('ru-RU')} · ${e.operation} · ${e.status}`)));}));document.querySelectorAll('[data-prompt]').forEach(b=>b.addEventListener('click',()=>{$('message-input').value=b.dataset.prompt;$('message-input').focus();}));
async function boot(){const auth=await api('/api/auth/state');if(!auth.authenticated||auth.mode!=='login'){$('login-notice').hidden=false;$('connection-state').textContent='Требуется вход';return;}statusInfo=await api('/api/assistant/status');$('shell').hidden=false;$('connection-state').textContent=`MCP · ${statusInfo.operationCount} операций`;await Promise.all([refreshConnections(),refreshThreads()]);if(threads.length)await loadThread(threads[0].id);if(!connections.length)$('run-state').textContent='Откройте «Настройки», чтобы подключить модель.';selectConnection(null);}
void boot().catch(error=>toast(error.message,true));
