import { publicationFormatLabel, sourceLabel, statusLabel } from './presentation-labels.js';

const LIBRARY_VIEWS = [
  ['all','Все'],['inbox','Входящие'],['draft','Черновики'],['ready','Готово'],
  ['scheduled','Запланировано'],['published','Опубликовано'],['problems','Проблемы']
];
const LIBRARY_FORMATS = [
  ['all','Все форматы'],['image','Изображения'],['stories','Истории'],['shorts','Короткие видео'],['video','Видео']
];

let libraryView = 'all';
let libraryFormat = 'all';
let librarySearch = '';
let libraryPage = 1;
let libraryPageSize = 24;
let libraryLayout = localStorage.getItem('publikator-library-layout') === 'list' ? 'list' : 'grid';
const librarySelected = new Set();

function libEsc(value=''){return String(value).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
async function libApi(url){const r=await fetch(url,{credentials:'same-origin'});const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(b?.error||`HTTP ${r.status}`);return b;}
function libBadge(value, role){const raw=String(value||'');return `<span class="badge ${libEsc(raw)}" data-raw-status="${libEsc(raw)}" data-presentation-owner="library" data-status-role="${libEsc(role)}">${libEsc(role)} · ${libEsc(statusLabel(raw))}</span>`;}
function libTime(item){
  if(item.schedule_mode==='AT'&&item.scheduled_at_utc){const d=new Date(item.scheduled_at_utc);return `${d.toLocaleString()} · ${item.schedule_timezone||'UTC'}`;}
  if(item.schedule_mode==='QUEUE')return 'Очередь';
  return 'Вручную';
}
function libPlatforms(item){return item.platforms?.length?item.platforms.join(' · '):'без площадки';}
function libSource(item){return sourceLabel(item.source_type||'manual');}
function libThumb(item){return item.thumbnail_path?`<img src="/public-media/${libEsc(item.thumbnail_path)}" alt="">`:'<span class="library-no-thumb">Нет медиа</span>';}
function libFormat(item){return publicationFormatLabel(item.publication_kind, item.content_format);}
function libChecked(id){return librarySelected.has(id)?'checked':'';}

function gridItem(item){return `<article class="library-card ${Number(item.problem_count)>0?'has-problem':''}">
  <label class="library-select"><input type="checkbox" data-library-select="${libEsc(item.id)}" ${libChecked(item.id)}> выбрать</label>
  <button type="button" class="library-open open-post" data-id="${libEsc(item.id)}">
    <span class="library-card-media">${libThumb(item)}</span>
    <span class="library-card-copy"><span class="library-project">${libEsc(item.project_name)}</span><strong>${libEsc(item.title)}</strong>
      <span class="library-meta">${libEsc(libTime(item))}</span><span class="library-meta">${libEsc(libPlatforms(item))}</span>
      <span class="library-meta">${libEsc(libFormat(item))} · Источник: ${libEsc(libSource(item))}</span>
      <span class="library-badges">${libBadge(item.editorial_stage,'Контент')} ${libBadge(item.status,'Публикация')}${Number(item.problem_count)>0?` <span class="library-problem">${item.problem_count} проблем</span>`:''}</span>
    </span>
  </button>
</article>`;}

function listRow(item){return `<tr class="${Number(item.problem_count)>0?'has-problem':''}">
  <td><input type="checkbox" data-library-select="${libEsc(item.id)}" ${libChecked(item.id)}></td>
  <td><span class="library-list-thumb">${libThumb(item)}</span></td>
  <td><button type="button" class="library-open library-title-button open-post" data-id="${libEsc(item.id)}"><strong>${libEsc(item.title)}</strong><span>${libEsc(item.project_name)}</span></button></td>
  <td>${libEsc(libTime(item))}</td><td>${libEsc(libPlatforms(item))}</td><td>${libEsc(libFormat(item))}</td>
  <td>${libBadge(item.editorial_stage,'Контент')} ${libBadge(item.status,'Публикация')}</td><td>${libEsc(libSource(item))}</td>
</tr>`;}

function libraryContent(data){
  if(!data.items.length)return '<div class="card library-empty">По выбранным фильтрам публикаций нет.</div>';
  if(libraryLayout==='grid')return `<div class="library-grid">${data.items.map(gridItem).join('')}</div>`;
  return `<div class="library-table-wrap"><table class="table library-table"><thead><tr><th></th><th>Медиа</th><th>Публикация</th><th>Когда</th><th>Площадки</th><th>Формат</th><th>Состояние</th><th>Источник</th></tr></thead><tbody>${data.items.map(listRow).join('')}</tbody></table></div>`;
}

function libraryToolbar(data){
  return `<div class="library-topbar">
    <form id="library-search-form" class="library-search"><input id="library-search" value="${libEsc(librarySearch)}" placeholder="Поиск по заголовку, тексту, проекту, источнику"><button class="secondary">Найти</button></form>
    <div class="row-actions"><button id="library-new" class="primary" type="button">+ Новый пост</button><button class="secondary library-layout ${libraryLayout==='grid'?'active':''}" data-layout="grid" type="button">Карточки</button><button class="secondary library-layout ${libraryLayout==='list'?'active':''}" data-layout="list" type="button">Таблица</button></div>
  </div>
  <div class="library-filter-row"><div class="library-view-tabs">${LIBRARY_VIEWS.map(([key,label])=>`<button type="button" class="secondary library-view ${libraryView===key?'active':''}" data-library-view="${key}">${label}</button>`).join('')}</div>
    <label class="library-format">Формат <select id="library-format">${LIBRARY_FORMATS.map(([key,label])=>`<option value="${key}" ${libraryFormat===key?'selected':''}>${label}</option>`).join('')}</select></label>
  </div>
  <div class="library-selection-bar"><span>Найдено: <strong>${data.total}</strong></span><span>Выбрано: <strong id="library-selected-count">${librarySelected.size}</strong></span><button id="library-clear-selection" class="secondary" type="button">Снять выделение</button></div>`;
}

function libraryPager(data){
  return `<div class="library-pager"><button id="library-prev" class="secondary" ${data.page<=1?'disabled':''}>←</button><span>Страница <strong>${data.page}</strong> из <strong>${data.totalPages}</strong></span><button id="library-next" class="secondary" ${data.page>=data.totalPages?'disabled':''}>→</button><label>На странице <select id="library-page-size">${[24,48,96].map(n=>`<option value="${n}" ${libraryPageSize===n?'selected':''}>${n}</option>`).join('')}</select></label></div>`;
}

async function waitForLegacyEditor(postId){
  const legacyNav=document.querySelector('.nav[data-view="posts"]');
  if(!legacyNav)return;
  legacyNav.click();
  for(let i=0;i<40;i+=1){
    await new Promise(resolve=>setTimeout(resolve,25));
    const row=[...document.querySelectorAll('#view .open-post')].find(el=>el.dataset.id===postId&&typeof el.onclick==='function');
    if(row){row.onclick();return;}
  }
}

function bindLibrary(data){
  document.querySelector('#library-search-form')?.addEventListener('submit',event=>{event.preventDefault();librarySearch=document.querySelector('#library-search')?.value.trim()||'';libraryPage=1;librarySelected.clear();renderContentLibrary().catch(showLibraryError);});
  document.querySelectorAll('[data-library-view]').forEach(button=>button.addEventListener('click',()=>{libraryView=button.dataset.libraryView;libraryPage=1;librarySelected.clear();renderContentLibrary().catch(showLibraryError);}));
  document.querySelector('#library-format')?.addEventListener('change',event=>{libraryFormat=event.target.value;libraryPage=1;librarySelected.clear();renderContentLibrary().catch(showLibraryError);});
  document.querySelectorAll('[data-layout]').forEach(button=>button.addEventListener('click',()=>{libraryLayout=button.dataset.layout;localStorage.setItem('publikator-library-layout',libraryLayout);renderContentLibrary().catch(showLibraryError);}));
  document.querySelectorAll('[data-library-select]').forEach(input=>input.addEventListener('change',()=>{if(input.checked)librarySelected.add(input.dataset.librarySelect);else librarySelected.delete(input.dataset.librarySelect);const counter=document.querySelector('#library-selected-count');if(counter)counter.textContent=String(librarySelected.size);}));
  document.querySelector('#library-clear-selection')?.addEventListener('click',()=>{librarySelected.clear();document.querySelectorAll('[data-library-select]').forEach(input=>{input.checked=false;});const counter=document.querySelector('#library-selected-count');if(counter)counter.textContent='0';});
  document.querySelector('#library-prev')?.addEventListener('click',()=>{if(libraryPage>1){libraryPage-=1;renderContentLibrary().catch(showLibraryError);}});
  document.querySelector('#library-next')?.addEventListener('click',()=>{if(libraryPage<data.totalPages){libraryPage+=1;renderContentLibrary().catch(showLibraryError);}});
  document.querySelector('#library-page-size')?.addEventListener('change',event=>{libraryPageSize=Number(event.target.value)||24;libraryPage=1;renderContentLibrary().catch(showLibraryError);});
  document.querySelector('#library-new')?.addEventListener('click',async()=>{const nav=document.querySelector('.nav[data-view="posts"]');nav?.click();for(let i=0;i<40;i+=1){await new Promise(resolve=>setTimeout(resolve,25));const button=document.querySelector('#new-post');if(button){button.click();return;}}});
  document.querySelectorAll('.library-open').forEach(button=>button.addEventListener('click',()=>waitForLegacyEditor(button.dataset.id)));
}

async function renderContentLibrary(){
  const view=document.querySelector('#view');const title=document.querySelector('#page-title');if(!view||!title)return;
  title.textContent='Библиотека';document.querySelectorAll('.nav').forEach(x=>x.classList.remove('active'));document.querySelector('#content-library-nav')?.classList.add('active');
  view.innerHTML='<div class="card muted">Загрузка библиотеки…</div>';
  const params=new URLSearchParams({view:libraryView,format:libraryFormat,page:String(libraryPage),pageSize:String(libraryPageSize)});if(librarySearch)params.set('search',librarySearch);
  const data=await libApi(`/api/content-library?${params}`);
  if(data.page>data.totalPages){libraryPage=data.totalPages;return renderContentLibrary();}
  view.innerHTML=`<section class="content-library">${libraryToolbar(data)}${libraryContent(data)}${libraryPager(data)}</section>`;
  bindLibrary(data);
}
function showLibraryError(error){const view=document.querySelector('#view');if(view)view.innerHTML=`<div class="card error">${libEsc(error instanceof Error?error.message:String(error))}</div>`;}
document.querySelector('#content-library-nav')?.addEventListener('click',()=>renderContentLibrary().catch(showLibraryError));
