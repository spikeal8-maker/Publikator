import { scheduleModeLabel, statusLabel } from './presentation-labels.js';
import { mountRichTextEditor, plainTextToRichDocument } from './rich-text-editor-v1.js';

const login = document.querySelector('#login');
const app = document.querySelector('#app');
const view = document.querySelector('#view');
const title = document.querySelector('#page-title');
let projects = [];

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { ...(options.body instanceof FormData ? {} : {'content-type':'application/json'}), ...(options.headers || {}) } });
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (response.status === 401) { showLogin(); throw new Error('Требуется вход'); }
  if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
  return body;
}
function esc(value='') { return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function badge(value, owner='app') { const raw=String(value??''); return `<span class="badge ${esc(raw)}" data-raw-status="${esc(raw)}" data-presentation-owner="${esc(owner)}">${esc(statusLabel(raw))}</span>`; }
function platformLabel(value){return ({telegram:'Telegram',vk:'VK',max:'MAX',instagram:'Instagram'})[String(value)]||String(value);}
function editorVersion(form){const value=Number(form.dataset.contentVersion);if(!Number.isInteger(value)||value<1)throw new Error('Версия поста не загружена');return value;}
function setEditorVersion(form,value){form.dataset.contentVersion=String(value);}
async function scheduleApi(url,method,payload){try{return await api(url,{method,body:JSON.stringify(payload)});}catch(err){const m=String(err.message||'').match(/Local time is ambiguous; choose one offset: (.+)$/);if(!m)throw err;const choices=m[1].split(',').map(x=>x.trim()).filter(Boolean);const chosen=window.prompt(`Это местное время встречается дважды из-за перехода часов. Выберите UTC offset: ${choices.join(' или ')}`,choices[0]||'');if(!chosen||!choices.includes(chosen))throw new Error('Для неоднозначного времени нужно выбрать один из предложенных UTC offset');return await api(url,{method,body:JSON.stringify({...payload,ambiguousOffset:chosen})});}}
function showLogin() { login.classList.remove('hidden'); app.classList.add('hidden'); }
function showApp() { login.classList.add('hidden'); app.classList.remove('hidden'); }
function modal(html) { const el=document.createElement('div'); el.className='modal'; el.innerHTML=`<div class="modal-card">${html}</div>`; el.addEventListener('click',e=>{if(e.target===el)el.remove()}); document.body.append(el); return el; }

async function bootstrap() {
  try { await api('/api/dashboard'); showApp(); await loadProjects(); } catch { showLogin(); }
}
async function loadProjects(){ projects=await api('/api/projects'); }

document.querySelector('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  document.querySelector('#login-error').textContent='';
  try { await api('/api/auth/login',{method:'POST',body:JSON.stringify({password:document.querySelector('#password').value})}); showApp(); await loadProjects(); }
  catch(err){ document.querySelector('#login-error').textContent=err.message; }
});
document.querySelector('#logout').addEventListener('click', async()=>{ await api('/api/auth/logout',{method:'POST'}).catch(()=>{}); showLogin(); });
document.querySelectorAll('.nav[data-view]').forEach(btn=>btn.addEventListener('click',async()=>{ document.querySelectorAll('.nav').forEach(x=>x.classList.remove('active')); btn.classList.add('active'); await render(btn.dataset.view); }));

async function render(name){
  const names={dashboard:'Обзор',posts:'Контент',projects:'Проекты',accounts:'Соцсети',schedules:'Расписание',events:'Журнал',backups:'Резервные копии'}; title.textContent=names[name]||name;
  view.innerHTML='<div class="muted">Загрузка…</div>';
  try { if(name==='dashboard') await dashboard(); if(name==='posts') await posts(); if(name==='projects') await projectsPage(); if(name==='accounts') await accounts(); if(name==='schedules') await schedules(); if(name==='events') await events(); if(name==='backups') await backups(); }
  catch(err){ view.innerHTML=`<div class="card error">${esc(err.message)}</div>`; }
}
async function dashboard(){
  const data=await api('/api/dashboard'); const map=Object.fromEntries(data.counts.map(x=>[x.status,x.count]));
  view.innerHTML=`<div class="grid"><div class="card metric">Черновики<strong>${map.DRAFT||0}</strong></div><div class="card metric">Готовы<strong>${map.READY||0}</strong></div><div class="card metric">Опубликованы<strong>${map.PUBLISHED||0}</strong></div><div class="card metric">Проблемы<strong>${(map.FAILED||0)+(map.PARTIAL||0)}</strong></div></div><h2>Последние события</h2>${eventsTable(data.recentEvents)}`;
}
function eventsTable(rows){return `<table class="table"><thead><tr><th>Время</th><th>Событие</th><th>Сообщение</th></tr></thead><tbody>${rows.map(x=>`<tr><td class="small">${esc(new Date(x.created_at).toLocaleString())}</td><td>${esc(x.event_type)}</td><td class="${x.level==='error'?'event-error':''}">${esc(x.message)}</td></tr>`).join('')||'<tr><td colspan="3">Пока пусто</td></tr>'}</tbody></table>`;}
async function posts(){
  const rows=await api('/api/posts');
  view.innerHTML=`<div class="toolbar"><div class="muted">READY доступен после проверки текста, формата, медиа и выбранных площадок.</div><button id="new-post" class="primary">+ Новый пост</button></div><table class="table"><thead><tr><th>Пост</th><th>Проект</th><th>Медиа</th><th>Режим</th><th>Статус</th><th></th></tr></thead><tbody>${rows.map(p=>`<tr><td><strong>${esc(p.title)}</strong><div class="small muted">${esc(p.body.slice(0,100))}</div></td><td>${esc(p.project_name)}</td><td>${p.media_count}</td><td data-raw-schedule="${esc(p.schedule_mode)}">${esc(scheduleModeLabel(p.schedule_mode))}</td><td>${badge(p.status,'content')}</td><td><button class="secondary open-post" data-id="${p.id}">Открыть</button></td></tr>`).join('')||'<tr><td colspan="6">Публикаций пока нет</td></tr>'}</tbody></table>`;
  document.querySelector('#new-post').onclick=()=>postEditor();
  document.querySelectorAll('.open-post').forEach(b=>b.onclick=()=>postEditor(b.dataset.id));
}
function editorSectionHtml(titleText,note,index){return `<div class="ui-editor-section-title full"><span>${esc(index)}</span><div><strong>${esc(titleText)}</strong><small>${esc(note)}</small></div></div>`;}
function syncPostEditorScheduleField(form){const mode=form.querySelector('select[name="scheduleMode"]');const input=form.querySelector('input[name="scheduledAt"]');const label=input?.closest('label');if(!mode||!label)return;const sync=()=>label.classList.toggle('hidden',mode.value!=='AT');mode.addEventListener('change',sync);sync();}

const REUSABLE_BLOCK_TYPES=['SNIPPET','CTA','SIGNATURE','HASHTAG_SET'];
const REUSABLE_BLOCK_LABELS={SNIPPET:'Фрагменты',CTA:'CTA',SIGNATURE:'Подписи',HASHTAG_SET:'Хэштеги'};
function reusableBlockPickerHtml(){return `<div class="full"><div class="row-actions"><button id="toggle-reusable-blocks" class="secondary" type="button">Вставить заготовку</button></div><div id="reusable-block-picker" class="card hidden" style="margin-top:8px"><label class="full">Заготовка<select id="reusable-block-select"></select></label><div class="row-actions" style="margin-top:8px"><button id="apply-reusable-block" class="primary" type="button">Вставить</button></div></div></div>`;}
function renderReusableBlockSelect(form,blocks){
  const projectId=String(form.querySelector('select[name="projectId"]')?.value||'');
  const select=form.querySelector('#reusable-block-select');
  const apply=form.querySelector('#apply-reusable-block');
  const groups=[];
  for(const type of REUSABLE_BLOCK_TYPES){
    const rows=blocks.filter((block)=>block.templateType===type&&block.projectId===projectId);
    if(!rows.length)continue;
    groups.push(`<optgroup label="${esc(REUSABLE_BLOCK_LABELS[type])}">${rows.map((block)=>`<option value="${esc(block.id)}">${esc(block.name)}</option>`).join('')}</optgroup>`);
  }
  select.innerHTML=groups.join('')||'<option value="">Нет заготовок для этого проекта</option>';
  select.disabled=!groups.length;
  apply.disabled=!groups.length;
}
function sameStringSet(left,right){
  const a=[...new Set(left)].sort();
  const b=[...new Set(right)].sort();
  return a.length===b.length&&a.every((value,index)=>value===b[index]);
}
function exactToLocalInput(value){
  if(!value)return '';
  const date=new Date(value);
  if(Number.isNaN(date.getTime()))return '';
  const pad=(part)=>String(part).padStart(2,'0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}


const CONTENT_FORMATS_BY_KIND={
  FEED:['TEXT_ONLY','IMAGE','CAROUSEL','VIDEO'],
  SHORT:['VERTICAL_VIDEO'],
  STORY:['IMAGE','VERTICAL_VIDEO','STORY_SEQUENCE']
};
const CONTENT_FORMAT_LABELS={
  TEXT_ONLY:'Только текст',IMAGE:'Изображение',CAROUSEL:'Карусель',VIDEO:'Видео',
  VERTICAL_VIDEO:'Вертикальное видео',STORY_SEQUENCE:'Серия историй'
};
function publicationKindOptions(selected){
  return [['FEED','Пост / FEED'],['SHORT','Короткое видео / SHORT'],['STORY','История / STORY']]
    .map(function(item){return '<option value="'+item[0]+'" '+(selected===item[0]?'selected':'')+'>'+item[1]+'</option>';}).join('');
}
function contentFormatOptions(selected){
  return Object.keys(CONTENT_FORMAT_LABELS).map(function(value){
    return '<option value="'+value+'" '+(selected===value?'selected':'')+'>'+CONTENT_FORMAT_LABELS[value]+'</option>';
  }).join('');
}
function syncPublicationCompositionFields(form){
  const kind=form.querySelector('select[name="publicationKind"]');
  const format=form.querySelector('select[name="contentFormat"]');
  if(!kind||!format)return;
  const sync=function(){
    const allowed=CONTENT_FORMATS_BY_KIND[kind.value]||[];
    [...format.options].forEach(function(option){
      const active=allowed.includes(option.value);
      option.disabled=!active;
      option.hidden=!active;
    });
    if(!allowed.includes(format.value))format.value=allowed[0]||'IMAGE';
  };
  kind.addEventListener('change',sync);
  sync();
}
async function postEditor(postId,options={}){
  window.dispatchEvent(new CustomEvent('publikator:post-editor-opening',{detail:{postId:postId||null}}));
  const post=postId?await api(`/api/posts/${postId}`):null;
  const prefill=!post&&options&&typeof options==='object'?options:{};
  const initialScheduleMode=post?.schedule_mode||prefill.scheduleMode||'MANUAL';
  const initialExactScheduledAt=!post&&typeof prefill.scheduledAt==='string'?prefill.scheduledAt:'';
  const initialScheduledLocal=initialExactScheduledAt?exactToLocalInput(initialExactScheduledAt):'';
  const [accounts,templateLibrary]=await Promise.all([
    post?api('/api/accounts'):Promise.resolve([]),
    api('/api/templates')
  ]);
  const reusableBlocks=templateLibrary.filter((template)=>REUSABLE_BLOCK_TYPES.includes(template.templateType));
  const selectedAccountIds=new Set((post?.targets||[]).filter((target)=>Boolean(target.enabled)).map((target)=>target.account_id));
  const initialTargetAccountIds=[...selectedAccountIds];
  const initialRichDocument=post?.bodyRich || plainTextToRichDocument(post?.body || '');
  const m=modal(`<h2>${post?'Публикация':'Новая публикация'}</h2><form id="post-form" class="form-grid ui-post-form" data-content-version="${post?.content_version||''}">${editorSectionHtml('Основное','Проект, режим публикации, заголовок и текст.','1')}<label>Проект<select name="projectId">${projects.map(p=>`<option value="${p.id}" ${post?.project_id===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select></label><label>Когда публиковать<select name="scheduleMode"><option value="MANUAL" ${initialScheduleMode==='MANUAL'?'selected':''}>${esc(scheduleModeLabel('MANUAL'))}</option><option value="QUEUE" ${initialScheduleMode==='QUEUE'?'selected':''}>${esc(scheduleModeLabel('QUEUE'))}</option><option value="AT" ${initialScheduleMode==='AT'?'selected':''}>${esc(scheduleModeLabel('AT'))}</option></select></label><label>Тип публикации<select name="publicationKind">${publicationKindOptions(post?.publication_kind||prefill.publicationKind||'FEED')}</select></label><label>Формат<select name="contentFormat">${contentFormatOptions(post?.content_format||prefill.contentFormat||'IMAGE')}</select></label><label class="full">Заголовок<input name="title" value="${esc(post?.title||'')}" required></label><div class="full rich-text-field"><span class="rich-text-label">Текст</span><div data-rich-text-editor></div><textarea name="body" class="rich-text-plain-fallback" hidden aria-hidden="true"></textarea></div>${reusableBlockPickerHtml()}${editorSectionHtml('Внутренние данные','Эти поля нужны редакции и никогда не отправляются в соцсети.','2')}<label>Кампания<input name="campaign" value="${esc(post?.campaign||'')}" placeholder="Например: Осень 2026"></label><label>Теги<input name="tags" value="${esc((post?.tags||[]).join(', '))}" placeholder="школа, робототехника, сентябрь"></label><label class="full">Редакторская заметка<textarea name="editorNote" rows="2" placeholder="Что проверить перед публикацией">${esc(post?.editor_note||'')}</textarea></label><label class="full">Заметка источника<textarea name="sourceNote" rows="2" placeholder="Откуда материал / контекст">${esc(post?.source_note||'')}</textarea></label><label class="full${initialScheduleMode==='AT'?'':' hidden'}" data-scheduled-field>Дата и время публикации<input name="scheduledAt" type="datetime-local" value="${esc(initialScheduledLocal)}"></label>${post?editorSectionHtml('Медиа','Добавьте изображения или видео и проверьте порядок файлов.','2'):editorSectionHtml('После сохранения','Сначала сохраните черновик — затем появятся загрузка медиа и выбор площадок.','2')}<div class="full"><strong>Медиа</strong><div class="media-list">${(post?.media||[]).map(x=>`<span><img src="/public-media/${x.relative_path}"><button type="button" class="secondary danger delete-media" data-id="${x.id}">Удалить</button></span>`).join('')}</div>${post?'<input id="media-file" type="file" accept="image/*">':'<div class="muted small">Сохраните черновик. После этого можно загрузить медиа и выбрать площадки.</div>'}}</div>${post?`${editorSectionHtml('Площадки','Выберите подключения, куда должна уйти публикация.','3')}<div class="full"><strong>Куда публиковать</strong><div class="target-picker">${accounts.map(a=>`<label class="target-check"><input type="checkbox" name="accountId" value="${a.id}" ${selectedAccountIds.has(a.id)?'checked':''} ${a.enabled?'':'disabled'}> ${esc(platformLabel(a.platform))} · ${esc(a.name)}${a.enabled?'':' · отключено'}</label>`).join('')||'<span class="muted">Сначала подключите соцсеть</span>'}</div></div>`:''}<div class="full row-actions"><button class="primary" type="submit">Сохранить</button>${post?'<button type="button" id="mark-ready" class="secondary">Готов к публикации</button><button type="button" id="publish-now" class="secondary">Опубликовать сейчас</button>':''}<button type="button" id="close-modal" class="secondary">Закрыть</button></div></form><div id="post-error" class="error"></div>${post?targetsHtml(post.targets):''}`);
  m.querySelector('#close-modal').onclick=()=>m.remove();
  const form=m.querySelector('#post-form');
  form.dataset.exactScheduledAt=initialExactScheduledAt;
  const scheduledInput=form.querySelector('input[name="scheduledAt"]');
  scheduledInput?.addEventListener('input',()=>{form.dataset.exactScheduledAt='';});
  const bodyFallback=form.querySelector('textarea[name="body"]');
  const richEditor=mountRichTextEditor(form.querySelector('[data-rich-text-editor]'),{
    document:initialRichDocument,
    onChange:(documentValue,plain)=>{
      bodyFallback.value=plain;
      bodyFallback.dispatchEvent(new Event('input',{bubbles:true}));
    }
  });
  const projectSelect=form.querySelector('select[name="projectId"]');
  const blockPicker=form.querySelector('#reusable-block-picker');
  const refreshReusableBlocks=()=>renderReusableBlockSelect(form,reusableBlocks);
  projectSelect.addEventListener('change',refreshReusableBlocks);
  refreshReusableBlocks();
  form.querySelector('#toggle-reusable-blocks').onclick=()=>blockPicker.classList.toggle('hidden');
  form.querySelector('#apply-reusable-block').onclick=()=>{
    const blockId=String(form.querySelector('#reusable-block-select').value||'');
    const block=reusableBlocks.find((item)=>item.id===blockId&&item.projectId===String(projectSelect.value));
    if(!block)return;
    richEditor.insertDocument(block.bodyRich);
    blockPicker.classList.add('hidden');
    richEditor.focus();
  };
  syncPostEditorScheduleField(form);
  syncPublicationCompositionFields(form);
  const saveDraft=async()=>{
    const f=new FormData(form);
    const scheduleMode=String(f.get('scheduleMode')||'MANUAL');
    const tags=String(f.get('tags')||'').split(/[;,]/).map(x=>x.trim()).filter(Boolean);
    const payload={projectId:f.get('projectId'),title:f.get('title'),body:f.get('body'),bodyRich:richEditor.getDocument(),scheduleMode,
      publicationKind:f.get('publicationKind'),contentFormat:f.get('contentFormat'),
      campaign:f.get('campaign'),tags,editorNote:f.get('editorNote'),sourceNote:f.get('sourceNote')};
    if(scheduleMode==='AT'){
      const exactScheduledAt=String(form.dataset.exactScheduledAt||'');
      if(exactScheduledAt)payload.scheduledAt=exactScheduledAt;
      else payload.scheduledAtLocal=f.get('scheduledAt')||null;
    }
    if(post) payload.scheduleTimezone=post.schedule_timezone||Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';
    if(post?.schedule_mode==='QUEUE'&&payload.scheduleMode==='AT')payload.confirmQueueToAt=window.confirm('Преобразовать публикацию из очереди в точное время?');
    if(post){
      payload.expectedContentVersion=editorVersion(form);
      const patched=await scheduleApi(`/api/posts/${post.id}`,'PATCH',payload);
      setEditorVersion(form,patched.contentVersion);
      post.content_version=patched.contentVersion;
      const accountIds=[...form.querySelectorAll('input[name="accountId"]:checked')].map(x=>x.value);
      if(!sameStringSet(accountIds,initialTargetAccountIds)){
        const targeted=await api(`/api/posts/${post.id}/targets`,{method:'PUT',body:JSON.stringify({accountIds,expectedContentVersion:editorVersion(form)})});
        setEditorVersion(form,targeted.contentVersion);
        post.content_version=targeted.contentVersion;
      }
      return post.id;
    }
    const created=await scheduleApi('/api/posts','POST',payload);
    return created.id;
  };
  form.publikatorSaveDraft=saveDraft;
  form.onsubmit=async e=>{e.preventDefault();try{const savedId=await saveDraft();m.remove();if(typeof options.afterSave==='function')await options.afterSave(savedId);else await posts();}catch(err){m.querySelector('#post-error').textContent=err.message;}};
  if(post){
    m.querySelector('#media-file').onchange=async e=>{try{const file=e.target.files[0];if(!file)return;const data=new FormData();data.set('file',file);const uploaded=await api(`/api/posts/${post.id}/media`,{method:'POST',body:data,headers:{'x-content-version':String(editorVersion(form))}});setEditorVersion(form,uploaded.contentVersion);post.content_version=uploaded.contentVersion;m.remove();await postEditor(post.id);}catch(err){m.querySelector('#post-error').textContent=err.message;}};
    m.querySelector('#mark-ready').onclick=async()=>{try{await saveDraft();const ready=await api(`/api/posts/${post.id}/ready`,{method:'POST',body:JSON.stringify({expectedContentVersion:editorVersion(form)})});setEditorVersion(form,ready.contentVersion);post.content_version=ready.contentVersion;m.remove();await posts();}catch(err){m.querySelector('#post-error').textContent=err.message;}};
    m.querySelector('#publish-now').onclick=async()=>{try{m.querySelector('#post-error').textContent='Публикация…';await saveDraft();const ready=await api(`/api/posts/${post.id}/ready`,{method:'POST',body:JSON.stringify({expectedContentVersion:editorVersion(form)})});setEditorVersion(form,ready.contentVersion);post.content_version=ready.contentVersion;await api(`/api/posts/${post.id}/publish-now`,{method:'POST'});m.remove();await posts();}catch(err){m.querySelector('#post-error').textContent=err.message;}};
    m.querySelectorAll('.delete-media').forEach(b=>b.onclick=async()=>{try{const deleted=await api(`/api/media/${b.dataset.id}`,{method:'DELETE',headers:{'x-content-version':String(editorVersion(form))}});setEditorVersion(form,deleted.contentVersion);post.content_version=deleted.contentVersion;m.remove();await postEditor(post.id);}catch(err){m.querySelector('#post-error').textContent=err.message;}});
    m.querySelectorAll('.retry-target').forEach(b=>b.onclick=async()=>{try{await api(`/api/targets/${b.dataset.id}/retry`,{method:'POST'});m.remove();await postEditor(post.id);}catch(err){m.querySelector('#post-error').textContent=err.message;}});
  }
}
window.publikatorPostEditor=postEditor;
function targetsHtml(targets=[]){return `<h3>Площадки</h3><table class="table"><thead><tr><th>Площадка</th><th>Статус</th><th>Попытки</th><th>Ошибка</th><th></th></tr></thead><tbody>${targets.map(t=>`<tr><td>${esc(t.platform)} / ${esc(t.account_name)}</td><td>${badge(t.state)}</td><td>${t.attempts}</td><td class="small error">${esc(t.last_error||'')}</td><td>${['FAILED','RETRY','RECOVERY_NEEDED'].includes(t.state)?`<button class="secondary retry-target" data-id="${t.id}">Повторить</button>`:''}</td></tr>`).join('')||'<tr><td colspan="5">Цели появятся после READY</td></tr>'}</tbody></table>`;}
async function projectsPage(){
  await loadProjects();
  const accounts=await api('/api/accounts');
  const accountsById=new Map(accounts.map((account)=>[account.id,account]));
  const targetsCell=(project)=>{
    const items=(project.defaultTargetAccountIds||[]).map((accountId)=>accountsById.get(accountId)).filter(Boolean);
    return items.length?items.map((account)=>`<div>${esc(platformLabel(account.platform))} / ${esc(account.name)}</div>`).join(''):'<span class="muted">Не выбраны</span>';
  };
  view.innerHTML=`<div class="toolbar"><div class="muted">Проекты разделяют независимые контентные очереди.</div><button id="new-project" class="primary">+ Проект</button></div><table class="table"><thead><tr><th>Название</th><th>Slug</th><th>Часовой пояс</th><th>Площадки по умолчанию</th><th>Действие</th></tr></thead><tbody>${projects.map(p=>`<tr><td><strong>${esc(p.name)}</strong></td><td>${esc(p.slug)}</td><td>${esc(p.default_timezone||'UTC')}</td><td class="small">${targetsCell(p)}</td><td><button class="secondary project-settings" data-id="${p.id}">Настроить</button></td></tr>`).join('')||'<tr><td colspan="5">Проектов пока нет</td></tr>'}</tbody></table>`;
  document.querySelector('#new-project').onclick=()=>projectEditor();
  document.querySelectorAll('.project-settings').forEach((button)=>button.onclick=()=>projectSettings(button.dataset.id,accounts));
}
function projectEditor(){const m=modal(`<h2>Новый проект</h2><form id="project-form" class="form-grid"><label class="full">Название<input name="name" required placeholder="ASSA Lab"></label><label class="full">Slug<input name="slug" required placeholder="assa-lab"></label><div class="full row-actions"><button class="primary">Создать</button><button type="button" id="close-modal" class="secondary">Закрыть</button></div></form><div id="project-error" class="error"></div>`);m.querySelector('#close-modal').onclick=()=>m.remove();m.querySelector('#project-form').onsubmit=async e=>{e.preventDefault();try{const f=new FormData(e.target);await api('/api/projects',{method:'POST',body:JSON.stringify({name:f.get('name'),slug:f.get('slug')})});await loadProjects();m.remove();await projectsPage();}catch(err){m.querySelector('#project-error').textContent=err.message;}};}
async function projectSettings(projectId,knownAccounts){
  await loadProjects();
  const project=projects.find((item)=>item.id===projectId);
  if(!project)throw new Error('Проект не найден');
  const accounts=knownAccounts||await api('/api/accounts');
  const selected=new Set(project.defaultTargetAccountIds||[]);
  const m=modal(`<h2>Настроить проект</h2><form id="project-settings-form" class="form-grid"><label class="full">Название<input name="name" required value="${esc(project.name)}"></label><label class="full">Timezone<input name="defaultTimezone" required value="${esc(project.default_timezone||'UTC')}" placeholder="Europe/Moscow"></label><div class="full"><div class="toolbar"><strong>Площадки по умолчанию</strong><button type="button" id="select-all-enabled" class="secondary">Выбрать все включённые</button></div><div class="target-picker">${accounts.map((account)=>`<label class="target-check"><input type="checkbox" name="defaultTargetAccountId" value="${account.id}" data-enabled="${account.enabled?1:0}" ${selected.has(account.id)?'checked':''}> ${esc(platformLabel(account.platform))} — ${esc(account.name)}${account.enabled?'':' · отключено'}</label>`).join('')||'<span class="muted">Нет подключённых соцсетей</span>'}</div><div class="muted small" style="margin-top:8px">Можно оставить список пустым. Новые посты наследуют выбранные включённые площадки.</div></div><div class="full row-actions"><button class="primary" type="submit">Сохранить</button><button type="button" id="close-modal" class="secondary">Закрыть</button></div></form><div id="project-error" class="error"></div>`);
  m.querySelector('#close-modal').onclick=()=>m.remove();
  m.querySelector('#select-all-enabled').onclick=()=>{m.querySelectorAll('input[name="defaultTargetAccountId"]').forEach((input)=>{input.checked=input.dataset.enabled==='1';});};
  m.querySelector('#project-settings-form').onsubmit=async(e)=>{
    e.preventDefault();
    try{
      const f=new FormData(e.target);
      const defaultTargetAccountIds=[...m.querySelectorAll('input[name="defaultTargetAccountId"]:checked')].map((input)=>input.value);
      await api(`/api/projects/${project.id}`,{method:'PATCH',body:JSON.stringify({name:f.get('name'),defaultTimezone:f.get('defaultTimezone'),defaultTargetAccountIds})});
      await projectsPage();
      m.remove();
    }catch(err){m.querySelector('#project-error').textContent=err.message;}
  };
}
function credentialFields(platform){
  if(platform==='telegram') return `<label class="full">Bot token<input name="botToken" type="password" required autocomplete="off" placeholder="123456:ABC..."></label><label class="full">Канал / chat_id<input name="chatId" required placeholder="@channel или -100..."></label>`;
  if(platform==='vk') return `<label class="full">Access token<input name="accessToken" type="password" required autocomplete="off"></label><label>Group ID<input name="groupId" required placeholder="123456789"></label><label>API version<input name="apiVersion" required value="5.199"></label>`;
  if(platform==='max') return `<label class="full">Access token<input name="accessToken" type="password" required autocomplete="off"></label><label class="full">Channel / chat ID<input name="chatId" required placeholder="-123456789"></label>`;
  return `<label class="full">Access token<input name="accessToken" type="password" required autocomplete="off"></label><label>Instagram User ID<input name="igUserId" required></label><label>Graph API version<input name="graphVersion" required placeholder="vXX.X"></label>`;
}
function credentialsFromForm(form){const f=new FormData(form);const platform=String(f.get('platform'));if(platform==='telegram')return{botToken:f.get('botToken'),chatId:f.get('chatId')};if(platform==='vk')return{accessToken:f.get('accessToken'),groupId:f.get('groupId'),apiVersion:f.get('apiVersion')};if(platform==='max')return{accessToken:f.get('accessToken'),chatId:f.get('chatId')};return{accessToken:f.get('accessToken'),igUserId:f.get('igUserId'),graphVersion:f.get('graphVersion')};}
async function accounts(){
  const rows=await api('/api/accounts'); view.innerHTML=`<div class="toolbar"><div class="muted">Подключение проверяется официальным API до первой публикации. Секреты хранятся зашифрованно.</div><button id="new-account" class="primary">+ Подключить</button></div><table class="table"><thead><tr><th>Площадка</th><th>Название</th><th>Состояние</th><th></th></tr></thead><tbody>${rows.map(a=>`<tr><td>${esc(a.platform)}</td><td>${esc(a.name)}</td><td>${a.enabled?'<span class="badge PUBLISHED">Включено</span>':'<span class="badge">Отключено</span>'}</td><td class="row-actions"><button class="secondary test-account" data-id="${a.id}">Проверить</button><button class="secondary toggle-account" data-id="${a.id}" data-enabled="${a.enabled?1:0}">${a.enabled?'Отключить':'Включить'}</button></td></tr>`).join('')||'<tr><td colspan="4">Нет подключений</td></tr>'}</tbody></table><div id="accounts-result" class="card muted" style="margin-top:12px">Проверка подключения ничего не публикует.</div>`;
  document.querySelector('#new-account').onclick=()=>accountEditor();
  document.querySelectorAll('.test-account').forEach(b=>b.onclick=async()=>{const out=document.querySelector('#accounts-result');out.textContent='Проверка…';try{const result=await api(`/api/accounts/${b.dataset.id}/test`,{method:'POST'});out.textContent=`✓ ${result.platform}: ${result.identity} → ${result.destination}`;}catch(err){out.classList.add('error');out.textContent=err.message;}});
  document.querySelectorAll('.toggle-account').forEach(b=>b.onclick=async()=>{await api(`/api/accounts/${b.dataset.id}`,{method:'PATCH',body:JSON.stringify({enabled:b.dataset.enabled!=='1'})});await accounts();});
}
function accountEditor(){
  const m=modal(`<h2>Подключить соцсеть</h2><form id="account-form" class="form-grid"><label>Площадка<select name="platform"><option value="telegram">Telegram</option><option value="vk">VK</option><option value="max">MAX</option><option value="instagram">Instagram</option></select></label><label>Название подключения<input name="name" required placeholder="ASSA Lab"></label><div id="credential-fields" class="full form-grid"></div><div class="full muted small">При сохранении Publikator сначала проверит токен, назначение и доступные права через официальный API. Тест ничего не публикует.</div><div class="full row-actions"><button class="primary" type="submit">Проверить и сохранить</button><button type="button" id="test-account-new" class="secondary">Только проверить</button><button type="button" id="close-modal" class="secondary">Закрыть</button></div></form><div id="account-error" class="error"></div><div id="account-ok" class="muted"></div>`);
  const form=m.querySelector('#account-form');const platform=form.querySelector('[name="platform"]');const fields=m.querySelector('#credential-fields');const renderFields=()=>{fields.innerHTML=credentialFields(platform.value);};renderFields();platform.onchange=renderFields;m.querySelector('#close-modal').onclick=()=>m.remove();
  const test=async()=>{const result=await api('/api/accounts/test',{method:'POST',body:JSON.stringify({platform:platform.value,credentials:credentialsFromForm(form)})});m.querySelector('#account-ok').textContent=`✓ ${result.identity} → ${result.destination}`;m.querySelector('#account-error').textContent='';return result;};
  m.querySelector('#test-account-new').onclick=async()=>{try{await test();}catch(err){m.querySelector('#account-error').textContent=err.message;}};
  form.onsubmit=async e=>{e.preventDefault();try{await test();const f=new FormData(form);await api('/api/accounts',{method:'POST',body:JSON.stringify({platform:platform.value,name:f.get('name'),credentials:credentialsFromForm(form)})});m.remove();await accounts();}catch(err){m.querySelector('#account-error').textContent=err.message;}};
}
async function schedules(){const rows=await api('/api/schedules');view.innerHTML=`<div class="toolbar"><div class="muted">Слоты забирают следующий READY-пост с режимом QUEUE.</div><button id="new-slot" class="primary">+ Слот</button></div><table class="table"><thead><tr><th>Проект</th><th>День</th><th>Время</th><th>Timezone</th><th>Последний запуск</th><th></th></tr></thead><tbody>${rows.map(s=>`<tr><td>${esc(s.project_name)}</td><td>${s.weekday}</td><td>${esc(s.time_hhmm)}</td><td>${esc(s.timezone)}</td><td>${esc(s.last_fired_on||'—')}</td><td><button class="secondary danger delete-slot" data-id="${s.id}">Удалить</button></td></tr>`).join('')||'<tr><td colspan="6">Нет слотов</td></tr>'}</tbody></table>`;document.querySelector('#new-slot').onclick=()=>slotEditor();document.querySelectorAll('.delete-slot').forEach(b=>b.onclick=async()=>{await api(`/api/schedules/${b.dataset.id}`,{method:'DELETE'});await schedules();});}
function slotEditor(){const m=modal(`<h2>Новое время публикации</h2><form id="slot-form" class="form-grid"><label>Проект<select name="projectId">${projects.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label><label>День недели<select name="weekday"><option value="1">Пн</option><option value="2">Вт</option><option value="3">Ср</option><option value="4">Чт</option><option value="5">Пт</option><option value="6">Сб</option><option value="0">Вс</option></select></label><label>Время<input name="time" type="time" required value="18:00"></label><label>Часовой пояс<input name="timezone" value="Europe/Moscow"></label><div class="full row-actions"><button class="primary">Добавить</button><button type="button" id="close-modal" class="secondary">Закрыть</button></div></form><div id="slot-error" class="error"></div>`);m.querySelector('#close-modal').onclick=()=>m.remove();m.querySelector('#slot-form').onsubmit=async e=>{e.preventDefault();try{const f=new FormData(e.target);await api('/api/schedules',{method:'POST',body:JSON.stringify({projectId:f.get('projectId'),weekday:Number(f.get('weekday')),time:f.get('time'),timezone:f.get('timezone')})});m.remove();await schedules();}catch(err){m.querySelector('#slot-error').textContent=err.message;}};}
async function events(){const rows=await api('/api/events?limit=150');view.innerHTML=eventsTable(rows);}
async function backups(){const rows=await api('/api/backups');view.innerHTML=`<div class="toolbar"><div class="muted">SQLite backup создаётся штатным API базы.</div><button id="make-backup" class="primary">Создать копию</button></div><div class="card">${rows.map(x=>`<div>${esc(x)}</div>`).join('')||'Копий пока нет'}</div>`;document.querySelector('#make-backup').onclick=async()=>{await api('/api/backups',{method:'POST'});await backups();};}
bootstrap();
