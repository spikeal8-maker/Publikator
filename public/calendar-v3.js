import { sourceLabel, statusLabel } from './presentation-labels.js';

const CALENDAR_MODES = ['month','week','day','agenda'];
const MODE_LABELS = { month:'Месяц', week:'Неделя', day:'День', agenda:'Список' };
const CALENDAR_DISPLAY_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const IMMUTABLE_STATUSES = new Set(['PUBLISHING','PARTIAL','PUBLISHED']);
let calendarMode = 'month';
let calendarAnchor = new Date();
let calendarData = { items: [], queueItems: [] };
let calendarDragPostId = '';
let calendarSuppressClickUntil = 0;
let calendarNoticeMessage = '';
let calendarNoticeError = false;
const calendarSelected = new Set();
let calendarContextMenu = null;

function calEsc(value=''){return String(value).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
async function calApi(url,options={}){
  const response=await fetch(url,{credentials:'same-origin',...options,headers:{...(options.body===undefined?{}:{'content-type':'application/json'}),...(options.headers||{})}});
  const body=response.status===204?null:await response.json().catch(()=>({}));
  if(!response.ok){const error=new Error(body?.error||body?.message||`HTTP ${response.status}`);error.status=response.status;error.payload=body;throw error;}
  return body;
}
function dayStart(date){const d=new Date(date);d.setHours(0,0,0,0);return d;}
function addDays(date,count){const d=new Date(date);d.setDate(d.getDate()+count);return d;}
function mondayStart(date){const d=dayStart(date);const day=(d.getDay()+6)%7;return addDays(d,-day);}
function monthStart(date){const d=dayStart(date);d.setDate(1);return d;}
function addMonths(date,count){const d=monthStart(date);d.setMonth(d.getMonth()+count);return d;}
function isoDay(date){return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;}
function sameLocalDay(a,b){return isoDay(a)===isoDay(b);}
function rangeForMode(){
  if(calendarMode==='month'){const start=mondayStart(monthStart(calendarAnchor));return {start,end:addDays(start,42)};}
  if(calendarMode==='week'){const start=mondayStart(calendarAnchor);return {start,end:addDays(start,7)};}
  if(calendarMode==='day'){const start=dayStart(calendarAnchor);return {start,end:addDays(start,1)};}
  const start=dayStart(calendarAnchor);return {start,end:addDays(start,60)};
}
function moveAnchor(direction){
  if(calendarMode==='month') calendarAnchor=addMonths(calendarAnchor,direction);
  else if(calendarMode==='week') calendarAnchor=addDays(calendarAnchor,7*direction);
  else if(calendarMode==='day') calendarAnchor=addDays(calendarAnchor,direction);
  else calendarAnchor=addDays(calendarAnchor,30*direction);
}
function zonedParts(value,timeZone){
  const date=new Date(value);const zone=timeZone||'UTC';
  try{return new Intl.DateTimeFormat('ru-RU',{timeZone:zone,day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(date).reduce((out,part)=>{if(part.type!=='literal')out[part.type]=part.value;return out;},{});}
  catch{return new Intl.DateTimeFormat('ru-RU',{timeZone:'UTC',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(date).reduce((out,part)=>{if(part.type!=='literal')out[part.type]=part.value;return out;},{});}
}
function displayParts(item){return zonedParts(item.scheduled_at_utc,CALENDAR_DISPLAY_TIMEZONE);}
function dateKey(item){const p=displayParts(item);return `${p.year}-${p.month}-${p.day}`;}
function normalizedHour(value){const parsed=Number(value);return Number.isFinite(parsed)?parsed%24:0;}
function timeLabel(item){const p=displayParts(item);return `${String(normalizedHour(p.hour)).padStart(2,'0')}:${p.minute||'00'}`;}
function timeKey(item){const p=displayParts(item);return `${p.year}-${p.month}-${p.day}T${String(normalizedHour(p.hour)).padStart(2,'0')}`;}
function rangeTitle(range){
  const fmt=new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',year:'numeric'});
  if(calendarMode==='month')return new Intl.DateTimeFormat('ru-RU',{month:'long',year:'numeric'}).format(calendarAnchor);
  if(calendarMode==='day')return fmt.format(calendarAnchor);
  return `${fmt.format(range.start)} — ${fmt.format(addDays(range.end,-1))}`;
}
function platformLabel(item){return (item.platforms||[]).join(' + ')||'без площадки';}
function calendarStatus(value){const raw=String(value||'');return `<span class="badge ${calEsc(raw)}" data-raw-status="${calEsc(raw)}" data-presentation-owner="calendar">${calEsc(statusLabel(raw))}</span>`;}
function thumb(item){return item.thumbnail_path?`<img class="calendar-thumb" src="/public-media/${calEsc(item.thumbnail_path)}" alt="">`:'<span class="calendar-thumb placeholder">нет</span>';}
function editable(item){return !IMMUTABLE_STATUSES.has(String(item.status||''));}
function quickEditButton(item){return editable(item)&&item.schedule_mode==='AT'?`<button type="button" class="secondary calendar-quick-edit" data-calendar-quick-edit="${calEsc(item.id)}">Изменить время</button>`:'';}
function calendarCard(item,queue=false){
  const draggable=editable(item)?'true':'false';
  const time=queue?'QUEUE':timeLabel(item);
  return `<div class="calendar-card${queue?' queue':''}" role="button" tabindex="0" data-calendar-post="${calEsc(item.id)}" data-calendar-kind="${queue?'QUEUE':'AT'}" draggable="${draggable}"><label class="calendar-card-select" style="display:flex;align-items:center;gap:4px"><input type="checkbox" data-calendar-select="${calEsc(item.id)}" ${calendarSelected.has(item.id)?'checked':''}> <span class="small">выбрать</span></label>${thumb(item)}<span class="calendar-card-main"><span class="calendar-card-title">${calEsc(time)} · ${calEsc(item.title)}</span><span class="calendar-card-meta">${calEsc(item.project_name)} · ${calEsc(platformLabel(item))}</span><span class="calendar-source">${calEsc(sourceLabel(item.source_type||'manual'))} · ${calendarStatus(item.status)}${queue?'':` · ${calEsc(item.schedule_timezone||'UTC')}`}</span></span>${queue?'':quickEditButton(item)}</div>`;
}
function listCard(item){
  return `<div class="calendar-list-card" role="button" tabindex="0" data-calendar-post="${calEsc(item.id)}" data-calendar-kind="AT" draggable="${editable(item)?'true':'false'}"><label class="calendar-card-select" style="display:flex;align-items:center;gap:4px"><input type="checkbox" data-calendar-select="${calEsc(item.id)}" ${calendarSelected.has(item.id)?'checked':''}> <span class="small">выбрать</span></label><span class="calendar-time">${calEsc(timeLabel(item))}</span>${thumb(item)}<span><strong>${calEsc(item.title)}</strong><span class="small muted" style="display:block">${calEsc(item.project_name)} · ${calEsc(platformLabel(item))}</span><span class="calendar-source">Источник: ${calEsc(sourceLabel(item.source_type||'manual'))} · план: ${calEsc(item.schedule_timezone||'UTC')} · просмотр: ${calEsc(CALENDAR_DISPLAY_TIMEZONE)}</span></span><span class="calendar-statuses">${calendarStatus(item.editorial_stage)}${calendarStatus(item.status)}</span>${quickEditButton(item)}</div>`;
}
function grouped(items){const map=new Map();for(const item of items){const key=dateKey(item);if(!map.has(key))map.set(key,[]);map.get(key).push(item);}return map;}
function itemById(id){return [...calendarData.items,...calendarData.queueItems].find(item=>item.id===id);}
function renderQueue(items){
  return `<section class="calendar-queue-lane"><div class="calendar-queue-head"><div><strong>Очередь</strong><span class="small muted">Без точного времени. Перетащите в Week/Day slot, чтобы перевести QUEUE → AT.</span></div><span class="badge QUEUE">${items.length}</span></div><div class="calendar-queue-items">${items.length?items.map(item=>calendarCard(item,true)).join(''):'<div class="calendar-empty compact">Очередь пуста</div>'}</div></section>`;
}
function renderMonth(items,range){
  const byDay=grouped(items);const weekdays=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
  let html=`<div class="calendar-grid">${weekdays.map(x=>`<div class="calendar-weekday">${x}</div>`).join('')}`;
  const month=calendarAnchor.getMonth();
  for(let i=0;i<42;i++){
    const day=addDays(range.start,i);const values=byDay.get(isoDay(day))||[];
    const outside=day.getMonth()!==month?' outside':'';const today=sameLocalDay(day,new Date())?' calendar-today':'';
    html+=`<div class="calendar-day-cell${outside}${today}" data-calendar-day="${isoDay(day)}"><div class="calendar-day-head"><strong>${day.getDate()}</strong><span>${values.length||''}</span></div><div class="calendar-items">${values.slice(0,4).map(item=>calendarCard(item)).join('')}${values.length>4?`<div class="calendar-more">+${values.length-4} ещё</div>`:''}</div></div>`;
  }
  return html+'</div>';
}
function slotExact(day,hour){return new Date(day.getFullYear(),day.getMonth(),day.getDate(),hour,0,0,0).toISOString();}
function renderTimeGrid(items,range){
  const days=[];for(let day=dayStart(range.start);day<range.end;day=addDays(day,1))days.push(new Date(day));
  const bySlot=new Map();for(const item of items){const key=timeKey(item);if(!bySlot.has(key))bySlot.set(key,[]);bySlot.get(key).push(item);}
  const headers=days.map(day=>`<div class="calendar-time-day-head">${calEsc(new Intl.DateTimeFormat('ru-RU',{weekday:'short',day:'2-digit',month:'2-digit'}).format(day))}</div>`).join('');
  let rows=`<div class="calendar-time-corner"></div>${headers}`;
  for(let hour=0;hour<24;hour++){
    rows+=`<div class="calendar-hour-label">${String(hour).padStart(2,'0')}:00</div>`;
    for(const day of days){
      const key=`${isoDay(day)}T${String(hour).padStart(2,'0')}`;const values=bySlot.get(key)||[];
      rows+=`<div class="calendar-time-slot" data-calendar-slot="${slotExact(day,hour)}" data-calendar-day="${isoDay(day)}" data-calendar-hour="${hour}">${values.map(item=>calendarCard(item)).join('')}</div>`;
    }
  }
  return `<div class="calendar-time-grid-wrap"><div class="calendar-time-grid" style="--calendar-days:${days.length}">${rows}</div></div>`;
}
function renderAgenda(items,range){
  const byDay=grouped(items);const days=[];
  for(let day=dayStart(range.start);day<range.end;day=addDays(day,1)){
    const values=byDay.get(isoDay(day))||[];if(!values.length)continue;
    days.push(`<section class="calendar-list-day"><h3>${calEsc(new Intl.DateTimeFormat('ru-RU',{weekday:'long',day:'numeric',month:'long',year:'numeric'}).format(day))}</h3>${values.map(listCard).join('')}</section>`);
  }
  return `<div class="calendar-list">${days.join('')||'<div class="card calendar-empty">В выбранном периоде публикаций нет</div>'}</div>`;
}
function openInspector(postId){
  if(Date.now()<calendarSuppressClickUntil)return;
  if(typeof window.PublikatorEditorial?.openContentInspector==='function'){
    window.PublikatorEditorial.openContentInspector(postId).catch(showCalendarError);
    return;
  }
  const trigger=document.createElement('button');trigger.type='button';trigger.className='open-post';trigger.dataset.id=postId;trigger.hidden=true;document.body.append(trigger);trigger.click();trigger.remove();
}
function setNotice(message,isError=false){
  calendarNoticeMessage=message||'';calendarNoticeError=Boolean(isError);
  const notice=document.querySelector('#calendar-notice');if(!notice)return;
  notice.textContent=calendarNoticeMessage;notice.className=`calendar-notice${calendarNoticeError?' error':''}${calendarNoticeMessage?'':' hidden'}`;
}
function isStaleConflict(error){
  const message=String(error?.payload?.error||error?.message||'');
  return error?.status===409&&(/Версия поста|устарел|content.?version/i.test(message));
}
async function patchPostSchedule(item,payload){
  try{
    return await calApi(`/api/posts/${encodeURIComponent(item.id)}`,{method:'PATCH',body:JSON.stringify({...payload,expectedContentVersion:item.content_version})});
  }catch(error){
    const message=String(error?.payload?.error||error?.message||'');
    const ambiguous=message.match(/Local time is ambiguous; choose one offset: (.+)$/);
    if(ambiguous){
      const choices=ambiguous[1].split(',').map(value=>value.trim()).filter(Boolean);
      const selected=window.prompt(`Это местное время встречается дважды. Выберите UTC offset: ${choices.join(' или ')}`,choices[0]||'');
      if(selected&&choices.includes(selected))return await calApi(`/api/posts/${encodeURIComponent(item.id)}`,{method:'PATCH',body:JSON.stringify({...payload,ambiguousOffset:selected,expectedContentVersion:item.content_version})});
    }
    if(isStaleConflict(error)){
      setNotice('Публикация уже была изменена. Обновите календарь.',true);
      await renderCalendar();
      return null;
    }
    throw error;
  }
}
async function rescheduleExact(item,exact,{confirmQueue=false}={}){
  if(!editable(item)){setNotice('Эта публикация уже находится в неизменяемом состоянии.',true);return;}
  const payload={scheduleMode:'AT',scheduledAt:exact,scheduleTimezone:item.schedule_timezone||'UTC'};
  if(item.schedule_mode==='QUEUE'){
    if(!confirmQueue){setNotice('QUEUE можно назначить на точное время только после подтверждения.',true);return;}
    payload.confirmQueueToAt=true;
  }
  const result=await patchPostSchedule(item,payload);
  if(result){setNotice('Время публикации обновлено.');await renderCalendar();}
}
function monthTargetExact(item,targetDay){
  const parts=displayParts(item);const [year,month,day]=targetDay.split('-').map(Number);
  return new Date(year,month-1,day,normalizedHour(parts.hour),Number(parts.minute)||0,0,0).toISOString();
}
function localScheduleParts(item){
  const parts=zonedParts(item.scheduled_at_utc,item.schedule_timezone||'UTC');
  return {date:`${parts.year}-${parts.month}-${parts.day}`,time:`${String(normalizedHour(parts.hour)).padStart(2,'0')}:${parts.minute}`};
}
function calendarModal(html){
  const el=document.createElement('div');el.className='modal calendar-edit-modal';el.innerHTML=`<div class="modal-card">${html}</div>`;
  el.addEventListener('click',event=>{if(event.target===el)el.remove();});document.body.append(el);return el;
}
function openQuickEdit(item){
  if(!editable(item)||item.schedule_mode!=='AT')return;
  const local=localScheduleParts(item);const m=calendarModal(`<h2>Изменить время</h2><form id="calendar-quick-form" class="form-grid"><label>Дата<input name="date" type="date" value="${calEsc(local.date)}" required></label><label>Время<input name="time" type="time" value="${calEsc(local.time)}" required></label><label class="full">Timezone<input name="timezone" value="${calEsc(item.schedule_timezone||'UTC')}" required></label><div class="full row-actions"><button class="primary" type="submit">Сохранить</button><button id="calendar-quick-cancel" class="secondary" type="button">Отмена</button></div></form><div id="calendar-quick-error" class="error"></div>`);
  m.querySelector('#calendar-quick-cancel').onclick=()=>m.remove();
  m.querySelector('#calendar-quick-form').onsubmit=async event=>{
    event.preventDefault();const form=event.currentTarget;const data=new FormData(form);
    try{
      const result=await patchPostSchedule(item,{scheduleMode:'AT',scheduledAtLocal:`${data.get('date')}T${data.get('time')}`,scheduleTimezone:String(data.get('timezone')||'')});
      if(result){m.remove();setNotice('Время публикации обновлено.');await renderCalendar();}
    }catch(error){m.querySelector('#calendar-quick-error').textContent=error instanceof Error?error.message:String(error);}
  };
}
function createFromSlot(exact){
  if(typeof window.publikatorPostEditor!=='function'){setNotice('Редактор публикации недоступен.',true);return;}
  window.publikatorPostEditor(null,{scheduleMode:'AT',scheduledAt:exact,afterSave:async()=>{calendarAnchor=new Date(exact);await renderCalendar();}});
}
function editCalendarPost(item){
  if(typeof window.publikatorPostEditor!=='function'){setNotice('Редактор публикации недоступен.',true);return;}
  window.publikatorPostEditor(item.id,{afterSave:async()=>{await renderCalendar();}});
}
async function calendarLifecycle(item,action,extra={}){
  return calApi(`/api/posts/${encodeURIComponent(item.id)}/${action}`,{method:'POST',body:JSON.stringify({expectedContentVersion:item.content_version,...extra})});
}
function closeCalendarContextMenu(){
  calendarContextMenu?.remove();
  calendarContextMenu=null;
}
async function moveCalendarItem(item){
  const local=item.schedule_mode==='AT'?localScheduleParts(item):{date:isoDay(new Date()),time:'12:00'};
  const value=window.prompt('Новая дата и время: YYYY-MM-DDTHH:MM',`${local.date}T${local.time}`);
  if(!value)return;
  const timezone=window.prompt('Timezone IANA',item.schedule_timezone||'Europe/Moscow')||item.schedule_timezone||'Europe/Moscow';
  const result=await patchPostSchedule(item,{scheduleMode:'AT',scheduledAtLocal:value,scheduleTimezone:timezone,...(item.schedule_mode==='QUEUE'?{confirmQueueToAt:true}:{})});
  if(result)await renderCalendar();
}
function showCalendarContextMenu(item,event){
  closeCalendarContextMenu();
  const menu=document.createElement('div');
  menu.className='card calendar-context-menu';
  menu.style.cssText=`position:fixed;z-index:10050;left:${Math.min(event.clientX,window.innerWidth-220)}px;top:${Math.min(event.clientY,window.innerHeight-260)}px;display:grid;gap:6px;padding:8px;min-width:200px`;
  menu.innerHTML=`<button class="secondary" data-calendar-action="edit">Редактировать</button><button class="secondary" data-calendar-action="duplicate">Дублировать</button><button class="secondary" data-calendar-action="move">Перенести</button><button class="secondary" data-calendar-action="archive">В архив</button><button class="secondary danger" data-calendar-action="trash">В корзину</button>`;
  document.body.append(menu);calendarContextMenu=menu;
  menu.querySelectorAll('[data-calendar-action]').forEach(button=>button.onclick=async()=>{
    const action=button.dataset.calendarAction;closeCalendarContextMenu();
    try{
      if(action==='edit'){editCalendarPost(item);return;}
      if(action==='move'){await moveCalendarItem(item);return;}
      if(action==='duplicate'){const result=await calendarLifecycle(item,'duplicate');if(result?.id&&window.PublikatorEditorial?.openContentInspector)await window.PublikatorEditorial.openContentInspector(result.id);await renderCalendar();return;}
      if(action==='archive'){await calendarLifecycle(item,'archive');await renderCalendar();return;}
      if(action==='trash'){if(!window.confirm('Переместить публикацию в корзину?'))return;await calendarLifecycle(item,'trash');await renderCalendar();}
    }catch(error){setNotice(error instanceof Error?error.message:String(error),true);}
  });
  setTimeout(()=>document.addEventListener('click',closeCalendarContextMenu,{once:true}),0);
}
function selectedCalendarItems(){return [...calendarData.items,...calendarData.queueItems].filter(item=>calendarSelected.has(item.id));}
async function calendarBulkRun(label,worker){
  const items=selectedCalendarItems();if(!items.length)throw new Error('Сначала выберите публикации');
  let done=0;const errors=[];
  for(const item of items){try{await worker(item);done+=1;}catch(error){errors.push(`${item.title}: ${error instanceof Error?error.message:String(error)}`);}}
  calendarSelected.clear();await renderCalendar();
  setNotice(errors.length?`${label}: ${done}, ошибок: ${errors.length}. ${errors.slice(0,3).join(' | ')}`:`${label}: ${done}`,errors.length>0);
}
async function calendarBulkTargets(){
  const accounts=(await calApi('/api/accounts')).filter(a=>a.enabled);
  const raw=window.prompt(`Площадки через ; в формате platform:name. Пустая строка = снять все.\n\n${accounts.map(a=>`${a.platform}:${a.name}`).join('; ')}`,'');
  if(raw===null)return;
  const tokens=raw.split(';').map(x=>x.trim()).filter(Boolean);
  const accountIds=tokens.map(token=>{const i=token.indexOf(':');const p=i>0?token.slice(0,i).trim():'';const n=i>0?token.slice(i+1).trim():'';const match=accounts.find(a=>a.platform===p&&a.name===n);if(!match)throw new Error(`Не найдена площадка ${token}`);return match.id;});
  return calendarBulkRun('Площадки изменены',item=>calApi(`/api/posts/${encodeURIComponent(item.id)}/targets`,{method:'PUT',body:JSON.stringify({accountIds,expectedContentVersion:item.content_version})}));
}
async function calendarBulkMove(){
  const value=window.prompt('Новая дата и время для выбранных: YYYY-MM-DDTHH:MM','');if(!value)return;
  const timezone=window.prompt('Timezone IANA','Europe/Moscow')||'Europe/Moscow';
  return calendarBulkRun('Публикации перенесены',item=>calApi(`/api/posts/${encodeURIComponent(item.id)}`,{method:'PATCH',body:JSON.stringify({scheduleMode:'AT',scheduledAtLocal:value,scheduleTimezone:timezone,expectedContentVersion:item.content_version,...(item.schedule_mode==='QUEUE'?{confirmQueueToAt:true}:{})})}));
}
async function calendarBulkArchive(){if(!window.confirm('Архивировать выбранные публикации?'))return;return calendarBulkRun('Архивировано',item=>calendarLifecycle(item,'archive'));}

function bindCards(){
  document.querySelectorAll('[data-calendar-post]').forEach(card=>{
    card.addEventListener('click',event=>{if(event.target.closest('[data-calendar-quick-edit],[data-calendar-select]'))return;openInspector(card.dataset.calendarPost);});
    card.addEventListener('dblclick',event=>{if(event.target.closest('[data-calendar-quick-edit],[data-calendar-select]'))return;const item=itemById(card.dataset.calendarPost);if(item){event.preventDefault();editCalendarPost(item);}});
    card.addEventListener('contextmenu',event=>{const item=itemById(card.dataset.calendarPost);if(!item)return;event.preventDefault();showCalendarContextMenu(item,event);});
    card.addEventListener('keydown',event=>{if(event.target.closest('[data-calendar-quick-edit],[data-calendar-select]'))return;const item=itemById(card.dataset.calendarPost);if(!item)return;if(event.key==='Enter'){event.preventDefault();editCalendarPost(item);}else if(event.key===' '){event.preventDefault();openInspector(item.id);}});
    card.addEventListener('dragstart',event=>{
      const item=itemById(card.dataset.calendarPost);if(!item||!editable(item)){event.preventDefault();return;}
      calendarDragPostId=item.id;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',item.id);card.classList.add('dragging');
    });
    card.addEventListener('dragend',()=>{card.classList.remove('dragging');calendarDragPostId='';calendarSuppressClickUntil=Date.now()+350;});
  });
  document.querySelectorAll('[data-calendar-quick-edit]').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();const item=itemById(button.dataset.calendarQuickEdit);if(item)openQuickEdit(item);}));
  document.querySelectorAll('[data-calendar-select]').forEach(input=>input.addEventListener('click',event=>event.stopPropagation()));
  document.querySelectorAll('[data-calendar-select]').forEach(input=>input.addEventListener('change',()=>{if(input.checked)calendarSelected.add(input.dataset.calendarSelect);else calendarSelected.delete(input.dataset.calendarSelect);const count=document.querySelector('#calendar-selected-count');if(count)count.textContent=String(calendarSelected.size);document.querySelectorAll('[data-calendar-bulk]').forEach(button=>button.disabled=calendarSelected.size===0);}));
}
function bindTimeSlots(){
  document.querySelectorAll('[data-calendar-slot]').forEach(slot=>{
    slot.addEventListener('click',event=>{if(event.target.closest('[data-calendar-post]'))return;createFromSlot(slot.dataset.calendarSlot);});
    slot.addEventListener('dragover',event=>{if(calendarDragPostId){event.preventDefault();event.dataTransfer.dropEffect='move';slot.classList.add('drag-over');}});
    slot.addEventListener('dragleave',()=>slot.classList.remove('drag-over'));
    slot.addEventListener('drop',async event=>{
      event.preventDefault();slot.classList.remove('drag-over');calendarSuppressClickUntil=Date.now()+350;
      const item=itemById(calendarDragPostId||event.dataTransfer.getData('text/plain'));if(!item)return;
      try{
        if(item.schedule_mode==='QUEUE'){
          if(!window.confirm('Перевести публикацию из очереди на точное время?\nQUEUE → AT'))return;
          await rescheduleExact(item,slot.dataset.calendarSlot,{confirmQueue:true});
        }else await rescheduleExact(item,slot.dataset.calendarSlot);
      }catch(error){setNotice(error instanceof Error?error.message:String(error),true);}
    });
  });
}
function bindMonthDays(){
  document.querySelectorAll('[data-calendar-day]').forEach(day=>{
    day.addEventListener('dragover',event=>{const item=itemById(calendarDragPostId);if(item?.schedule_mode==='AT'){event.preventDefault();event.dataTransfer.dropEffect='move';day.classList.add('drag-over');}});
    day.addEventListener('dragleave',()=>day.classList.remove('drag-over'));
    day.addEventListener('drop',async event=>{
      event.preventDefault();day.classList.remove('drag-over');calendarSuppressClickUntil=Date.now()+350;
      const item=itemById(calendarDragPostId||event.dataTransfer.getData('text/plain'));if(!item||item.schedule_mode!=='AT')return;
      try{await rescheduleExact(item,monthTargetExact(item,day.dataset.calendarDay));}
      catch(error){setNotice(error instanceof Error?error.message:String(error),true);}
    });
  });
}
function bindCalendarInteractions(){
  bindCards();
  if(calendarMode==='week'||calendarMode==='day')bindTimeSlots();
  if(calendarMode==='month')bindMonthDays();
}
async function renderCalendar(){
  const view=document.querySelector('#view');const title=document.querySelector('#page-title');if(!view||!title)return;
  title.textContent='Календарь';
  document.querySelectorAll('.nav').forEach(x=>x.classList.remove('active'));document.querySelector('#calendar-nav')?.classList.add('active');
  const range=rangeForMode();
  view.innerHTML=`<div class="calendar-shell"><div class="calendar-toolbar"><div class="calendar-toolbar-group"><button class="secondary" id="calendar-prev">←</button><button class="secondary" id="calendar-today">Сегодня</button><button class="secondary" id="calendar-next">→</button><span class="calendar-range-title">${calEsc(rangeTitle(range))}</span><span class="small muted">Часовой пояс: ${calEsc(CALENDAR_DISPLAY_TIMEZONE)}</span></div><div class="calendar-toolbar-group">${CALENDAR_MODES.map(mode=>`<button type="button" class="secondary calendar-mode ${mode===calendarMode?'active':''}" data-calendar-mode="${mode}">${MODE_LABELS[mode]}</button>`).join('')}</div></div><div class="calendar-toolbar" style="margin-top:8px"><div class="calendar-toolbar-group"><span>Выбрано: <strong id="calendar-selected-count">${calendarSelected.size}</strong></span><button class="secondary" data-calendar-bulk="move" ${calendarSelected.size?'':'disabled'}>Перенести</button><button class="secondary" data-calendar-bulk="targets" ${calendarSelected.size?'':'disabled'}>Площадки</button><button class="secondary" data-calendar-bulk="archive" ${calendarSelected.size?'':'disabled'}>В архив</button><button class="secondary" id="calendar-clear-selected" ${calendarSelected.size?'':'disabled'}>Снять выделение</button></div><span class="small muted">ПКМ по карточке: Edit / Duplicate / Move / Archive / Trash</span></div><div id="calendar-notice" class="calendar-notice hidden"></div><div id="calendar-queue" class="card calendar-empty">Загрузка очереди…</div><div id="calendar-content" class="card calendar-empty">Загрузка…</div></div>`;
  setNotice(calendarNoticeMessage,calendarNoticeError);
  document.querySelector('#calendar-prev').onclick=()=>{moveAnchor(-1);renderCalendar().catch(showCalendarError);};
  document.querySelector('#calendar-next').onclick=()=>{moveAnchor(1);renderCalendar().catch(showCalendarError);};
  document.querySelector('#calendar-today').onclick=()=>{calendarAnchor=new Date();renderCalendar().catch(showCalendarError);};
  document.querySelectorAll('[data-calendar-mode]').forEach(button=>button.addEventListener('click',()=>{calendarMode=button.dataset.calendarMode;renderCalendar().catch(showCalendarError);}));
  document.querySelector('[data-calendar-bulk="move"]')?.addEventListener('click',()=>calendarBulkMove().catch(showCalendarError));
  document.querySelector('[data-calendar-bulk="targets"]')?.addEventListener('click',()=>calendarBulkTargets().catch(showCalendarError));
  document.querySelector('[data-calendar-bulk="archive"]')?.addEventListener('click',()=>calendarBulkArchive().catch(showCalendarError));
  document.querySelector('#calendar-clear-selected')?.addEventListener('click',()=>{calendarSelected.clear();renderCalendar().catch(showCalendarError);});
  const data=await calApi(`/api/calendar?from=${encodeURIComponent(range.start.toISOString())}&to=${encodeURIComponent(range.end.toISOString())}`);
  calendarData={items:data.items||[],queueItems:data.queueItems||[]};
  const visibleIds=new Set([...calendarData.items,...calendarData.queueItems].map(item=>item.id));
  for(const id of [...calendarSelected])if(!visibleIds.has(id))calendarSelected.delete(id);
  const queue=document.querySelector('#calendar-queue');if(queue){queue.className='';queue.innerHTML=renderQueue(calendarData.queueItems);}
  const content=document.querySelector('#calendar-content');if(!content)return;content.className='';
  if(calendarMode==='month')content.innerHTML=renderMonth(calendarData.items,range);
  else if(calendarMode==='week'||calendarMode==='day')content.innerHTML=renderTimeGrid(calendarData.items,range);
  else content.innerHTML=renderAgenda(calendarData.items,range);
  bindCalendarInteractions();
}
function showCalendarError(error){const view=document.querySelector('#view');if(view)view.innerHTML=`<div class="card error calendar-error">${calEsc(error instanceof Error?error.message:String(error))}</div>`;}
window.publikatorRenderCalendar=renderCalendar;
document.querySelector('#calendar-nav')?.addEventListener('click',()=>renderCalendar().catch(showCalendarError));
