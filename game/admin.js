'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
  const stats = {hp:'Здоровье',maxHp:'Максимум здоровья',strength:'Сила',agility:'Ловкость',defense:'Защита',attackBonus:'Атака',experience:'Опыт',reputation:'Репутация',coins:'Монеты',food:'Еда',potions:'Зелья'};
  const methods = {bankTransfer:'Банковская операция',baseline:'Начало наблюдения',registration:'Регистрация',createCharacter:'Создание персонажа',choose:'Выбор пути',begin:'Начало движения',arrive:'Прибытие',acknowledge:'Продолжить',noticeAction:'Объявление',encounterAction:'Встреча',service:'Услуга',equip:'Снаряжение',battle:'Бой',playDice:'Игра в кости',finishWork:'Работа завершена',cancelWork:'Отмена работы',drink:'Выпито зелье',rename:'Смена имени',trade_sent:'Передача вещей',trade_received:'Получение вещей'};
  const phases = {ready:'Готов к ходу',moving:'В пути',notice:'Объявление',encounter:'Встреча',combat:'Бой',work:'Работа', 'work-result':'Результат работы',outcome:'Итог события',won:'Заказ выполнен','tavern-game':'Игра в трактире'};
  const statuses = {open:'Открыто',in_progress:'В работе',fixed:'Исправлено',closed:'Закрыто'};
  const date = value => value == null ? '—' : new Date(value * 1000).toLocaleString('ru-RU', {timeZone:'UTC'});
  const day = value => new Date(value * 1000).toISOString().slice(0,10);
  let players = [], current = null, selected = null, selectionVersion = 0, csrf = '', currentUserId = null;
  const error = cause => { $('error').textContent = cause.message; $('error').hidden = false; };
  async function api(path, data) {
    const response = await fetch(path, {credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},...(data ? {method:'POST',body:JSON.stringify(data)} : {})});
    const result = await response.json();
    if (!response.ok) throw Error(result.error || 'Не удалось получить данные.');
    return result;
  }
  function metric(label, value) { const box = el('div', undefined, 'metric'); box.append(el('span', label), el('strong', value ?? '—')); return box; }
  function pairs(target, values) {
    const dl = el('dl');
    values.forEach(([key,value]) => { dl.append(el('dt',key),el('dd', value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value))); });
    target.replaceChildren(dl);
  }
  function renderPlayers() {
    const search = $('search').value.trim().toLocaleLowerCase();
    const filtered = players.filter(p => ($('kind').value === 'all' || Boolean(p.is_bot) === ($('kind').value === 'bot')) && `${p.id} ${p.username} ${p.name || ''}`.toLocaleLowerCase().includes(search));
    $('player-count').textContent = `${filtered.length} из ${players.length}`;
    $('players').replaceChildren(...filtered.map(p => {
      const tr = el('tr'); if (p.id === selected) tr.className = 'selected';
      const td = el('td'), button = el('button', p.name || p.username); button.onclick = () => loadPlayer(p.id).catch(error); td.append(button);
      if (p.id === currentUserId) td.append(el('span','ВЫ','badge'));
      if (p.is_bot) td.append(el('span','БОТ','badge'));
      if (p.admin) td.append(el('span','АДМИН','badge'));
      td.append(el('small',`Логин: ${p.username} · #${p.id}`)); tr.append(td);
      [date(p.created_at),date(p.last_seen),`${phases[p.phase] || p.phase || 'Нет персонажа'} · ${p.position || '—'}`,p.turn,`${p.hero.hp ?? '—'} / ${p.hero.maxHp ?? '—'}`,`${p.hero.experience ?? '—'} / ${p.hero.coins ?? '—'}`].forEach(value => tr.append(el('td',value)));
      return tr;
    }));
    if (!filtered.length) { const tr = el('tr'), cell = el('td','Игроки не найдены.','empty'); cell.colSpan = 7; tr.append(cell); $('players').append(tr); }
  }
  async function refresh() {
    $('refresh').disabled = true;
    try {
      const result = await api('/api/admin/players'); players = result.players;
      $('overview').replaceChildren(metric('Всего игроков',players.length),metric('Люди',players.filter(p=>!p.is_bot).length),metric('Боты',players.filter(p=>p.is_bot).length),metric('За последние сутки',players.filter(p=>p.last_seen > result.serverTime-86400).length));
      renderPlayers();
      if (selected !== null) await loadPlayer(selected);
      $('error').hidden = true;
    } finally { $('refresh').disabled = false; }
  }
  function svgNode(tag, attrs, text) {
    const node = document.createElementNS('http://www.w3.org/2000/svg',tag);
    Object.entries(attrs).forEach(([k,v])=>node.setAttribute(k,v)); if (text !== undefined) node.textContent=text; return node;
  }
  function chart(target, points, bars, label) {
    target.replaceChildren();
    if (!points.length) { target.append(el('p','Нет данных за выбранный период.','muted')); return; }
    const svg = svgNode('svg',{viewBox:'0 0 600 200',role:'img','aria-label':label});
    const values = points.map(p=>p.value), min = bars ? 0 : values.reduce((min,v)=>Math.min(min,v),0), max = values.reduce((max,v)=>Math.max(max,v),1), span = max-min || 1;
    const start=points[0].time, duration=points.at(-1).time-start || 1;
    const x=(point,index)=>bars?50+(index+.5)*530/points.length:50+(point.time-start)/duration*530;
    const y=value=>165-(value-min)/span*140;
    [min,max].forEach(value=>{svg.append(svgNode('line',{x1:45,x2:585,y1:y(value),y2:y(value),stroke:'#394746'}),svgNode('text',{x:3,y:y(value)+4,fill:'#a3b8ac','font-size':12},String(value)));});
    if (!bars) svg.append(svgNode('path',{d:points.map((p,i)=>i ? `H ${x(p,i)} V ${y(p.value)}` : `M ${x(p,i)} ${y(p.value)}`).join(' '),fill:'none',stroke:'#b5d4a0','stroke-width':2}));
    points.forEach((point,index)=>{
      const node=bars?svgNode('rect',{x:x(point,index)-Math.min(32,400/points.length)/2,y:y(point.value),width:Math.min(32,400/points.length),height:Math.max(point.value?1:0,165-y(point.value)),fill:'#8ebda0'}):svgNode('circle',{cx:x(point,index),cy:y(point.value),r:3,fill:'#b5d4a0'});
      node.append(svgNode('title',{},`${date(point.time)} · ${label}: ${point.value}`));svg.append(node);
    });
    svg.append(svgNode('text',{x:48,y:195,fill:'#a3b8ac','font-size':12},day(points[0].time)),svgNode('text',{x:582,y:195,fill:'#a3b8ac','font-size':12,'text-anchor':'end'},day(points.at(-1).time)));
    target.append(svg);
    if (bars) target.append(el('small',`За период: ${values.reduce((a,b)=>a+b,0)} ходов`));
    else target.append(el('small',`Начало: ${values[0]} · Конец: ${values.at(-1)} · Изменение: ${values.at(-1)-values[0] > 0 ? '+' : ''}${values.at(-1)-values[0]}`));
  }
  function range() {
    const start = Date.parse($('from').value+'T00:00:00Z')/1000, end = Date.parse($('to').value+'T00:00:00Z')/1000+86400;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end-start > 3660*86400) throw Error('Укажите корректный период до 10 лет.');
    return [start,end];
  }
  function renderPeriod() {
    if (!current) return;
    const [start,requestedEnd]=range(), end=Math.min(requestedEnd,Math.floor(Date.now()/1000)+1), events=current.events.filter(e=>e.created_at>=start && e.created_at<end);
    const totals=new Map(); events.forEach(e=>totals.set(day(e.created_at),(totals.get(day(e.created_at))||0)+e.turns));
    const first=current.events[0]?.created_at;
    const activity=[];
    for(let time=Math.max(start,first == null ? end : Math.floor(first/86400)*86400);time<end;time+=86400) activity.push({time,value:totals.get(day(time))||0});
    chart($('activity'),activity,true,'Ходы');
    const key=$('stat').value, history=current.events.filter(e=>Number.isFinite(e.snapshot.hero?.[key]) && e.created_at<end), previous=history.filter(e=>e.created_at<start).at(-1);
    const growth=history.filter(e=>e.created_at>=start).map(e=>({time:e.created_at,value:e.snapshot.hero[key]}));
    if(previous && start < end) growth.unshift({time:start,value:previous.snapshot.hero[key]});
    if(growth.length) growth.push({time:Math.min(end-1,Math.floor(Date.now()/1000)),value:growth.at(-1).value});
    chart($('growth'),growth,false,stats[key]);
    const search=$('log-search').value.trim().toLocaleLowerCase();
    const shown=events.filter(e=>JSON.stringify([methods[e.method],e.method,e.args,e.journal,e.changes]).toLocaleLowerCase().includes(search));
    $('log-count').textContent=`Действий: ${shown.length}`;
    $('events').replaceChildren(...shown.slice().reverse().map(e=>{
      const node=el('div',undefined,'event');node.append(el('strong',methods[e.method]||e.method),el('small',`${date(e.created_at)} · ход ${e.snapshot.turn ?? 0} · ревизия ${e.revision}`));
      e.journal.forEach(entry=>node.append(el('p',entry.text)));
      const changes=Object.entries(e.changes).filter(([key,v])=>stats[key] && v.before!==undefined && v.before!==null).map(([key,v])=>`${stats[key]}: ${v.before} → ${v.after}`);
      if(changes.length)node.append(el('p',changes.join(' · ')));
      const details=el('details');details.append(el('summary','Параметры и все изменения'),el('pre',JSON.stringify({command:e.method,args:e.args,changes:e.changes,position:e.snapshot.position,phase:e.snapshot.phase},null,2)));node.append(details);return node;
    }));
    if(!shown.length)$('events').append(el('p','Действий не найдено.','empty'));
  }
  async function loadPlayer(uid) {
    const version=++selectionVersion;
    const data=await api('/api/admin/players/'+uid);
    if(version!==selectionVersion)return;
    current=data;selected=uid;renderPlayers();$('detail').hidden=false;
    const p=data.player, state=data.state||{}, hero=state.hero||{};
    $('player-login').textContent=`${p.username} / #${p.id}`;$('player-title').textContent=p.name||p.username;$('is-bot').checked=Boolean(p.is_bot);
    $('summary').replaceChildren(metric('Ходов всего',p.turn),metric('Опыт',hero.experience),metric('Монеты',hero.coins),metric('Банк Товилиса',state.bank?.tovilis?.balance ?? 0),metric('Здоровье',`${hero.hp ?? '—'} / ${hero.maxHp ?? '—'}`));
    $('coverage').textContent=data.events.length?`Наблюдение с ${date(data.events[0].created_at)}. Ранее завершённые ходы (${data.events[0].snapshot.turn ?? 0}) не распределяются по датам. Последнее изменение игры: ${date(p.updated_at)}.`:'История пока пуста.';
    const equipment=window.createTovilisEquipment(window.TOVILIS_CONTENT);
    try { const items=equipment.inventory(hero); pairs($('inventory'),[['Монеты',hero.coins],...items.equipped.map(item=>[item.name,`${item.quantity} · ${item.slot}`]),...items.bag.map(item=>[item.name,item.quantity]),['Вес',`${items.weight}${items.unknownWeight ? ' + предметы неизвестного веса' : ''}`]]); }
    catch { pairs($('inventory'),Object.entries(hero).filter(([key])=>['food','potions','coins','finds','artifacts','equipment'].includes(key))); }
    const profile=hero.character||{};
    pairs($('settings'),[['Регистрация',date(p.created_at)],['Последнее посещение',date(p.last_seen)],['Пол / раса / происхождение / класс',[profile.labels?.sex||profile.sex,profile.labels?.race||profile.race,profile.labels?.origin||profile.origin,profile.labels?.class||profile.class].filter(Boolean).join(' / ')],['Создание персонажа',profile.legacy?'Не завершено':'Завершено'],['Состояние',phases[state.phase]||state.phase],['Клетка',state.position],['Поручение',state.quest],['Игровое время',state.ticks],['Ревизия',p.revision],['Характеристики',Object.keys(stats).map(key=>`${stats[key]}: ${hero[key] ?? '—'}`).join(' · ')],['Ограничения',profile.restrictions||[]],['Работа',state.job||'—']]);
    $('legacy-note').textContent=`Старых команд без дат: ${data.legacyCommands}. Ниже — журнал, восстановленный из сохранённых команд. Точное время старых действий неизвестно.`;
    const baseline=data.events.find(e=>e.method==='baseline');
    const legacy=baseline ? data.legacyJournal : [];
    $('legacy').replaceChildren(...(legacy||[]).slice().reverse().map(entry=>el('p',`Ход ${entry.turn}: ${entry.text}`)));
    $('feedback').replaceChildren(...data.feedback.map(item=>{
      const node=el('div',undefined,'event');node.append(el('strong',`#${item.id} · ${item.title}`),el('small',`${date(item.created_at)} · ${item.category}`),el('p',item.body));
      const select=el('select');select.setAttribute('aria-label',`Статус обращения ${item.id}`);Object.entries(statuses).forEach(([value,label])=>{const option=el('option',label);option.value=value;select.append(option);});select.value=item.status;
      select.onchange=async()=>{select.disabled=true;try{await api('/api/admin/feedback/'+item.id,{status:select.value});item.status=select.value;}catch(cause){select.value=item.status;error(cause);}finally{select.disabled=false;}};node.append(select);return node;
    }));
    if(!data.feedback.length)$('feedback').append(el('p','Обращений пока нет.','muted'));
    $('audit').replaceChildren(...data.audit.map(a=>el('p',`${date(a.created_at)} · ${a.actor_name}: бот ${a.before_value==='1'?'да':'нет'} → ${a.after_value==='1'?'да':'нет'}`)));
    renderPeriod();
  }
  $('is-bot').onchange=async()=>{const uid=selected,value=$('is-bot').checked;$('is-bot').disabled=true;try{await api('/api/admin/players/'+uid,{isBot:value});await refresh();}catch(cause){$('is-bot').checked=!value;error(cause);}finally{$('is-bot').disabled=false;}};
  Object.entries(stats).forEach(([key,label])=>{const option=el('option',label);option.value=key;$('stat').append(option);});
  $('from').value=day(Date.now()/1000-29*86400);$('to').value=day(Date.now()/1000);
  $('search').oninput=renderPlayers;$('kind').onchange=renderPlayers;$('refresh').onclick=()=>refresh().catch(error);
  $('apply-period').onclick=$('stat').onchange=$('log-search').oninput=()=>{try{renderPeriod();$('error').hidden=true;}catch(cause){error(cause);}};
  api('/api/me').then(me=>{if(!me.user.isAdmin)throw Error('Нужен доступ администратора. Войдите в игру под разрешённой учётной записью.');csrf=me.csrf;currentUserId=me.user.id;$('current-account').textContent=`Вы вошли как ${me.user.username} · администратор`;return refresh();}).catch(error);
})();
