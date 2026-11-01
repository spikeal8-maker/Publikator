import { renderRichText } from './rich-text-editor-v1.js';

const names={material:'Материал',vk:'VK',telegram:'Telegram',max:'MAX',instagram:'Instagram'};
const escape=(value='')=>String(value).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const safeUrl=value=>typeof value==='string'&&(value.startsWith('/public-media/')||value.startsWith('blob:'));
export function previewMedia(post){
 const media=post?.media||[],byId=new Map(media.map(item=>[item.id,item]));
 const posterIds=new Set(media.filter(item=>item.poster_asset_id).map(item=>item.poster_asset_id));
 const relations=post?.contentMedia||[];
 const ordered=relations.length?relations.map(link=>({...byId.get(link.media_id),role:link.role})):media;
 return ordered.filter(item=>item.id&&item.role!=='poster'&&!posterIds.has(item.id)).map(item=>({
  id:item.id,url:'/public-media/'+String(item.relative_path).split('/').map(encodeURIComponent).join('/'),
  mimeType:item.mime_type,width:item.width,height:item.height,role:item.role||'primary',
  posterUrl:item.poster_asset_id&&byId.has(item.poster_asset_id)?'/public-media/'+byId.get(item.poster_asset_id).relative_path:null
 }));
}

// Display only. This component never declares publishing readiness or writes a post.
export function mountSocialPreview(host,initial=[]){
 let rows=initial,active='',device='desktop',slide=0,disposed=false;
 const render=()=>{
  if(disposed)return;
  const selected=rows.find(item=>String(item.accountId||item.targetId)===active)||rows[0];
  if(selected)active=String(selected.accountId||selected.targetId);
  const platform=selected?.platform||'vk';
  host.classList.add('social-preview');
  host.innerHTML=`<div class="sp-toolbar"><strong>Предпросмотр</strong><details class="sp-help"><summary aria-label="О предпросмотре">i</summary><div>Текст и вложения показаны вместе в стиле выбранной площадки. Переключайте получателя и вид «Компьютер / Телефон». Нажмите фото, чтобы посмотреть его целиком. Это ориентировочный вид: интерфейс соцсети может отличаться. Предпросмотр не сохраняет и не отправляет материал. Ограничения формата и права подключения проверяет сервер перед отправкой.</div></details><div class="sp-devices" aria-label="Вид предпросмотра"><button type="button" data-device="desktop" aria-pressed="${device==='desktop'}">Компьютер</button><button type="button" data-device="phone" aria-pressed="${device==='phone'}">Телефон</button></div></div>
   <div class="sp-tabs" role="tablist" aria-label="Площадка предпросмотра">${rows.map(item=>`<button type="button" role="tab" data-account="${escape(item.accountId||item.targetId)}" aria-selected="${String(item.accountId||item.targetId)===active}">${escape(names[item.platform]||item.platform)}<span>${escape(item.accountName||'Публикация')}</span></button>`).join('')}</div>
   <div class="sp-canvas sp-${escape(platform)}" data-device="${device}"><div class="sp-device-frame"><div class="sp-appbar">${escape(names[platform]||'Предпросмотр')}<span>•••</span></div><article class="sp-post"><header class="sp-author"><span class="sp-avatar">${escape((selected?.accountName||names[platform]||'П').slice(0,1))}</span><div><strong>${escape(selected?.accountName||'Выберите получателя')}</strong><small>Публикация · ${selected?.publicationKind==='STORY'?'История':selected?.publicationKind==='SHORT'?'Короткое видео':'Пост'}</small></div><span aria-hidden="true">⋯</span></header><div class="sp-content"></div><footer class="sp-reactions" aria-hidden="true">${platform==='telegram'||platform==='max'?'♡　↗　 <span>Просмотры · сейчас</span>':'♡　▢　↗　<span>Сохранить</span>'}</footer></article></div></div><div class="sp-footnote">${selected?.localDraft?'Изменения в редакторе':'Сохранённая версия'} · ориентировочный вид</div>`;
  const content=host.querySelector('.sp-content');
  const text=document.createElement('div');text.className='sp-text rich-text-preview';
  if(selected?.resolvedRichText&&['telegram','max'].includes(platform))renderRichText(text,selected.resolvedRichText);
  else text.textContent=selected?.compilation?.transport?.kind==='plain'?selected.compilation.transport.text:selected?.text||'';
  const media=(selected?.media||[]).filter(item=>item.role!=='poster'&&safeUrl(item.url));
  slide=Math.min(slide,Math.max(0,media.length-1));
  const group=document.createElement('div');group.className='sp-media';
  const video=media.some(item=>item.mimeType?.startsWith('video/'));
  const gallery=(platform==='instagram'||video)&&media.length>1;
  const shown=gallery?[media[slide]]:media.slice(0,5);
  group.dataset.count=String(shown.length);
  for(const [index,item] of shown.entries()){
   const cell=document.createElement('div');cell.className='sp-media-cell';
   if(item.mimeType?.startsWith('video/')){
    const element=document.createElement('video');element.src=item.url;element.controls=true;element.playsInline=true;element.preload='metadata';if(safeUrl(item.posterUrl))element.poster=item.posterUrl;cell.append(element);
   }else{
    const button=document.createElement('button');button.type='button';button.className='sp-photo';button.setAttribute('aria-label','Открыть изображение '+(gallery?slide+1:index+1));
    const image=document.createElement('img');image.src=item.url;image.alt='Изображение '+(gallery?slide+1:index+1);button.append(image);
    if(!gallery&&index===4&&media.length>5){const more=document.createElement('span');more.className='sp-more';more.textContent='+'+(media.length-5);button.append(more);}
    button.onclick=()=>openLightbox(media,gallery?slide:index);cell.append(button);
   }
   group.append(cell);
  }
  if(platform==='vk'||platform==='material')content.append(text);
  if(media.length)content.append(group);
  if(platform!=='vk'&&platform!=='material')content.append(text);
  if(!selected){const empty=document.createElement('p');empty.className='sp-empty';empty.textContent='Выберите площадки — здесь появится ваша публикация.';content.append(empty);}
  if(media.length>1){
   const nav=document.createElement('div');nav.className='sp-gallery-nav';
   nav.innerHTML=`<button type="button" class="sp-prev" aria-label="Предыдущее вложение">‹</button><span>${gallery?slide+1:media.length} ${gallery?'из '+media.length:'вложений'}</span><button type="button" class="sp-next" aria-label="Следующее вложение">›</button>`;
   if(gallery){nav.querySelector('.sp-prev').onclick=()=>{slide=(slide+media.length-1)%media.length;render();};nav.querySelector('.sp-next').onclick=()=>{slide=(slide+1)%media.length;render();};}
   else {nav.querySelector('.sp-prev').hidden=true;nav.querySelector('.sp-next').textContent='Смотреть все';nav.querySelector('.sp-next').setAttribute('aria-label','Смотреть все вложения');nav.querySelector('.sp-next').onclick=()=>openLightbox(media,0);}
   content.append(nav);
  }
  const issues=(selected?.issues||[]).filter(item=>['error','warning'].includes(item.severity));
  if(issues.length){const details=document.createElement('details');details.className='sp-issues';details.innerHTML='<summary>Что проверить · '+issues.length+'</summary>';for(const issue of issues){const p=document.createElement('p');p.textContent=issue.message;details.append(p);}host.append(details);}
  host.querySelectorAll('[data-account]').forEach(button=>button.onclick=()=>{active=button.dataset.account;slide=0;render();});
  host.querySelectorAll('[data-device]').forEach(button=>button.onclick=()=>{device=button.dataset.device;render();});
 };
 let lightbox=null;
 const closeLightbox=()=>{lightbox?.remove();lightbox=null;};
 const openLightbox=(media,index)=>{
  closeLightbox();lightbox=document.createElement('dialog');lightbox.className='sp-lightbox';
  const draw=()=>{const item=media[index];lightbox.innerHTML=`<div class="sp-lightbox-head"><span>${index+1} из ${media.length}</span><button type="button" class="sp-lightbox-close" aria-label="Закрыть изображение">×</button></div><div class="sp-lightbox-media"></div><div class="sp-lightbox-nav"><button type="button" class="sp-lightbox-prev" ${media.length<2?'disabled':''}>← Назад</button><button type="button" class="sp-lightbox-next" ${media.length<2?'disabled':''}>Далее →</button></div>`;
   const el=document.createElement(item.mimeType?.startsWith('video/')?'video':'img');el.src=item.url;if(el.tagName==='VIDEO'){el.controls=true;el.playsInline=true;}else el.alt='Изображение '+(index+1);lightbox.querySelector('.sp-lightbox-media').append(el);
   lightbox.querySelector('.sp-lightbox-close').onclick=closeLightbox;
   lightbox.querySelector('.sp-lightbox-prev').onclick=()=>{index=(index+media.length-1)%media.length;draw();};
   lightbox.querySelector('.sp-lightbox-next').onclick=()=>{index=(index+1)%media.length;draw();};
  };
  draw();document.body.append(lightbox);lightbox.addEventListener('click',event=>{if(event.target===lightbox)closeLightbox();});lightbox.addEventListener('cancel',closeLightbox);lightbox.showModal();
 };
 render();
 return {update(next){rows=next;render();},dispose(){disposed=true;closeLightbox();host.replaceChildren();}};
}
