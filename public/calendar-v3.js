const CALENDAR_MODES = ['month','week','day','agenda'];
const MODE_LABELS = { month:'Месяц', week:'Неделя', day:'День', agenda:'Agenda' };
let calendarMode = 'month';
let calendarAnchor = new Date();

function calEsc(value=''){return String(value).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
async function calApi(url){const response=await fetch(url,{credentials:'same-origin'});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body?.error||`HTTP ${response.status}`);return body;}
function dayStart(date){const d=new Date(date);d.setHours(0,0,0,0);return d;}
function addDays(date,count){const d=new Date(date);d.setDate(d.getDate()+count);return d;}
function mondayStart(date){const d=dayStart(date);const day=(d.getDay()+6)%7;return addDays(d,-day);}
function monthStart(date){const d=dayStart(date);d.setDate(1);return d;}
function addMonths(date,count){const d=monthStart(date);d.setMonth(d.getMonth()+count);return d;}
function isoDay(date){return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;}
function dateKey(value){return isoDay(new Date(value));}
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
function timeLabel(item){const p=zonedParts(item.scheduled_at_utc,item.schedule_timezone);return `${p.hour||'??'}:${p.minute||'??'}`;}
function dayLabel(item){const p=zonedParts(item.scheduled_at_utc,item.schedule_timezone);return `${p.day}.${p.month}.${p.year}`;}
function rangeTitle(range){
  const fmt=new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',year:'numeric'});
  if(calendarMode==='month')return new Intl.DateTimeFormat('ru-RU',{month:'long',year:'numeric'}).format(calendarAnchor);
  if(calendarMode==='day')return fmt.format(calendarAnchor);
  return `${fmt.format(range.start)} — ${fmt.format(addDays(range.end,-1))}`;
}
function sourceLabel(item){return item.source_type||'manual';}
function platformLabel(item){return (item.platforms||[]).join(', ')||'без площадки';}
function thumb(item){return item.thumbnail_path?`<img class="calendar-thumb" src="/public-media/${calEsc(item.thumbnail_path)}" alt="">`:'<span class="calendar-thumb placeholder">нет</span>';}
function calendarCard(item){return `<button type="button" class="calendar-card" data-calendar-post="${calEsc(item.id)}">${thumb(item)}<span class="calendar-card-main"><span class="calendar-card-title">${calEsc(timeLabel(item))} · ${calEsc(item.title)}</span><span class="calendar-card-meta">${calEsc(item.project_name)} · ${calEsc(platformLabel(item))}</span><span class="calendar-source">${calEsc(sourceLabel(item))} · ${calEsc(item.status)}</span></span></button>`;}
function listCard(item){return `<button type="button" class="calendar-list-card" data-calendar-post="${calEsc(item.id)}"><span class="calendar-time">${calEsc(timeLabel(item))}</span>${item.thumbnail_path?`<img src="/public-media/${calEsc(item.thumbnail_path)}" alt="">`:'<span class="calendar-thumb placeholder">нет</span>'}<span><strong>${calEsc(item.title)}</strong><span class="small muted" style="display:block">${calEsc(item.project_name)} · ${calEsc(platformLabel(item))}</span><span class="calendar-source">${calEsc(sourceLabel(item))} · ${calEsc(item.schedule_timezone||'UTC')}</span></span><span class="calendar-statuses"><span class="badge ${calEsc(item.editorial_stage)}">${calEsc(item.editorial_stage)}</span><span class="badge ${calEsc(item.status)}">${calEsc(item.status)}</span></span></button>`;}
function grouped(items){const map=new Map();for(const item of items){const key=dateKey(item.scheduled_at_utc);if(!map.has(key))map.set(key,[]);map.get(key).push(item);}return map;}
function renderMonth(items,range){const byDay=grouped(items);const weekdays=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];let html=`<div class="calendar-grid">${weekdays.map(x=>`<div class="calendar-weekday">${x}</div>`).join('')}`;const month=calendarAnchor.getMonth();for(let i=0;i<42;i++){const day=addDays(range.start,i);const values=byDay.get(isoDay(day))||[];const outside=day.getMonth()!==month?' outside':'';const today=sameLocalDay(day,new Date())?' calendar-today':'';html+=`<div class="calendar-day-cell${outside}${today}"><div class="calendar-day-head"><strong>${day.getDate()}</strong><span>${values.length||''}</span></div><div class="calendar-items">${values.slice(0,4).map(calendarCard).join('')}${values.length>4?`<div class="calendar-more">+${values.length-4} ещё</div>`:''}</div></div>`;}return html+'</div>';}
function renderList(items,range){const byDay=grouped(items);const days=[];for(let day=dayStart(range.start);day<range.end;day=addDays(day,1)){const values=byDay.get(isoDay(day))||[];if(calendarMode==='agenda'&&!values.length)continue;days.push(`<section class="calendar-list-day"><h3>${calEsc(new Intl.DateTimeFormat('ru-RU',{weekday:'long',day:'numeric',month:'long',year:'numeric'}).format(day))}</h3>${values.length?values.map(listCard).join(''):'<div class="card calendar-empty">На этот день публикаций нет</div>'}</section>`);}return `<div class="calendar-list">${days.join('')||'<div class="card calendar-empty">В выбранном периоде публикаций нет</div>'}</div>`;}
function renderWeek(items,range){return renderList(items,range);}
function openInspector(postId){const trigger=document.createElement('button');trigger.type='button';trigger.className='open-post';trigger.dataset.id=postId;trigger.hidden=true;document.body.append(trigger);trigger.click();trigger.remove();}
function bindCalendarCards(){document.querySelectorAll('[data-calendar-post]').forEach(el=>el.addEventListener('click',()=>openInspector(el.dataset.calendarPost)));}
async function renderCalendar(){
  const view=document.querySelector('#view');const title=document.querySelector('#page-title');if(!view||!title)return;
  title.textContent='Календарь';
  document.querySelectorAll('.nav').forEach(x=>x.classList.remove('active'));document.querySelector('#calendar-nav')?.classList.add('active');
  const range=rangeForMode();
  view.innerHTML=`<div class="calendar-shell"><div class="calendar-toolbar"><div class="calendar-toolbar-group"><button class="secondary" id="calendar-prev">←</button><button class="secondary" id="calendar-today">Сегодня</button><button class="secondary" id="calendar-next">→</button><span class="calendar-range-title">${calEsc(rangeTitle(range))}</span></div><div class="calendar-toolbar-group">${CALENDAR_MODES.map(mode=>`<button type="button" class="secondary calendar-mode ${mode===calendarMode?'active':''}" data-calendar-mode="${mode}">${MODE_LABELS[mode]}</button>`).join('')}</div></div><div id="calendar-content" class="card calendar-empty">Загрузка…</div></div>`;
  document.querySelector('#calendar-prev').onclick=()=>{moveAnchor(-1);renderCalendar().catch(showCalendarError);};
  document.querySelector('#calendar-next').onclick=()=>{moveAnchor(1);renderCalendar().catch(showCalendarError);};
  document.querySelector('#calendar-today').onclick=()=>{calendarAnchor=new Date();renderCalendar().catch(showCalendarError);};
  document.querySelectorAll('[data-calendar-mode]').forEach(button=>button.addEventListener('click',()=>{calendarMode=button.dataset.calendarMode;renderCalendar().catch(showCalendarError);}));
  const data=await calApi(`/api/calendar?from=${encodeURIComponent(range.start.toISOString())}&to=${encodeURIComponent(range.end.toISOString())}`);
  const content=document.querySelector('#calendar-content');if(!content)return;content.className='';
  content.innerHTML=calendarMode==='month'?renderMonth(data.items,range):calendarMode==='week'?renderWeek(data.items,range):renderList(data.items,range);
  bindCalendarCards();
}
function showCalendarError(error){const view=document.querySelector('#view');if(view)view.innerHTML=`<div class="card error calendar-error">${calEsc(error instanceof Error?error.message:String(error))}</div>`;}
document.querySelector('#calendar-nav')?.addEventListener('click',()=>renderCalendar().catch(showCalendarError));
