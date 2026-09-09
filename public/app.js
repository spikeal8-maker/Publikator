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
function badge(value) { return `<span class="badge ${esc(value)}">${esc(value)}</span>`; }
function showLogin() { login.classList.remove('hidden'); app.classList.add('hidden'); }
function showApp() { login.classList.add('hidden'); app.classList.remove('hidden'); }
function modal(html) { const el=document.createElement('div'); el.className='modal'; el.innerHTML=`<div class="modal-card">${html}</div>`; el.addEventListener('click',e=>{if(e.target===el)el.remove()}); document.body.append(el); return el; }

async function bootstrap() {
  try { await api('/api/dashboard'); showApp(); await loadProjects(); await render('dashboard'); } catch { showLogin(); }
}
async function loadProjects(){ projects=await api('/api/projects'); }

document.querySelector('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  document.querySelector('#login-error').textContent='';
  try { await api('/api/auth/login',{method:'POST',body:JSON.stringify({password:document.querySelector('#password').value})}); showApp(); await loadProjects(); await render('dashboard'); }
  catch(err){ document.querySelector('#login-error').textContent=err.message; }
});
document.querySelector('#logout').addEventListener('click', async()=>{ await api('/api/auth/logout',{method:'POST'}).catch(()=>{}); showLogin(); });
document.querySelectorAll('.nav[data-view]').forEach(btn=>btn.addEventListener('click',async()=>{ document.querySelectorAll('.nav').forEach(x=>x.classList.remove('active')); btn.classList.add('active'); await render(btn.dataset.view); }));

async function render(name){
  const names={dashboard:'Обзор',posts:'Контент',accounts:'Соцсети',schedules:'Расписание',events:'Журнал',backups:'Резервные копии'}; title.textContent=names[name]||name;
  view.innerHTML='<div class="muted">Загрузка…</div>';
  try { if(name==='dashboard') await dashboard(); if(name==='posts') await posts(); if(name==='accounts') await accounts(); if(name==='schedules') await schedules(); if(name==='events') await events(); if(name==='backups') await backups(); }
  catch(err){ view.innerHTML=`<div class="card error">${esc(err.message)}</div>`; }
}
async function dashboard(){
  const data=await api('/api/dashboard'); const map=Object.fromEntries(data.counts.map(x=>[x.status,x.count]));
  view.innerHTML=`<div class="grid"><div class="card metric">Черновики<strong>${map.DRAFT||0}</strong></div><div class="card metric">Готовы<strong>${map.READY||0}</strong></div><div class="card metric">Опубликованы<strong>${map.PUBLISHED||0}</strong></div><div class="card metric">Проблемы<strong>${(map.FAILED||0)+(map.PARTIAL||0)}</strong></div></div><h2>Последние события</h2>${eventsTable(data.recentEvents)}`;
}
function eventsTable(rows){return `<table class="table"><thead><tr><th>Время</th><th>Событие</th><th>Сообщение</th></tr></thead><tbody>${rows.map(x=>`<tr><td class="small">${esc(new Date(x.created_at).toLocaleString())}</td><td>${esc(x.event_type)}</td><td class="${x.level==='error'?'event-error':''}">${esc(x.message)}</td></tr>`).join('')||'<tr><td colspan="3">Пока пусто</td></tr>'}</tbody></table>`;}
async function posts(){
  const rows=await api('/api/posts');
  view.innerHTML=`<div class="toolbar"><div class="muted">Пост без изображения нельзя перевести в READY.</div><button id="new-post" class="primary">+ Новый пост</button></div><table class="table"><thead><tr><th>Пост</th><th>Проект</th><th>Медиа</th><th>Режим</th><th>Статус</th><th></th></tr></thead><tbody>${rows.map(p=>`<tr><td><strong>${esc(p.title)}</strong><div class="small muted">${esc(p.body.slice(0,100))}</div></td><td>${esc(p.project_name)}</td><td>${p.media_count}</td><td>${esc(p.schedule_mode)}</td><td>${badge(p.status)}</td><td><button class="secondary open-post" data-id="${p.id}">Открыть</button></td></tr>`).join('')||'<tr><td colspan="6">Публикаций пока нет</td></tr>'}</tbody></table>`;
  document.querySelector('#new-post').onclick=()=>postEditor();
  document.querySelectorAll('.open-post').forEach(b=>b.onclick=()=>postEditor(b.dataset.id));
}
async function postEditor(postId){
  const post=postId?await api(`/api/posts/${postId}`):null;
  const m=modal(`<h2>${post?'Публикация':'Новый пост'}</h2><form id="post-form" class="form-grid"><label>Проект<select name="projectId">${projects.map(p=>`<option value="${p.id}" ${post?.project_id===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select></label><label>Режим<select name="scheduleMode"><option value="MANUAL">Вручную</option><option value="QUEUE" ${post?.schedule_mode==='QUEUE'?'selected':''}>Очередь</option><option value="AT" ${post?.schedule_mode==='AT'?'selected':''}>По дате</option></select></label><label class="full">Заголовок<input name="title" value="${esc(post?.title||'')}" required></label><label class="full">Текст<textarea name="body" required>${esc(post?.body||'')}</textarea></label><label class="full">Дата/время для AT<input name="scheduledAt" type="datetime-local"></label><div class="full"><strong>Изображения</strong><div class="media-list">${(post?.media||[]).map(x=>`<img src="/public-media/${x.relative_path}">`).join('')}</div>${post?'<input id="media-file" type="file" accept="image/*">':'<div class="muted small">Сначала сохраните пост, затем добавьте изображение.</div>'}</div><div class="full row-actions"><button class="primary" type="submit">Сохранить</button>${post?'<button type="button" id="mark-ready" class="secondary">Готов к публикации</button><button type="button" id="publish-now" class="secondary">Опубликовать сейчас</button>':''}<button type="button" id="close-modal" class="secondary">Закрыть</button></div></form><div id="post-error" class="error"></div>${post?targetsHtml(post.targets):''}`);
  m.querySelector('#close-modal').onclick=()=>m.remove();
  const form=m.querySelector('#post-form'); form.onsubmit=async e=>{e.preventDefault();try{const f=new FormData(form);const payload={projectId:f.get('projectId'),title:f.get('title'),body:f.get('body'),scheduleMode:f.get('scheduleMode'),scheduledAt:f.get('scheduledAt')||null}; if(post) await api(`/api/posts/${post.id}`,{method:'PATCH',body:JSON.stringify(payload)}); else await api('/api/posts',{method:'POST',body:JSON.stringify(payload)}); m.remove(); await posts();}catch(err){m.querySelector('#post-error').textContent=err.message;}};
  if(post){
    m.querySelector('#media-file').onchange=async e=>{try{const file=e.target.files[0];if(!file)return;const data=new FormData();data.set('file',file);await api(`/api/posts/${post.id}/media`,{method:'POST',body:data});m.remove();await postEditor(post.id);}catch(err){m.querySelector('#post-error').textContent=err.message;}};
    m.querySelector('#mark-ready').onclick=async()=>{try{await api(`/api/posts/${post.id}/ready`,{method:'POST'});m.remove();await posts();}catch(err){m.querySelector('#post-error').textContent=err.message;}};
    m.querySelector('#publish-now').onclick=async()=>{try{m.querySelector('#post-error').textContent='Публикация…';await api(`/api/posts/${post.id}/publish-now`,{method:'POST'});m.remove();await posts();}catch(err){m.querySelector('#post-error').textContent=err.message;}};
    m.querySelectorAll('.retry-target').forEach(b=>b.onclick=async()=>{try{await api(`/api/targets/${b.dataset.id}/retry`,{method:'POST'});m.remove();await postEditor(post.id);}catch(err){m.querySelector('#post-error').textContent=err.message;}});
  }
}
function targetsHtml(targets=[]){return `<h3>Площадки</h3><table class="table"><thead><tr><th>Площадка</th><th>Статус</th><th>Попытки</th><th>Ошибка</th><th></th></tr></thead><tbody>${targets.map(t=>`<tr><td>${esc(t.platform)} / ${esc(t.account_name)}</td><td>${badge(t.state)}</td><td>${t.attempts}</td><td class="small error">${esc(t.last_error||'')}</td><td>${['FAILED','RETRY','RECOVERY_NEEDED'].includes(t.state)?`<button class="secondary retry-target" data-id="${t.id}">Повторить</button>`:''}</td></tr>`).join('')||'<tr><td colspan="5">Цели появятся после READY</td></tr>'}</tbody></table>`;}
async function accounts(){
  const rows=await api('/api/accounts'); view.innerHTML=`<div class="toolbar"><div class="muted">Секреты хранятся в SQLite только в зашифрованном виде.</div><button id="new-account" class="primary">+ Подключить</button></div><table class="table"><thead><tr><th>Площадка</th><th>Название</th><th>Включено</th></tr></thead><tbody>${rows.map(a=>`<tr><td>${esc(a.platform)}</td><td>${esc(a.name)}</td><td>${a.enabled?'Да':'Нет'}</td></tr>`).join('')||'<tr><td colspan="3">Нет подключений</td></tr>'}</tbody></table>`;
  document.querySelector('#new-account').onclick=()=>accountEditor();
}
function accountEditor(){const m=modal(`<h2>Подключить соцсеть</h2><form id="account-form" class="form-grid"><label>Площадка<select name="platform"><option>telegram</option><option>vk</option><option>max</option><option>instagram</option></select></label><label>Название<input name="name" required placeholder="ASSA Lab"></label><label class="full">Параметры JSON<textarea name="credentials" required>{\n  \"botToken\": \"\",\n  \"chatId\": \"\"\n}</textarea></label><div class="full muted small">Telegram: botToken, chatId. VK: accessToken, groupId, apiVersion. MAX: accessToken, chatId. Instagram: accessToken, igUserId, graphVersion.</div><div class="full row-actions"><button class="primary">Сохранить</button><button type="button" id="close-modal" class="secondary">Закрыть</button></div></form><div id="account-error" class="error"></div>`);m.querySelector('#close-modal').onclick=()=>m.remove();m.querySelector('#account-form').onsubmit=async e=>{e.preventDefault();try{const f=new FormData(e.target);await api('/api/accounts',{method:'POST',body:JSON.stringify({platform:f.get('platform'),name:f.get('name'),credentials:JSON.parse(f.get('credentials'))})});m.remove();await accounts();}catch(err){m.querySelector('#account-error').textContent=err.message;}};}
async function schedules(){const rows=await api('/api/schedules');view.innerHTML=`<div class="toolbar"><div class="muted">Слоты забирают следующий READY-пост с режимом QUEUE.</div><button id="new-slot" class="primary">+ Слот</button></div><table class="table"><thead><tr><th>Проект</th><th>День</th><th>Время</th><th>Timezone</th><th>Последний запуск</th></tr></thead><tbody>${rows.map(s=>`<tr><td>${esc(s.project_name)}</td><td>${s.weekday}</td><td>${esc(s.time_hhmm)}</td><td>${esc(s.timezone)}</td><td>${esc(s.last_fired_on||'—')}</td></tr>`).join('')||'<tr><td colspan="5">Нет слотов</td></tr>'}</tbody></table>`;document.querySelector('#new-slot').onclick=()=>slotEditor();}
function slotEditor(){const m=modal(`<h2>Новый слот</h2><form id="slot-form" class="form-grid"><label>Проект<select name="projectId">${projects.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label><label>День недели<select name="weekday"><option value="1">Пн</option><option value="2">Вт</option><option value="3">Ср</option><option value="4">Чт</option><option value="5">Пт</option><option value="6">Сб</option><option value="0">Вс</option></select></label><label>Время<input name="time" type="time" required value="18:00"></label><label>Timezone<input name="timezone" value="Europe/Moscow"></label><div class="full row-actions"><button class="primary">Создать</button><button type="button" id="close-modal" class="secondary">Закрыть</button></div></form><div id="slot-error" class="error"></div>`);m.querySelector('#close-modal').onclick=()=>m.remove();m.querySelector('#slot-form').onsubmit=async e=>{e.preventDefault();try{const f=new FormData(e.target);await api('/api/schedules',{method:'POST',body:JSON.stringify({projectId:f.get('projectId'),weekday:Number(f.get('weekday')),time:f.get('time'),timezone:f.get('timezone')})});m.remove();await schedules();}catch(err){m.querySelector('#slot-error').textContent=err.message;}};}
async function events(){const rows=await api('/api/events?limit=150');view.innerHTML=eventsTable(rows);}
async function backups(){const rows=await api('/api/backups');view.innerHTML=`<div class="toolbar"><div class="muted">SQLite backup создаётся штатным API базы.</div><button id="make-backup" class="primary">Создать копию</button></div><div class="card">${rows.map(x=>`<div>${esc(x)}</div>`).join('')||'Копий пока нет'}</div>`;document.querySelector('#make-backup').onclick=async()=>{await api('/api/backups',{method:'POST'});await backups();};}
bootstrap();
