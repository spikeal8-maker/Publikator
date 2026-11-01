
const PLATFORMS = {telegram:['Telegram','#269edb'],vk:['VK','#4767ed'],max:['MAX','#8b5cf6'],instagram:['Instagram','#db4c90'],unassigned:['Без площадки','#94a3b8']};
const esc = (value='') => String(value).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const meta = key => PLATFORMS[key] || [key,'#64748b'];
export function overviewChartRange(anchor, days) {
  const start=new Date(anchor); start.setHours(0,0,0,0);
  if(days>1) start.setDate(start.getDate()-Math.floor((days-1)/2));
  const end=new Date(start); end.setDate(end.getDate()+days);
  const bins=Array.from({length:days===1?24:days},(_,i)=>{
    const date=new Date(start);
    if(days===1)date.setHours(i);else date.setDate(date.getDate()+i);
    return {date,counts:{},total:0,posts:0};
  });
  return {start,end,bins};
}
export function aggregateOverviewChart(items, range, days) {
  const bins=range.bins.map(b=>({...b,counts:{}}));
  const totals={}; let posts=0;
  for(const item of items){
    const date=new Date(item.scheduled_at_utc);
    if(!Number.isFinite(date.getTime())||date<range.start||date>=range.end)continue;
    const index=days===1?date.getHours():bins.findIndex(b=>b.date.getFullYear()===date.getFullYear()&&b.date.getMonth()===date.getMonth()&&b.date.getDate()===date.getDate());
    if(index<0)continue;
    const platforms=[...new Set(Array.isArray(item.platforms)?item.platforms.filter(x=>typeof x==='string'&&x):[])];
    if(!platforms.length)platforms.push('unassigned');
    posts++;bins[index].posts++;
    for(const p of platforms){bins[index].counts[p]=(bins[index].counts[p]||0)+1;totals[p]=(totals[p]||0)+1;bins[index].total++;}
  }
  return {bins,totals,posts};
}
export function mountOverviewChart(host,{request,createPublication,help}) {
  let days=14,anchor=new Date(),generation=0,disposed=false;
  const destroy=()=>{disposed=true;generation++;};
  const describe = bin => {
    const date=days===1?bin.date.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}):bin.date.toLocaleDateString('ru-RU',{day:'numeric',month:'long'});
    return date+': '+(Object.entries(bin.counts).map(([p,n])=>meta(p)[0]+' — '+n).join(', ')||'публикаций нет');
  };
  async function render(){
    const current=++generation,range=overviewChartRange(anchor,days);
    host.setAttribute('aria-busy','true');
    if(!host.innerHTML)host.innerHTML='<div class="overview-chart-loading">Загрузка графика…</div>';
    try {
      const data=await request('/api/calendar?'+new URLSearchParams({from:range.start.toISOString(),to:range.end.toISOString()}));
      if(disposed||current!==generation||!host.isConnected)return;
      const summary=aggregateOverviewChart(data.items||[],range,days);
      const keys=Object.keys(summary.totals).sort((a,b)=>b.localeCompare(a));
      const peak=Math.max(1,...summary.bins.map(b=>b.total));
      const rangeLabel=days===1?range.start.toLocaleDateString('ru-RU',{day:'numeric',month:'long',year:'numeric'}):range.start.toLocaleDateString('ru-RU',{day:'numeric',month:'short'})+' — '+new Date(range.end.getTime()-1).toLocaleDateString('ru-RU',{day:'numeric',month:'short',year:'numeric'});
      const bars=summary.bins.map((bin,i)=>{
        const label=days===1?String(bin.date.getHours()).padStart(2,'0'):String(bin.date.getDate());
        const showLabel=days!==30||i%3===0;
        return `<button type="button" class="overview-chart-bar" data-bin="${i}" data-total="${bin.total}" aria-label="${esc(describe(bin))}" title="${esc(describe(bin))}">
          <span class="overview-chart-stack">${keys.map(p=>bin.counts[p]?`<span style="height:${bin.counts[p]/peak*100}%;background:${meta(p)[1]}" aria-hidden="true"></span>`:'').join('')}</span>
          <span class="overview-chart-tick" aria-hidden="true">${showLabel?label:'·'}</span></button>`;
      }).join('');
      const maximum=Math.max(1,...Object.values(summary.totals));
      host.innerHTML=`<div class="overview-chart-toolbar"><div class="overview-chart-title"><h2>Публикации</h2><span>${summary.posts}</span>${help('Графики публикаций','Данные из календаря: опубликованные и запланированные материалы с точной датой. Цвет — площадка. Один материал для Telegram и MAX учитывается в обоих цветах. Материал без выбранной площадки показан серым. 14 дней включают шесть предыдущих дней, сегодня и семь следующих; стрелки сдвигают период. В режиме «День» столбцы соответствуют часам. Нажмите на столбец для точных значений. Наличие материала в плане не означает, что он уже одобрен к автоматической отправке.')}</div>
        <div class="overview-chart-periods" role="group" aria-label="Период графика">${[[1,'День'],[7,'Неделя'],[14,'14 дней'],[30,'Месяц']].map(([n,label])=>`<button type="button" data-chart-days="${n}" aria-pressed="${days===n}">${label}</button>`).join('')}</div></div>
        <div class="overview-chart-range"><button type="button" data-chart-move="-1" aria-label="Предыдущий период">‹</button><span>${esc(rangeLabel)}</span><button type="button" data-chart-move="1" aria-label="Следующий период">›</button><button type="button" class="overview-chart-today">Сегодня</button><button type="button" class="overview-create" aria-label="Создать публикацию">＋</button></div>
        <div class="overview-chart-plot" data-chart-length="${summary.bins.length}"><div class="overview-chart-axis" aria-hidden="true"><span>${peak}</span><span>${peak>1?Math.round(peak/2):''}</span><span>0</span></div><div class="overview-chart-bars" style="--chart-columns:${summary.bins.length}">${bars}</div></div>
        ${!summary.posts?'<p class="overview-chart-empty">В этом периоде публикаций нет</p>':''}
        <div class="overview-platform-chart" aria-label="Публикации по площадкам">${keys.map(p=>`<div class="overview-platform-row"><span><i style="background:${meta(p)[1]}" aria-hidden="true"></i>${esc(meta(p)[0])}<strong>${summary.totals[p]}</strong></span><div class="overview-platform-track"><span style="width:${summary.totals[p]/maximum*100}%;background:${meta(p)[1]}"></span></div></div>`).join('')}</div>
        <div class="overview-chart-detail" role="status" aria-live="polite">${data.items?.length>=5000?'Показаны первые 5000 материалов.':''}</div>`;
      host.querySelectorAll('[data-chart-days]').forEach(b=>b.onclick=()=>{days=Number(b.dataset.chartDays);render();});
      host.querySelectorAll('[data-chart-move]').forEach(b=>b.onclick=()=>{anchor=new Date(anchor);anchor.setDate(anchor.getDate()+Number(b.dataset.chartMove)*days);render();});
      host.querySelector('.overview-chart-today').onclick=()=>{anchor=new Date();render();};
      host.querySelector('.overview-create').onclick=createPublication;
      host.querySelectorAll('[data-bin]').forEach(b=>b.onclick=()=>{
        host.querySelectorAll('[data-bin]').forEach(x=>x.removeAttribute('aria-current'));
        b.setAttribute('aria-current','true');
        host.querySelector('.overview-chart-detail').textContent=describe(summary.bins[Number(b.dataset.bin)]);
      });
    } catch(error){
      if(!disposed&&current===generation&&host.isConnected)host.innerHTML='<div class="overview-chart-error" role="alert">Не удалось загрузить график. <button type="button">Повторить</button></div>';
      host.querySelector('.overview-chart-error button')?.addEventListener('click',render);
    } finally {if(current===generation)host.setAttribute('aria-busy','false');}
  }
  render();
  return {destroy};
}
