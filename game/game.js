'use strict';
(() => {
  const map = window.TOVILIS_MAP, rules = window.createTovilisRules(map), online = window.TovilisOnline;
  const atlasFor = hero => window.getTovilisAtlas?.(hero) || window.TOVILIS_DWARF;
  let atlas = atlasFor(null);
  const cells = new Map(map.cells.map(c => [c.id, c]));
  const $ = id => document.getElementById(id), svg = $('game-map'), ns = 'http://www.w3.org/2000/svg';
  const KEY = 'crimsonworld.tovilis.game.v9', ROUTE_KEY = KEY + '.route', V8_KEY = 'crimsonworld.tovilis.game.v8', V7_KEY = 'crimsonworld.tovilis.game.v7', V6_KEY = 'crimsonworld.tovilis.game.v6', PREVIOUS_KEY = 'crimsonworld.tovilis.game.v5', SECOND_KEY = 'crimsonworld.tovilis.game.v4', THIRD_KEY = 'crimsonworld.tovilis.game.v3', FOURTH_KEY = 'crimsonworld.tovilis.game.v2', OLD_KEY = 'crimsonworld.tovilis.walk.v1';
  const diceUI = window.createTovilisDice();
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let state = rules.create(), serialized = null, error = '', errorDetails = '', animation = 0;
  let view = [0, 0, 1448, 1086], drag = null, dragged = false, destination = null, targetEnemy = null, sceneMode = null, scenePlace = null, toastTimer = null, mapHintTimer = null, mapHintText = '', mapHintActive = false;
  const die = (sides = 6) => Math.floor(Math.random() * sides) + 1;
  function node(tag, attrs, parent, text) {
    const el = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text !== undefined) el.textContent = text;
    parent.append(el); return el;
  }
  function html(tag, parent, text, className) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    parent.append(el); return el;
  }
  function illustration(parent, sheet, index, label, className = 'scene-art') {
    const art = node('svg', {viewBox: `${index % 3 * 512} ${Math.floor(index / 3) * 512} 512 512`, preserveAspectRatio: 'xMidYMid slice', class: className, role: 'img', 'aria-label': label, overflow: 'hidden'}, parent);
    const file = rules.content.illustrationSheets?.[sheet] || `${sheet}-v1.png`;
    node('image', {href: `../assets/illustrations/${file}`, width: 1536, height: 1024}, art);
    return art;
  }
  const placeArt = {tavern: 1, 'near-tavern': 0, forge: 2, orders: 3, shop: 4, port: 5, 'city-entry': 5};
  const personArt = {merchant: 0, bard: 1, soldier: 2, bandits: 3, robber: 4};
  function millerIllustration(parent) { const img=html('img',parent,undefined,'scene-art');img.src='../assets/illustrations/miller-v3.png';img.alt='Мельник у ветряной мельницы';return img; }
  function itemIllustration(parent, item) { if (item.sheet && item.art !== undefined) return illustration(parent, item.sheet, item.art, item.name, 'item-art'); if (item.symbol) { const icon = html('span', parent, item.symbol, 'item-art item-symbol'); icon.setAttribute('aria-hidden', 'true'); return icon; } return item.art !== undefined ? illustration(parent, 'items', item.art, item.name, 'item-art') : illustration(parent, 'places', 3, item.name, 'item-art'); }
  const weightText = value => value === null ? 'не указан' : `${value.toLocaleString('ru-RU', {maximumFractionDigits: 2})} ед.`;
  const building = id => map.buildings.find(place => place.id === id);
  function storedSave() { try { return localStorage.getItem(KEY); } catch (_) { return null; } }
  function setDestination(id) {
    destination = id;
    try { if (id) localStorage.setItem(ROUTE_KEY, id); else localStorage.removeItem(ROUTE_KEY); } catch (_) { /* Navigation remains usable when storage is unavailable. */ }
  }
  function actionButton(parent, label, action, options = {}) {
    const captured = state;
    const button = html('button', parent, label, options.primary ? 'primary' : '');
    if (options.id) button.id = options.id;
    if (options.action) button.dataset.action = options.action;
    if (options.small) html('small', button, options.small);
    button.disabled = Boolean(options.disabled || error);
    button.onclick = () => { if (state === captured && !button.disabled) action(); };
    return button;
  }
  const points = id => cells.get(id).polygon.map(p => p.join(',')).join(' ');
  for (const c of map.cells) {
    node('polygon', {points: points(c.id), class: 'grid-cell'}, $('grid-layer'));
    if (c.id.startsWith('A') || c.confidence !== 'visible') node('polygon', {points: points(c.id), class: 'reveal-cell', 'data-reveal': c.id}, $('reveal-layer'));
  }
  for (const e of map.edges.filter(e => e.from.startsWith('A') && e.to.startsWith('A'))) {
    const a = cells.get(e.from).position, b = cells.get(e.to).position;
    node('path', {d: `M${a[0]},${a[1]} L${b[0]},${b[1]}`, class: 'reveal-link'}, $('reveal-layer'));
  }
  document.querySelectorAll('.portrait-art').forEach((el, index) => {
    const [x, y, width, height] = atlas.frames.south.viewBox, crop = `portrait-crop-${index}`;
    el.setAttribute('viewBox', [x, y, width, height].join(' '));
    const defs = node('defs', {}, el), clip = node('clipPath', {id: crop, clipPathUnits: 'userSpaceOnUse'}, defs);
    node('rect', {x, y, width, height}, clip);
    node('image', {href: atlas.image, width: atlas.width, height: atlas.height, 'clip-path': `url(#${crop})`}, el);
  });
  for (const item of rules.content.family) {
    const box = html('div', $('family-dialogue'), undefined, 'dialogue'); html('strong', box, item.speaker); html('p', box, item.text);
  }
  function save(next, force = false) {
    try {
      next = followRoute(next);
      rules.validate(next);
      if (!force && localStorage.getItem(KEY) !== serialized) throw new Error('Сохранение изменилось в другой вкладке. Загрузите его заново.');
      const previous = state, text = JSON.stringify(next);
      localStorage.setItem(KEY, text);
      if (!force && previous.phase === 'won' && next.phase === 'ready') { sceneMode = null; scenePlace = null; }
      else if (force || next.phase === 'ready' && (['moving', 'notice', 'outcome', 'work', 'work-result', 'tavern-game', 'hunting'].includes(previous.phase))) {
        const place = rules.at(next.position).find(b => rules.content.places[b.id]);
        sceneMode = place ? 'place' : null; scenePlace = place?.id || null;
      }
      serialized = text; state = next; error = ''; errorDetails = '';
      if (destination && (state.position === building(destination)?.cell || state.phase === 'won')) setDestination(null);
      render(); showReceipt(previous, next); return true;
    } catch (cause) { error = 'Действие не удалось сохранить. Можно повторить загрузку или сохранить копию текущей записи.'; errorDetails = cause.message; render(); return false; }
  }
  function onlineTransition(transition) {
    const calls = [], originals = new Map();
    // Record the pure rules method and its public arguments.  The first
    // argument is always the current state; it never crosses the network.
    for (const name of Object.keys(rules)) {
      if (typeof rules[name] !== 'function') continue;
      originals.set(name, rules[name]);
      rules[name] = (...args) => { calls.push({method:name, args:args.slice(1).map(value => typeof value === 'function' ? null : value)}); return originals.get(name)(...args); };
    }
    try { transition(state); } catch (cause) { for (const [name, fn] of originals) rules[name] = fn; error = cause.message; errorDetails = cause.message; render(); return false; } finally { for (const [name, fn] of originals) rules[name] = fn; }
    const call = calls.at(-1);
    if (!call) return false;
    online.context({phase:state.phase, cell:state.position, action:call.method, version:window.TOVILIS_CONTENT_VERSION || 6});
    const payload = {
      choose: {next:call.args[0], stopBuilding:call.args[1] ?? null},
      begin: {next:state.selection?.next ?? null, stopBuilding:state.selection?.stopBuilding ?? null},
      huntAction: {action:call.args[0], target:call.args[2] ?? 0},
      noticeAction: {action:call.args[0]},
      encounterAction: {action:call.args[0]},
      service: {action:call.args[0], quantity:call.args[2] ?? 1},
      bankTransfer: {action:call.args[0], amount:call.args[1]},
      equip: {slot:call.args[0], id:call.args[1] ?? null},
      battle: {action:call.args[0], targetId:call.args[2] ?? null},
      playDice: {stake:call.args[1] ?? 1},
      finishWork: {}, cancelWork: {}, drink: {}, arrive: {}, acknowledge: {},
      rename: {name:call.args[0]}, create: {name:call.args[0]}
    }[call.method] || {};
    online.command(call.method, payload, next => {
      try { const authoritative = next.state || next.game || next; state = followRoute(rules.validate(authoritative)); serialized = JSON.stringify(state); error = ''; errorDetails = ''; render(); } catch (cause) { error = 'Сервер прислал неподходящее состояние партии.'; errorDetails = cause.message; render(); }
    }).catch(cause => { error = 'Действие не удалось выполнить на сервере.'; errorDetails = cause.message; render(); });
    return true;
  }
  function load() {
    if (online?.enabled) {
      online.ready.then(snapshot => {
        if (!snapshot) return;
        try { state = rules.validate(snapshot.state || snapshot.game || snapshot); serialized = JSON.stringify(state); error = ''; errorDetails = ''; online.mount(); render(); if (state.phase === 'moving') animate(); }
        catch (cause) { error = 'Сервер прислал неподходящее состояние партии.'; errorDetails = cause.message; render(); }
      }).catch(cause => { error = 'Не удалось открыть сетевую партию.'; errorDetails = cause.message; render(); });
      return;
    }
    animation += 1; diceUI.cancel();
    try {
      const raw = localStorage.getItem(KEY), old = raw === null ? localStorage.getItem(V8_KEY) ?? localStorage.getItem(V7_KEY) ?? localStorage.getItem(V6_KEY) ?? localStorage.getItem(PREVIOUS_KEY) ?? localStorage.getItem(SECOND_KEY) ?? localStorage.getItem(THIRD_KEY) ?? localStorage.getItem(FOURTH_KEY) ?? localStorage.getItem(OLD_KEY) : null;
      const restored = raw !== null ? rules.validate(JSON.parse(raw)) : old !== null ? rules.migrate(JSON.parse(old)) : rules.create();
      state = restored;
      if (state.selection?.stopBuilding === 'far-shop' && rules.directions(state.position).find(d => d.next === state.selection.next)?.building?.id !== 'far-shop') state = {...state, selection: {...state.selection, stopBuilding: null}};
      serialized = raw; error = ''; errorDetails = '';
      const savedRoute = localStorage.getItem(ROUTE_KEY) ?? (raw === null && old !== null && [6,7,8].includes(JSON.parse(old).version) ? localStorage.getItem(`crimsonworld.tovilis.game.v${JSON.parse(old).version}.route`) : null);
      destination = building(savedRoute) && state.position !== building(savedRoute).cell && state.phase !== 'won' ? savedRoute : null;
      state = followRoute(state);
      if (raw === null && old !== null) setDestination(destination);
      const place = state.phase === 'ready' ? rules.at(state.position).find(b => rules.content.places[b.id]) : null; sceneMode = place ? 'place' : null; scenePlace = place?.id || null;
      if (raw === null && !save(restored)) return;
      render(); if (matchMedia('(max-width: 780px)').matches) focusHero(); if (state.phase === 'moving') animate();
    } catch (cause) { error = 'Исходная запись сохранена. Можно повторить загрузку, скачать копию или начать новую партию.'; errorDetails = cause.message; render(); }
  }
  function act(transition) {
    if (error || diceUI.busy) return false;
    if (online?.enabled && online.busy) return false;
    if (online?.enabled) return onlineTransition(transition);
    try { const next = transition(state); if (next === state) return true; return save(next); }
    catch (cause) { $('status').textContent = cause.message; return false; }
  }
  function select(next) {
    clearMapHint();
    if (state.phase === 'ready' && state.selection?.next === next && !error) { $('roll').click(); return; }
    act(s => rules.choose(s, next));
  }
  function positionHero(point, facing = state.facing, lift = 0) {
    atlas = atlasFor(state.hero); const [x, y] = point, frame = atlas.frames[facing] || atlas.frames.south;
    const height = 42 + Math.max(0, Math.min(1, (y - 450) / 600)) * 45;
    const width = height * frame.viewBox[2] / frame.viewBox[3];
    $('hero-layer').setAttribute('transform', `translate(${x} ${y - lift})`);
    const sprite = $('hero-sprite'); sprite.querySelector('image')?.setAttribute('href', atlas.image); sprite.setAttribute('viewBox', frame.viewBox.join(' ')); sprite.dataset.facing = facing;
    sprite.setAttribute('x', -width / 2); sprite.setAttribute('y', -height * (frame.feet[1] - frame.viewBox[1]) / frame.viewBox[3]);
    sprite.setAttribute('width', width); sprite.setAttribute('height', height);
    $('hero-shadow').setAttribute('rx', height * .22); $('hero-ring').setAttribute('rx', height * .25);
  }
  function compass(next) {
    const f = rules.facing(state.position, next);
    const dirs = {east: ['→', 'Вправо'], southeast: ['↘', 'Вниз-вправо'], south: ['↓', 'Вниз'], southwest: ['↙', 'Вниз-влево'], west: ['←', 'Влево'], northwest: ['↖', 'Вверх-влево'], north: ['↑', 'Вверх'], northeast: ['↗', 'Вверх-вправо']};
    return dirs[f];
  }
  function goalBuilding() {
    if (state.quest === 'none') return {id:'orders', message:'Первое поручение ждёт в городском Заказе — здании с буквой «З».'};
    if (state.hero.net) return {id:'port', message:'Сеть в сумке. Начальник пристани примет её и ночью.'};
    if (state.hero.coins >= 5) return {id:'shop', message:'Денег на сеть достаточно. Купите её в лавке снастей за 5 монет.'};
    const places = ['mill','port','forge'].sort((a,b)=>rules.shortestPath(state.position,building(a).cell).length-rules.shortestPath(state.position,building(b).cell).length);
    const id = places[0], night = rules.clock(state.ticks).night, noShifts = rules.workStatus(state).remaining === 0;
    const message = noShifts ? 'Сегодня две смены уже выполнены. У работодателя можно дождаться новых смен утром.' : night ? 'Сейчас ночь: дневная работа закрыта. У работодателя можно дождаться утра.' : `Сеть стоит 5 монет, у вас ${state.hero.coins}. Заработайте недостающие монеты.`;
    return {id, message};
  }
  function guideTo(id) {
    if (state.phase !== 'ready') return;
    setDestination(id); sceneMode = null; scenePlace = null;
    const target = building(id), path = rules.shortestPath(state.position, target.cell);
    if (path.length > 1) {
      const option = rules.directions(state.position).find(o => o.next === path[1]);
      act(s => rules.choose(s, path[1], option.building?.id === id ? id : null));
    } else { setDestination(null); sceneMode = 'place'; scenePlace = id; render(); }
  }
  function followRoute(next) {
    if (!destination || next.phase !== 'ready' || next.selection || next.position === building(destination)?.cell) return next;
    const path = rules.shortestPath(next.position, building(destination).cell);
    const option = rules.directions(next.position).find(direction => direction.next === path[1]);
    return option ? rules.choose(next, option.next, option.building?.id === destination ? destination : null) : next;
  }
  function mapMarker(parent, cell, label, className, onClick, door, accessibleName) {
    const [x, y] = door || cells.get(cell).position;
    const g = node('g', {class: `place-marker ${className}`, 'data-place-cell': cell, role:'button', tabindex:'0', 'aria-label':accessibleName || label}, parent);
    node('circle', {cx:x, cy:y-12, r:32, class:'marker-hit'}, g);
    node('circle', {cx: x, cy: y - 12, r: 10}, g); node('text', {x, y: y - 12}, g, label);
    g.addEventListener('click', () => { if (!dragged) onClick(); });
    g.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick(); } });
    return g;
  }
  function renderMap(options) {
    for (const id of ['choice-layer', 'preview-layer', 'target-layer', 'place-layer', 'other-player-layer', 'guide-layer']) $(id).replaceChildren();
    positionHero(cells.get(state.position).position);
    const night = rules.clock(state.ticks).night;
    if (online?.enabled) for (const player of online.state.presence || []) {
      const cell = cells.get(player.cell); if (!cell) continue;
      const [x, y] = cell.position, group = node('g', {class:'other-player-marker', 'aria-label':`${player.name || 'Игрок'} рядом`}, $('other-player-layer'));
      node('circle', {cx:x, cy:y-25, r:15, class:'other-player-dot'}, group); node('text', {x, y:y-46, class:'other-player-name'}, group, (player.name || 'Игрок').slice(0, 12));
    }
    for (const b of map.buildings.filter(b => rules.content.places[b.id])) {
      const closed = night && ['mill', 'shop', 'far-shop', 'forge'].includes(b.id);
      const label = {orders: 'З', mill: 'М', port: '⚓', shop: 'Л', 'far-shop': 'Л', forge: 'К', tavern: 'Т', 'near-tavern': 'Т', 'city-entry': '↪', 'west-house': 'О'}[b.id];
      const marker = mapMarker($('place-layer'), b.cell, label, closed ? 'closed' : '', () => { if (state.phase === 'ready') { sceneMode = 'place'; scenePlace = b.id; render(); } }, b.door, `${rules.content.places[b.id].name}${closed ? ' · ночью закрыто' : ''}`);
      marker.dataset.building = b.id; node('title', {}, marker, `${rules.content.places[b.id].name}${closed ? ' · ночью закрыто' : ''}`);
    }
    for (const c of map.cells.filter(c => c.event === 'encounter')) mapMarker($('place-layer'), c.id, 'В', 'event-marker', () => { showMapHint('Здесь возможна городская встреча. Ночью бандиты требуют деньги или нападают.'); }, null, 'Возможная случайная встреча');
    if (destination && state.phase === 'ready') {
      const b = building(destination), path = rules.shortestPath(state.position, b.cell);
      node('polyline', {points: path.map(id => cells.get(id).position.join(',')).join(' '), class: 'guide-line'}, $('guide-layer'));
    }
    if (state.phase !== 'ready' || error) return;
    options.forEach((option, index) => {
      const selected = state.selection?.next === option.next;
      const polygon = node('polygon', {points: points(option.next), class: 'choice-cell' + (selected ? ' chosen' : ''), 'data-next': option.next}, $('choice-layer'));
      polygon.addEventListener('click', () => { if (!dragged) select(option.next); });
      const [x, y] = cells.get(option.next).position;
      node('circle', {cx: x, cy: y, r: 8, class: 'choice-dot'}, $('choice-layer')); node('text', {x, y, class: 'choice-number'}, $('choice-layer'), index + 1);
      if (selected) {
        const preview = rules.plan(state.position, option.next, 6, state.selection.stopBuilding), coords = preview.path.map(id => cells.get(id).position.join(',')).join(' ');
        node('polyline', {points: coords, class: 'preview-line'}, $('preview-layer')); node('polyline', {points: coords, class: 'preview-line inner'}, $('preview-layer'));
        if (state.selection.stopBuilding) node('circle', {cx: option.building.door[0], cy: option.building.door[1], r: 13, class: 'target-circle'}, $('target-layer'));
      }
    });
  }
  function renderQuest(parent) {
    illustration(parent, 'places', 3, 'Городской Заказ: поручение и сеть на прилавке');
    html('span', parent, 'ГОРОДСКОЙ ЗАКАЗ', 'eyebrow'); html('h2', parent, 'Сеть для порта');
    const list = html('ol', parent, undefined, 'quest-steps'), step = state.quest === 'complete' ? 3 : state.quest === 'none' ? 0 : state.hero.net ? 2 : 1;
    ['Взять поручение в Заказе', 'Заработать и купить сеть', 'Доставить в порт'].forEach((label, i) => html('li', list, label, i < step ? 'done' : i === step ? 'active' : ''));
    if (state.quest === 'complete') { html('p', parent, 'Сеть доставлена, награда получена. Заказ выполнен — можно свободно гулять, работать и пользоваться услугами города.'); return; }
    const goal = goalBuilding(); html('p', parent, goal.message);
    const actions = html('div', parent, undefined, 'context-actions');
    actionButton(actions, `${state.position === building(goal.id).cell ? 'Открыть услуги' : 'Путь'}: ${rules.content.places[goal.id].name}`, () => guideTo(goal.id), {primary: true, action: 'guide-goal'});
    html('p', parent, 'Награда за доставку — 10 монет.', 'hint');
  }
  function renderPlace(parent, building) {
    const place = rules.content.places[building.id], here = building.cell === state.position, night = rules.clock(state.ticks).night;
    if (placeArt[building.id] !== undefined) illustration(parent, 'places', placeArt[building.id], place.name);
    const closed = night && ['mill', 'shop', 'far-shop', 'forge'].includes(building.id);
    if (building.id === 'mill') millerIllustration(parent);
    if (building.id === 'far-shop') illustration(parent,'portraits',0,'Травник у входа в город');
    html('span', parent, here ? 'ВЫ НА МЕСТЕ' : 'МЕСТО НА КАРТЕ', 'eyebrow'); html('h2', parent, rules.isTavern(building.id) ? place.name.split(' · ')[0] : place?.name || building.name);
    html('span', parent, closed ? `Закрыто · до утра ${18 - state.ticks % 18} х.` : rules.isTavern(building.id) ? 'Открыто круглосуточно' : building.id === 'west-house' ? 'Открыт круглосуточно' : 'Открыто', 'context-badge' + (closed ? ' closed' : ''));
    if (rules.isTavern(building.id)) {
      const about = html('details',parent,undefined,'place-about'); html('summary',about,'О заведении'); html('p',about,place.description);
    } else html('p', parent, place?.description || 'Обычный городской дом.');
    if (place && !rules.isTavern(building.id)) html('p', parent, place.hours, 'hint');
    const actions = html('div', parent, undefined, 'context-actions');
    if (!here) {
      const distance = rules.shortestPath(state.position, building.cell).length - 1;
      actionButton(actions, `Идти в эту сторону · ${distance} кл.`, () => guideTo(building.id), {primary: true, action: 'guide-place'});
      return;
    }
    if (building.id === 'west-house') { renderBank(parent); return; }
    const offers = rules.services(state, building.id).sort((a, b) => Number(['wait-opening', 'wait-work'].includes(b.id)) - Number(['wait-opening', 'wait-work'].includes(a.id)));
    if (rules.isTavern(building.id)) {
      actions.classList.add('tavern-actions');
      offers.sort((a,b) => ['rest','ale','find-dice','morning','food'].indexOf(a.id)-['rest','ale','find-dice','morning','food'].indexOf(b.id));
    }
    for (const offer of offers) {
      if (offer.id === 'food') continue;
      const selling = offer.id.startsWith('sell-');
      const itemId = selling ? offer.id.slice(5) : offer.id, item = rules.content.items[itemId] || rules.content.finds[itemId] || rules.content.artifacts[itemId] || rules.content.hunting.items[itemId];
      if(item) {
        const card=html('article',actions,undefined,'item-offer');itemIllustration(card,item);
        const info=html('div',card,undefined,'item-offer-info');html('strong',info,item.name);renderItemFacts(info,item);
        actionButton(info,`${selling ? offer.interest ? 'Предложить торговцу' : 'Продать' : 'Купить'} · ${selling ? '+' + offer.payout : offer.cost} ${word(selling ? offer.payout : offer.cost,'монета','монеты','монет')}`,()=>offer.interest ? rolled(s=>rules.service(s,offer.id,die),'trade') : act(s=>rules.service(s,offer.id,die)),{primary:!selling,disabled:!offer.enabled,action:offer.id});
        if (offer.interest) html('small', info, 'Интерес торговца — 50/50: купит на 1–3 из 6. Решение действует до завтра. Выкуп — половина нейтральной цены.', 'hint');
        else if (selling) html('small', info, 'Продажа по оценке, без пробы интереса.', 'sale-rule');
        if(offer.reason)html('small',info,offer.reason,'offer-reason');
        continue;
      }
      actionButton(actions, offer.label, () => {
        if (offer.id === 'find-dice') { rolled(s => rules.service(s, offer.id, die), 'search'); return; }
        if (act(s => rules.service(s, offer.id, die)) && offer.id === 'family') $('family-dialog').showModal();
      }, {primary: ['quest', 'hire', 'work-mill', 'deliver', 'net', 'wait-opening', 'wait-work'].includes(offer.id), disabled: !offer.enabled, small: offer.reason || [offer.cost ? `${offer.cost} ${word(offer.cost, 'монета', 'монеты', 'монет')}` : '', offer.ticks ? `${offer.ticks} х. времени` : '', offer.foodCost ? `еда: −${offer.foodCost}` : '', offer.hungerCost ? `голод: −${offer.hungerCost} ЖС` : ''].filter(Boolean).join(' · '), action: offer.id});
    }
    if (rules.isTavern(building.id)) {
      renderFoodShop(parent);
      html('p', parent, `Кости: ставка от 1 до ${rules.content.taverns[building.id].maxStake} монет. Поиск — d6, на 4–6 найдётся партнёр.`, 'hint');
    }
    if (['mill', 'port', 'forge'].includes(building.id)) { const shifts = rules.workStatus(state); html('p', parent, `Смены сегодня: ${shifts.used} из 2. Одна смена — 3 хода времени.`, 'work-limit'); }
    if (state.quest === 'active' && building.id === 'orders') html('p', parent, state.hero.net ? 'Сеть куплена, доставьте её в порт.' : 'Нужна сеть из лавки снастей за 5 монет.', 'hint');
    if (building.id === 'city-entry') html('p',parent,'Окрестности Товилиса: охота — 3 хода времени и 1 порция еды сверх обычного питания каждые 6 ходов. Праща продаётся в лавках за 2 монеты. После охоты вы остаётесь на U07.','hint');
    if (building.id === 'city-entry') actionButton(actions, 'Первое поручение', () => {sceneMode='quest';render();}, {primary:true,action:'view-first-order'});
  }
  function renderBank(parent) {
    const account = rules.bankStatus(state), cash = state.hero.coins;
    const box = html('section', parent, undefined, 'bank-panel');
    html('p', box, `Наличные: ${cash} · На счёте: ${account.balance}`, 'bank-balances');
    const row = html('div', box, undefined, 'bank-controls');
    const label = html('label', row, 'Сумма монет');
    const amount = html('input', label); amount.id = 'bank-amount'; amount.type = 'number'; amount.min = '1'; amount.step = '1'; amount.value = '1'; amount.inputMode = 'numeric';
    // «Всё» uses the selected source; both actions have independent previews.
    const source = html('label', row, 'Всё для операции');
    const direction = html('select', source); direction.id = 'bank-direction'; direction.setAttribute('aria-label', 'Направление операции');
    for (const [value, text] of [['deposit', 'Положить'], ['withdraw', 'Снять']]) { const option = html('option', direction, text); option.value = value; }
    actionButton(row, 'Всё', () => { amount.value = String(direction.value === 'deposit' ? cash : account.balance); update(); }, {action:'bank-all'});
    const preview = html('p', box, undefined, 'bank-preview'); preview.id = 'bank-preview'; preview.setAttribute('aria-live', 'polite');
    const actions = html('div', box, undefined, 'context-actions');
    const deposit = actionButton(actions, 'Положить', () => act(s => rules.bankTransfer(s, 'deposit', Number(amount.value))), {primary:true, action:'bank-deposit'});
    const withdraw = actionButton(actions, 'Снять', () => act(s => rules.bankTransfer(s, 'withdraw', Number(amount.value))), {action:'bank-withdraw'});
    function update() {
      const n = Number(amount.value), valid = Number.isSafeInteger(n) && n > 0;
      deposit.disabled = Boolean(error) || !valid || n > cash || !Number.isSafeInteger(account.balance + n);
      withdraw.disabled = Boolean(error) || !valid || n > account.balance || !Number.isSafeInteger(cash + n);
      const line = (text, enabled, cashAfter, bankAfter) => `${text}: ${enabled ? `наличные ${cashAfter}, счёт ${bankAfter}` : 'недоступно'}`;
      preview.textContent = valid ? `${line('Положить', !deposit.disabled, cash-n, account.balance+n)}. ${line('Снять', !withdraw.disabled, cash+n, account.balance-n)}.` : 'Введите положительное целое число монет.';
    }
    amount.oninput = update; direction.onchange = update; update();
    html('h3', box, 'История операций');
    if (!account.history.length) html('p', box, 'Операций пока нет.');
    const entries = account.history.slice().reverse();
    const history = (target, items) => { const list = html('ol', target, undefined, 'bank-history'); for (const e of items) html('li', list, `Ход ${e.turn} · ${e.action === 'deposit' ? 'Внесено' : 'Снято'} ${e.amount} · наличные ${e.cash}, счёт ${e.balance}`); };
    history(box, entries.slice(0, 5));
    if (entries.length > 5) { const details = html('details', box); html('summary', details, 'Предыдущие операции'); history(details, entries.slice(5)); }
  }
  function renderFoodShop(parent) {
    const inn = rules.tavernProfile(state);
    const disclosure = html('details', parent, undefined, 'food-disclosure');
    html('summary', disclosure, `Еда в дорогу · ${inn.foodPortions} ${word(inn.foodPortions,'порция','порции','порций')} за 1 монету`);
    disclosure.open = !matchMedia('(max-width: 780px)').matches;
    const box = html('section', disclosure, undefined, 'food-shop');
    itemIllustration(box, rules.content.items.food);
    html('h3', box, 'Еда в дорогу');
    html('p', box, `1 набор — ${inn.foodPortions} порции за 1 монету. Покупка не расходует ход.`, 'hint');
    const row = html('div', box, undefined, 'food-buy-row'), label = html('label', row, 'Наборов');
    const amount = html('input', label); amount.type = 'number'; amount.id = 'food-quantity'; amount.min = 1; amount.max = Math.max(1, state.hero.coins); amount.step = 1; amount.value = '1'; amount.disabled = state.hero.coins < 1;
    const buy = actionButton(row, '', () => act(s => rules.service(s, 'food', die, Number(amount.value))), {primary: true, action: 'food'});
    const total = html('p', box, undefined, 'hint'); total.id = 'food-total';
    function update() {
      const qty = Number(amount.value), valid = Number.isSafeInteger(qty) && qty >= 1 && qty <= state.hero.coins;
      buy.disabled = !valid || Boolean(error);
      buy.textContent = valid ? `Купить · ${qty} ${word(qty, 'монета', 'монеты', 'монет')}` : 'Купить еду';
      const portions = qty * inn.foodPortions;
      total.textContent = valid ? `Получите ${portions} ${word(portions, 'порцию', 'порции', 'порций')}. Останется монет: ${state.hero.coins - qty}.` : state.hero.coins < 1 ? 'Для покупки нужна хотя бы 1 монета.' : 'Выберите количество в пределах своих монет.';
    }
    amount.oninput = update; update();
  }
  function combatReport(parent, encounter) {
    if (!encounter.report) return;
    const report = encounter.report;
    const dealt = report.hits.filter(hit => hit.attacker === 'hero').reduce((sum, hit) => sum + hit.damage, 0);
    const received = report.hits.filter(hit => hit.attacker && hit.attacker !== 'hero').reduce((sum, hit) => sum + hit.damage, 0);
    const healed = report.hits.reduce((sum, hit) => sum + (hit.heal || 0), 0);
    const result = report.flee ? `Бегство ${report.flee.roll >= report.flee.threshold ? 'удалось' : 'не удалось'} · получено ${received}` : report.action === 'switch' ? `${report.switch ? `смена на ${rules.content.items[report.switch.to].name}` : 'сменить оружие не удалось'} · получено ${received}` : `нанесено ${dealt} · получено ${received}${healed ? ` · лечение +${healed}` : ''}`;
    html('div', parent, `Раунд ${report.round}: ${result}. Силы ${state.hero.hp}/${state.hero.maxHp}.`, 'round-summary');
    const details = html('details', parent, undefined, 'round-details'); html('summary', details, 'Броски раунда');
    const list = html('ul', details);
    report.initiative.forEach(item => html('li', list, `${item.id === 'hero' ? state.hero.name : encounter.enemies.find(e => e.id === item.id).name}: инициатива ${item.die} + ${item.agility} = ${item.total}`));
    if (report.flee) html('li', list, `Бегство: ${report.flee.roll}, нужно ${report.flee.threshold}+.`);
    if (report.switch) html('li', list, `Смена оружия: ${rules.content.items[report.switch.from].name} → ${rules.content.items[report.switch.to].name}. Действие героя потрачено.`);
    report.hits.forEach(hit => html('li', list, hit.heal !== undefined ? `Зелье: +${hit.heal} сил.` : `${hit.attacker === 'hero' ? 'Ваш удар' : 'Удар врага'}: ${hit.attackDie} + ${hit.bonus} − ${hit.absorption} = ${hit.damage} урона.`));
  }
  function moveDescription(move) {
    const steps=move.path.length-1, place=rules.at(move.path.at(-1)).find(b=>rules.content.places[b.id]);
    const stop=move.reason==='junction'?'Перекрёсток':move.reason==='dead_end'?'Конец улицы':move.reason==='building'?'Вход в здание':'Остановка по кубику';
    return {title:'Твой ход',rolls:[{value:move.roll,label:'Шаги · d6'}],result:move.unused?`До остановки — ${steps} ${word(steps,'шаг','шага','шагов')}`:'Путь свободен',detail:(place?rules.content.places[place.id].name:stop)+(move.movementPenalty?' · Головная боль: путь короче на шаг, минимум один шаг.':'')};
  }
  function resultDice(parent, dice, text) {
    const box=html('div',parent,undefined,'saved-roll');
    for(const roll of dice){const face=html('span',box,String(roll.value),'saved-die');face.setAttribute('aria-label',`${roll.label}: ${roll.value}`);}
    html('strong',box,text);
  }
  async function rolled(transition, kind) {
    const before=state;
    if(!act(transition))return;
    if (online?.enabled) {
      try { await online.state.pending; } catch (_) { return; }
    }
    const committed=state;let display;
    if(kind==='move')display=moveDescription(state.pending);
    else if(kind==='work')display={title:'Плата за смену',rolls:[{value:state.job.roll,label:'Оплата · d6'}],result:`Заработано ${state.job.pay} ${word(state.job.pay,'монета','монеты','монет')}`,detail:'Плата уже в кошельке.'};
    else if(kind==='search')display={title:'Кто сыграет в кости?',rolls:[{value:state.tavernGame.searchRoll,label:'Поиск · d6'}],result:state.tavernGame.stage==='found'?'Партнёр нашёлся':'Пока никто не играет',detail:'Желающий находится на 4–6.'};
    else if(kind==='trade'){const t=state.lastTrade;display={title:'Нужна ли вещь торговцу?',rolls:[{value:t.roll,label:'Интерес · d6'}],result:t.accepted?`Вещь продана · +${t.payout} ${word(t.payout,'монета','монеты','монет')}`:'Сегодня вещь не нужна',detail:t.accepted?'Сделка завершена, монеты в кошельке.':'Вещь остаётся у вас. Новая попытка в этой лавке — завтра.'};}
    else if(kind==='notice'){const n=state.notice;if(n.rolls.length)display={title:rules.noticeCard(state).title,rolls:n.rolls.map(r=>({value:r.value,label:`${r.label} · d${r.sides}`})),result:n.text};}
    else if(kind==='wager'){const g=state.tavernGame;display={title:'Кости в таверне',rolls:[{value:g.heroRoll,label:'Твой кубик'},{value:g.visitorRoll,label:'Посетитель'}],result:g.delta>0?`Выигрыш +${g.delta}`:g.delta<0?`Проигрыш ${g.delta}`:'Ничья · ставка вернулась',detail:`Ставка ${g.stake} ${word(g.stake,'монета','монеты','монет')}.`};}
    else {
      const report=state.encounter?.report, hit=report?.hits.find(h=>h.attacker==='hero'), init=report?.initiative.find(i=>i.id==='hero');
      const value=report?.flee?.roll ?? hit?.attackDie ?? init?.die;
      if(value)display={title:report.flee?'Попытка уйти':hit?'Ваш удар':'Ход в бою',rolls:[{value,label:report.flee?'Бегство · d6':hit?'Атака · d6':'Инициатива · d6'}],result:report.flee?state.outcome?.kind==='flee'?'Удалось уйти':'Не удалось оторваться':hit?`Урон противнику: ${hit.damage}`:report.action==='switch'?report.switch?'Оружие сменено':'Не успел сменить оружие':report.hits.some(h=>h.heal!==undefined)?'Зелье использовано':'Не успел выпить зелье',detail:`Жизненные силы: ${before.hero.hp} → ${state.hero.hp}.${hit ? ` Атака: ${hit.attackDie} + ${hit.bonus} − ${hit.absorption}.` : report?.switch ? ` Теперь: ${rules.content.items[report.switch.to].name}.` : ''}`};
    }
    if(display && !await diceUI.show(display))return;
    if(state!==committed)return;
    if(kind==='move')animate();
    else if(kind==='battle')ensureVisible(cells.get(state.position).position);
  }
  function doBattle(action, target = targetEnemy) {
    if(action==='surrender'){if(act(s=>rules.battle(s,action,die,target)))ensureVisible(cells.get(state.position).position);}
    else rolled(s=>rules.battle(s,action,die,target),'battle');
  }
  function heroCombatSummary(hero) {
    const weaponId = rules.equippedWeapon(hero), weaponBonus = rules.content.items[weaponId].effects.attack;
    return `Ваши силы ${hero.hp}/${hero.maxHp} · ${rules.content.items[weaponId].name} · атака d6 + сила ${hero.strength}${weaponBonus ? ` + оружие ${weaponBonus}` : ''} · защита ${hero.defense} · ловкость ${hero.agility}`;
  }
  function renderEncounter(parent) {
    const e = state.encounter, card = rules.content.encounters[e.kind];
    illustration(parent, state.phase === 'combat' ? 'events' : 'portraits', state.phase === 'combat' ? e.kind === 'bandits' ? 3 : 4 : personArt[e.kind], state.phase === 'combat' ? `Бой: ${card.name}` : card.name);
    html('span', parent, e.hostile ? state.phase === 'combat' ? `БОЙ · РАУНД ${e.round + 1}` : 'ОПАСНАЯ ВСТРЕЧА' : 'ГОРОДСКАЯ ВСТРЕЧА', 'eyebrow');
    html('h2', parent, card.name);
    if (e.report) combatReport(parent, e);
    if(state.phase==='encounter')html('p',parent,`Встреча: d6 → ${e.roll}${e.countRoll?` · состав: d6 → ${e.countRoll}`:''}`,'quiet-roll');
    html('p', parent, state.phase === 'combat' ? 'Выберите цель и действие. Броски атаки и защиты определят урон.' : !e.hostile && card.peaceful ? card.peaceful : card.text);
    if (!e.hostile) {
      if (e.protectedByArtifact) html('p', parent, 'Слеза Сострадания не позволяет обычным противникам напасть. Она также запрещает вам проявлять агрессию.', 'hint');
      if (e.kind === 'robber') {
        const enemy = e.enemies[0];
        html('div', parent, heroCombatSummary(state.hero), 'battle-stats');
        const box = html('div', html('div', parent, undefined, 'enemy-grid'), undefined, 'enemy');
        html('strong', box, `${enemy.name} · ${enemy.hp}/${enemy.maxHp} ЖС`);
        html('small', box, `Атака d6+${enemy.attackBonus} · защита ${enemy.defense} · ловкость ${enemy.agility}`);
      }
      const actions = html('div', parent, undefined, 'context-actions');
      if (e.kind === 'merchant') actionButton(actions, 'Купить зелье · 3 монеты', () => act(s => rules.encounterAction(s, 'buy')), {disabled: state.hero.coins < 3 || state.hero.potions >= 3, small: state.hero.potions >= 3 ? 'Сумка полна' : state.hero.coins < 3 ? 'Не хватает монет' : '+5 жизненных сил при использовании', action: 'encounter-buy'});
      if (e.kind === 'bard') actionButton(actions, 'Исцелиться · 4 монеты', () => act(s => rules.encounterAction(s, 'heal')), {disabled: state.hero.coins < 4 || state.hero.hp === state.hero.maxHp, action: 'encounter-heal'});
      if (e.kind === 'robber' && !e.protectedByArtifact) actionButton(actions, 'Вызвать разбойника на бой', () => act(s => rules.encounterAction(s, 'provoke')), {action: 'provoke'});
      actionButton(actions, 'Продолжить путь', () => act(s => rules.encounterAction(s, 'pass')), {primary: true, action: 'pass'}); return;
    }
    if (state.hero.hp <= 6) html('p', parent, state.phase === 'combat' ? 'Вы ранены. Можно выпить зелье, бежать или сдаться.' : 'Вы ранены. Зелье, откуп или отступление могут спасти жизнь.', 'warning');
    if (e.enemies.filter(enemy => enemy.hp > 0).length > 1) html('p', parent, 'Противников двое. Каждый живой враг атакует в раунде.', 'warning');
    const weaponId = rules.equippedWeapon(state.hero);
    html('div', parent, heroCombatSummary(state.hero), 'battle-stats');
    if (!e.enemies.some(enemy => enemy.id === targetEnemy && enemy.hp > 0)) targetEnemy = e.enemies.find(enemy => enemy.hp > 0)?.id;
    const enemies = html('div', parent, undefined, 'enemy-grid');
    for (const enemy of e.enemies) {
      const box = html('div', enemies, undefined, 'enemy' + (enemy.id === targetEnemy ? ' selected' : '') + (enemy.hp === 0 ? ' dead' : ''));
      const label = html('label', box), radio = html('input', label); radio.type = 'radio'; radio.name = 'target'; radio.value = enemy.id; radio.dataset.enemy = enemy.id; radio.checked = enemy.id === targetEnemy; radio.disabled = enemy.hp === 0;
      radio.onchange = () => { targetEnemy = enemy.id; render(); };
      html('span', label, `${enemy.name}${e.enemies.length > 1 ? ' ' + enemy.id.at(-1) : ''} · ${enemy.hp}/${enemy.maxHp}`);
      const bar = html('div', box, undefined, 'enemy-hp'); html('span', bar).style.width = `${enemy.hp / enemy.maxHp * 100}%`;
      html('small', box, `Атака d6+${enemy.attackBonus} · защита ${enemy.defense} · ловкость ${enemy.agility}`);
    }
    const actions = html('div', parent, undefined, 'context-actions');
    actionButton(actions, e.round ? `Атаковать: ${e.enemies.find(enemy => enemy.id === targetEnemy)?.name || 'цель'}` : 'Дать отпор', () => doBattle('attack'), {primary: true, action: 'attack'});
    if (state.hero.sword) {
      const other = weaponId === 'sword' ? 'shortSword' : 'sword';
      actionButton(actions, `Сменить оружие: ${rules.content.items[other].name}`, () => doBattle('switch', other), {action: 'switch-weapon', small:'Занимает действие в раунде; враги отвечают'});
    }
    if (state.phase === 'encounter') actionButton(actions, `Заплатить ${e.demand} монеты`, () => act(s => rules.encounterAction(s, 'pay')), {disabled: state.hero.coins < e.demand, small: state.hero.coins < e.demand ? 'Не хватает монет' : 'Закончить встречу без боя', action: 'pay'});
    actionButton(actions, `Выпить зелье · осталось ${state.hero.potions}`, () => doBattle('potion'), {disabled: state.hero.potions === 0 || state.hero.hp === 16, small: '+5 сил вместо атаки; враги отвечают', action: 'battle-potion'});
    const minor = html('div', parent, undefined, 'minor-actions');
    actionButton(minor, `Бежать · d6 ≥ ${rules.escapeThreshold(state)}`, () => doBattle('flee'), {action: 'flee', small:'Неудача: все живые враги атакуют'});
    actionButton(minor, 'Сдаться', () => $('surrender-dialog').showModal(), {action: 'surrender'});
  }
  function renderHunt(parent) {
    const h = state.hunt, {row, animal, skill, aim} = rules.huntingProfile(state);
    html('span', parent, 'БК · U07 · ОКРЕСТНОСТИ ТОВИЛИСА', 'eyebrow');
    html('h2', parent, `${animal.name} × ${row.count}`);
    resultDice(parent, [{value:h.roll,label:'Встреча d20'}, ...(h.behavior ? [{value:h.behavior,label:'Поведение d6'}] : [])], `Исход ${h.roll} из 20`);
    const damage = animal.damageCount ? `${animal.damageCount}d6 + ${animal.damageBonus}` : 'не атакует';
    html('p',parent,`ЖС ${animal.hp} · сила ${animal.strength ?? '—'} · урон ${damage} · защита ${animal.defense} · ловкость ${animal.agility ?? 'не имеет значения'}.`);
    html('p',parent,`Ваши силы: ${state.hero.hp}/${state.hero.maxHp} ЖС · добыто зверей: ${h.hp.filter(hp=>!hp).length}/${row.count} · раунд ${h.round}.`,'round-summary');
    const meat = animal.meat ? `Мясо × ${animal.meat}` : 'Без мяса';
    html('p',parent,`За каждого добытого зверя: ${meat}${animal.trophies.map(id=>` · ${rules.content.hunting.items[id].name} × 1`).join('')}.`, 'hint');
    html('p',parent, h.fled ? 'Кабан убежал: на броске поведения выпало 6.' : animal.rangedOnly ? 'Сразу убегает или улетает. Только метательное оружие: один выстрел по одной цели, выжившие уходят.' : h.hostile ? 'Зверь нападает. Отказаться без риска нельзя: атакуйте или пробуйте бежать.' : 'Можно отказаться без боя. При нападении зверь защищается.');
    html('p',parent,`Первый выстрел — до сближения. В ближнем бою и следующих раундах первым действует тот, у кого d6 + ловкость выше; равенство — в пользу героя. Праща: d6 + меткость ${aim}. Навык «Охота»: +${skill} к урону.`, 'hint');
    if (h.roll === 1) html('p',parent,'Очень редкий · плачущий и безногий (пометка источника).', 'hint');
    if (h.roll === 18) html('p',parent,`Медведь сам нападает только при 5–6; выпало ${h.behavior}.`, 'hint');
    if (h.stage === 'result') {
      const labels = {victory:'Добыча получена', 'animal-fled':'Выжившие звери убежали', declined:'Вы прошли мимо', escaped:'Вы ушли от зверей', defeat:'Поражение · восстановлено до 8 ЖС, потеряна половина монет; добыча оставлена'};
      html('h3',parent,labels[h.result]);
      const loot = html('div',parent,undefined,'inventory-grid');
      for (const [id,count] of Object.entries(h.loot)) {
        const item = rules.content.hunting.items[id], card = html('article',loot,undefined,'inventory-item');
        card.dataset.loot = id; itemIllustration(card,item); const text = html('div',card);
        html('strong',text,`${item.name} × ${count}`); html('p',text,item.detail,'hint');
      }
      const kills = h.hp.filter(hp=>!hp).length;
      html('p',parent,`Опыт: +${h.result === 'defeat' ? 0 : kills}. Вы остались на U07.`);
      actionButton(html('div',parent,undefined,'context-actions'),'Вернуться к городским занятиям',()=>act(s=>rules.acknowledge(s)),{primary:true,action:'hunt-done'});
    } else {
      let target = h.hp.findIndex(hp=>hp>0);
      const label = html('label',parent,'Цель: '), select = html('select',label);select.id='hunt-target';
      h.hp.forEach((hp,i)=>{if(hp>0){const option=html('option',select,`${animal.name} ${i+1} · ${hp}/${animal.hp} ЖС`);option.value=String(i);}});
      select.onchange=()=>{target=Number(select.value);};
      const actions = html('div',parent,undefined,'context-actions');
      for (const action of rules.huntingActions(state)) actionButton(actions,action.label,()=>act(s=>rules.huntAction(s,action.id,die,target)),{primary:['melee','shoot'].includes(action.id),disabled:!action.enabled,small:action.reason || '',action:`hunt-${action.id}`});
    }
    const details = html('details',parent,undefined,'round-details');html('summary',details,`Броски сохранены · раунд ${h.round}`);
    const list=html('ul',details);for(const roll of h.rolls)html('li',list,`${roll.label}: ${roll.value} (d${roll.sides})`);
  }

  function renderContext() {
    const parent = $('context'); parent.replaceChildren();
    if (error) return;
    if (state.phase === 'hunting') { renderHunt(parent); return; }
    if (state.phase === 'notice' && state.pending.noticeVersion === 3) {
      const card = rules.noticeCard(state), n = state.notice;
      const found = rules.noticeFind(state);
      if (found) {
        const art = illustration(parent, found.sheet, found.art, `Находка: ${found.name}`, 'scene-art found-item-art');
        art.dataset.itemId = found.id;
      } else illustration(parent, 'events', card.art, card.title);
      html('span', parent, 'ГОРОДСКОЕ ИЗВЕЩЕНИЕ', 'eyebrow'); html('h2', parent, card.title);
      html('p', parent, n.stage === 'choice' ? card.text : n.text);
      if (n.stage === 'choice') { const actions = html('div', parent, undefined, 'context-actions'); for (const [id, label] of card.actions) {
        const blocked = card.id === 'elf' && id === 'help' && state.hero.potions === 0;
        actionButton(actions, label, () => rolled(s => rules.noticeAction(s, id, die), 'notice'), {primary: id !== 'pass', disabled: blocked, small: blocked ? 'В сумке нет лечебного зелья' : '', action: `notice-${id}`});
      }} else {
        if (n.rolls.length) resultDice(parent, n.rolls, 'Результат проверки');
        html('p', parent, `Перемещение и событие: ${1 + n.extraTicks} ${word(1 + n.extraTicks, 'ход', 'хода', 'ходов')} времени.`, 'hint');
        actionButton(html('div', parent, undefined, 'context-actions'), 'Дальше', () => act(s => rules.acknowledge(s)), {primary: true, id: 'acknowledge'});
      }
      return;
    }
    if (state.phase === 'notice') {
      const roll = state.landing.roll;
      const notice = state.pending.noticeVersion === 2 ? rules.content.notices[roll - 1] : null;
      illustration(parent, 'events', notice?.art ?? (roll <= 2 ? 0 : roll <= 4 ? 1 : 2), notice?.title || (roll <= 2 ? 'Объявление о работе' : roll <= 4 ? 'Найденная монета' : 'Гном споткнулся'));
      html('span', parent, `ИЗВЕЩЕНИЕ · КУБИК ${roll}`, 'eyebrow');
      html('h2', parent, notice?.title || (roll <= 2 ? 'Работа в порту' : roll <= 4 ? 'Монета на мостовой' : 'Неровный камень'));
      html('p', parent, notice?.text || (roll <= 2 ? 'На пристани ищут помощников. Приходите днём: грузчики платят за каждую смену.' : roll <= 4 ? 'Между камнями блеснула монета. +1 монета в сумку.' : 'Гном споткнулся о камень. −1 жизненная сила, но не ниже 1.'));
      actionButton(html('div', parent, undefined, 'context-actions'), 'Прочитал', () => act(s => rules.acknowledge(s)), {primary: true, id: 'acknowledge'}); return;
    }
    if (state.phase === 'tavern-game') {
      const game = state.tavernGame;
      illustration(parent, 'events', 5, 'Кости и монеты на столе таверны');
      html('span', parent, 'КОСТИ В ТАВЕРНЕ', 'eyebrow');
      html('h2', parent, game.stage === 'empty' ? 'Сейчас никто не играет' : game.stage === 'found' ? 'Партнёр нашёлся' : game.delta > 0 ? 'Удачный бросок' : game.delta < 0 ? 'Сегодня удача у соперника' : 'Ничья');
      if(game.stage==='result')resultDice(parent,[{value:game.heroRoll,label:'Гном'},{value:game.visitorRoll,label:'Посетитель'}],game.delta?`${game.delta>0?'+':''}${game.delta} ${word(Math.abs(game.delta),'монета','монеты','монет')}`:'Ничья');
      html('p', parent, game.stage === 'empty' ? `Кубик поиска: ${game.searchRoll}. Посетители заняты своими разговорами. Попытаться снова можно, вернувшись в зал.` : game.stage === 'found' ? `Кубик поиска: ${game.searchRoll}. Посетитель освобождает место за столом. Выберите ставку. Каждый бросает d6: большее число побеждает, при ничьей деньги возвращаются.` : `Ставка: ${game.stake}. Ваш кубик: ${game.heroRoll}. Кубик посетителя: ${game.visitorRoll}. ${game.delta > 0 ? `Вы выиграли ${game.delta} ${word(game.delta, 'монету', 'монеты', 'монет')}.` : game.delta < 0 ? `Вы проиграли ${-game.delta} ${word(-game.delta, 'монету', 'монеты', 'монет')}.` : 'Ставка возвращена, монет столько же.'}`);
      const receipt = html('div', parent, undefined, 'resource-receipt');
      html('span', receipt, `Время: ${game.stage === 'result' ? 2 : 1} ${game.stage === 'result' ? 'хода' : 'ход'} с начала поиска`);
      if (game.foodUsed) html('span', receipt, `Еда: −${game.foodUsed} порция`, 'loss');
      if (game.hungerDamage) html('span', receipt, `Голод: −${game.hungerDamage} ЖС`, 'loss');
      if (game.stage === 'result') html('span', receipt, `Монеты: ${game.delta > 0 ? '+' : ''}${game.delta}`, game.delta > 0 ? 'gain' : game.delta < 0 ? 'loss' : '');
      const actions = html('div', parent, undefined, 'context-actions');
      if (game.stage === 'found') {
        const limit = rules.content.taverns[game.place].maxStake, label = html('label', actions, `Ставка · от 1 до ${limit} монет`, 'stake-picker'), input = html('select', label);
        input.id = 'dice-stake'; input.disabled = state.hero.coins < 1;
        for (let stake = 1; stake <= Math.min(limit, state.hero.coins); stake++) { const option = html('option', input, `${stake} ${word(stake, 'монета', 'монеты', 'монет')}`); option.value = stake; }
        actionButton(actions, 'Бросить кости', () => rolled(s => rules.playDice(s, die, Number(input.value)), 'wager'), {primary: true, disabled: state.hero.coins < 1, small: state.hero.coins < 1 ? 'Не хватает монеты для ставки' : 'Партия занимает ещё 1 ход времени', action: 'play-dice'});
      }
      actionButton(actions, 'Вернуться в зал', () => act(s => rules.acknowledge(s)), {primary: game.stage !== 'found', id: 'acknowledge'});
      return;
    }
    if (['work', 'work-result'].includes(state.phase)) {
      const j = state.job, place = rules.content.places[j.place];
      if(j.place==='mill')millerIllustration(parent);else illustration(parent,'places',placeArt[j.place],place.name);
      html('span', parent, state.phase === 'work' ? 'РАБОЧАЯ СМЕНА' : 'СМЕНА ОКОНЧЕНА', 'eyebrow');
      html('h2', parent, state.phase === 'work' ? place.name : 'Плата за труд');
      if(state.phase==='work-result')resultDice(parent,[{value:j.roll,label:'Оплата d6'}],`Заработано +${j.pay} ${word(j.pay,'монета','монеты','монет')}`);
      else html('p', parent, rules.content.work.tasks[j.place]);
      const receipt = html('div', parent, undefined, 'resource-receipt');
      html('span', receipt, `Время: ${j.ticks} хода`, 'loss');
      if (state.phase === 'work') {
        html('span', receipt, 'Оплата: 1–3 монеты', 'gain');
        const meals = Math.floor((state.ticks + j.ticks) / 6) - Math.floor(state.ticks / 6);
        if (meals) html('span', receipt, state.hero.food ? 'Еда: −1 порция' : state.hero.hp > 1 ? 'Голод: −1 ЖС' : 'Силы останутся на 1', 'loss');
        html('p', parent, 'Бросьте кубик оплаты: 1–2 — одна монета, 3–4 — две, 5–6 — три.', 'hint');
        const actions = html('div', parent, undefined, 'context-actions');
        actionButton(actions, 'Выполнить смену · бросить кубик', () => rolled(s => rules.finishWork(s, die), 'work'), {primary: true, action: 'perform-work'});
        actionButton(actions, 'Передумать', () => act(s => rules.cancelWork(s)), {action: 'cancel-work'});
      } else {
        if(j.foodUsed)html('span',receipt,`Еда: −${j.foodUsed} порция`,'loss');
        if(j.hungerDamage)html('span',receipt,`Голод: −${j.hungerDamage} ЖС`,'loss');
        html('p', parent, `Смен сегодня: ${rules.workStatus(state).used} из 2.`, 'hint');
        actionButton(html('div', parent, undefined, 'context-actions'), 'Закончить смену', () => act(s => rules.acknowledge(s)), {primary: true, id: 'acknowledge'});
      }
      return;
    }
    if (['encounter', 'combat'].includes(state.phase)) { renderEncounter(parent); return; }
    if (state.phase === 'outcome') {
      illustration(parent, 'portraits', personArt[state.encounter.kind], rules.content.encounters[state.encounter.kind].name);
      html('span', parent, 'ИСХОД ВСТРЕЧИ', 'eyebrow'); html('div', parent, state.outcome.kind === 'victory' ? '✦' : '◇', 'outcome-symbol');
      html('h2', parent, state.outcome.title); html('p', parent, state.outcome.text);
      actionButton(html('div', parent, undefined, 'context-actions'), 'Продолжить путь', () => act(s => rules.acknowledge(s)), {primary: true, id: 'acknowledge'});
      combatReport(parent, state.encounter); return;
    }
    if (state.phase === 'won') {
      illustration(parent, 'places', 5, 'Сеть доставлена в порт');
      html('span', parent, 'ЗАКАЗ ВЫПОЛНЕН', 'eyebrow'); html('div', parent, '✦', 'outcome-symbol'); html('h2', parent, 'Сеть доставлена');
      html('p', parent, `Начальник пристани благодарит ${state.hero.name}. Получено 10 монет. Заказ выполнен — путешествие продолжается.`);
      html('p', parent, `Перемещений: ${state.turn}. Осталось монет: ${state.hero.coins}.`);
      const actions = html('div', parent, undefined, 'context-actions');
      actionButton(actions, 'Продолжить прогулку', () => act(s => rules.acknowledge(s)), {primary: true, id: 'acknowledge'});
      actionButton(actions, 'Новая партия', () => $('reset-dialog').showModal()); return;
    }
    if (state.phase === 'moving') { html('span', parent, 'В ДОРОГЕ', 'eyebrow'); html('h2', parent, `Выпало ${state.pending.roll}`); html('p', parent, `Идём ${state.pending.path.length - 1} кл.`); return; }
    const current = rules.at(state.position).find(b => rules.content.places[b.id]);
    if (sceneMode === 'quest') { renderQuest(parent); return; }
    const selected = map.buildings.find(b => b.id === scenePlace);
    if (selected && selected.id !== current?.id) {
      renderPlace(parent, selected);
      if (current) actionButton(html('div', parent, undefined, 'context-actions'), `Здесь: ${rules.content.places[current.id].name}`, () => { sceneMode = 'place'; scenePlace = current.id; render(); }, {action: 'current-place'});
    }
    else if (current) renderPlace(parent, current);
    else renderQuest(parent);
  }
  function render() {
    const focusedAction = document.activeElement?.dataset.action;
    const focusedDirection = document.activeElement?.dataset.direction;
    const focusedEnemy = document.activeElement?.dataset.enemy;
    const time = rules.clock(state.ticks), h = state.hero;
    atlas = atlasFor(h);
    document.querySelectorAll('.portrait-art image').forEach(image => { image.setAttribute('href', atlas.image); image.setAttribute('width', atlas.width); image.setAttribute('height', atlas.height); });
    $('hero-name').textContent = h.name; $('hp').textContent = `${h.hp} / ${h.maxHp}`; $('health-meter').max = h.maxHp; $('health-meter').value = h.hp;
    $('health-meter').textContent = `${h.hp} из ${h.maxHp}`; $('food').textContent = h.food; $('coins').textContent = h.coins; $('potions').textContent = h.potions; $('experience').textContent = h.experience;
    $('drink').disabled = state.phase !== 'ready' || !h.potions || h.hp === h.maxHp || Boolean(error);
    $('day').textContent = `День ${time.day}`;
    $('time').textContent = time.night ? 'Ночь' : state.ticks % 18 < 4 ? 'Утро' : state.ticks % 18 < 8 ? 'День' : 'Вечер';
    $('time-icon').textContent = time.night ? '☾' : '☀';
    $('time-until').textContent = `${time.night ? 'До утра' : 'До ночи'}: ${time.remaining} ${word(time.remaining, 'ход', 'хода', 'ходов')} времени`;
    const reserveDays=Math.floor(h.food/3),reserveTicks=h.food%3*6;
    $('next-meal').textContent = h.food ? `На ${reserveDays?`${reserveDays} ${word(reserveDays,'день','дня','дней')}`:''}${reserveDays&&reserveTicks?' и ':''}${reserveTicks?`${reserveTicks} ${word(reserveTicks,'ход','хода','ходов')}`:''}` : 'Пора пополнить запас';
    $('next-meal').title = `Одна порция на 6 ходов времени, 3 порции на сутки. Следующий приём пищи через ${6-state.ticks%6} ${word(6-state.ticks%6,'ход','хода','ходов')}. Оценка запаса не включает уже съеденную еду.`;
    $('food-details').textContent = `Следующая порция через ${6-state.ticks%6} ${word(6-state.ticks%6,'ход','хода','ходов')} времени. Одна порция на 6 ходов.`;
    $('day-track').replaceChildren();
    for (let i = 0; i < 18; i++) html('span', $('day-track'), undefined, [i >= 12 ? 'dark' : '', i < state.ticks % 18 ? 'elapsed' : '', i === state.ticks % 18 ? 'current' : ''].join(' '));
    document.querySelector('.map-canvas').classList.toggle('night', time.night);
    $('night-tint').setAttribute('opacity', time.night ? '.44' : '0');
    document.body.classList.toggle('event-active', !['ready', 'moving'].includes(state.phase));

    $('save-error').hidden = !error; $('save-error-text').textContent = error; $('save-error-details').textContent = errorDetails;
    $('export-save').disabled = !storedSave(); $('save-status').textContent = error ? 'Ошибка сохранения' : 'Сохранено';
    $('portrait').disabled = state.phase === 'moving' || Boolean(error); $('turn-number').textContent = `Перемещение ${state.turn + 1}`;
    const place = rules.at(state.position)[0]; $('where').textContent = place?.name || (state.position === 'J08' ? 'У бассейна' : cells.get(state.position).kind === 'junction' ? 'Перекрёсток' : 'Улица');
    $('map-status').textContent = destination ? `Путь: ${rules.content.places[destination].name}` : time.night ? 'Ночь в Товилисе' : '';
    const options = rules.directions(state.position); $('directions').replaceChildren();
    const routePath = destination ? rules.shortestPath(state.position, building(destination).cell) : [];
    const recommended = routePath[1];
    $('route-guide').hidden = !destination || state.phase !== 'ready';
    $('route-guide-text').textContent = destination ? `К ${rules.content.places[destination].name}${recommended ? ` · ${compass(recommended)[0]}` : ''}` : '';
    options.forEach((option, i) => {
      const [arrow, name] = compass(option.next), button = document.createElement('button');
      const end = cells.get(option.path.at(-1)).kind === 'dead_end' ? 'конца улицы' : 'развилки';
      button.className = 'direction' + (option.next === recommended ? ' recommended' : ''); button.dataset.direction = option.next; button.disabled = state.phase !== 'ready' || Boolean(error);
      button.setAttribute('aria-pressed', String(state.selection?.next === option.next));
      button.setAttribute('aria-label', `${name}, ${option.path.length - 1} ${word(option.path.length - 1, 'клетка', 'клетки', 'клеток')} до ${end}${option.next === recommended ? `, маршрут к ${rules.content.places[destination].name}` : ''}${state.selection?.next === option.next ? ', нажмите ещё раз, чтобы бросить кубик' : ''}`); button.title = `${name} · ${option.path.length - 1} кл.${option.next === recommended ? ' · по маршруту' : ''}${state.selection?.next === option.next ? ' · ещё раз — бросок' : ''}`;
      html('span', button, arrow, 'arrow'); html('strong', button, i + 1);
      html('small', button, `${option.next === state.previous ? 'Назад · ' : ''}${option.path.length - 1} кл. до ${end}`);
      button.onclick = () => select(option.next); $('directions').append(button);
    });
    const selected = options.find(o => o.next === state.selection?.next);
    const movingAllowed = ['ready', 'moving'].includes(state.phase);
    $('directions').hidden = state.phase !== 'ready' || Boolean(error);
    $('movement-controls').hidden = !movingAllowed; $('movement-locked').hidden = movingAllowed;
    $('movement-locked').textContent = state.phase === 'won' ? 'Заказ выполнен. Город благодарит вас.' : state.phase === 'outcome' ? 'Встреча завершена — продолжите путь.' : 'Сначала завершите событие в панели действий.';
    $('roll').disabled = !selected || state.phase !== 'ready' || Boolean(error);
    const roll = state.pending?.roll ?? state.lastMove?.roll;
    $('dice-face').textContent = roll ? ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'][roll - 1] : '⚄';
    $('roll-label').textContent = state.phase === 'moving' ? 'Идём…' : 'Бросить';
    $('move-heading').textContent = state.phase === 'moving' ? `Выпало ${roll}` : selected ? 'Путь выбран · ещё раз — бросок' : 'Выберите направление';
    $('move-hint').textContent = state.turn === 0 ? 'Стрелка → ещё раз или кубик. У развилки движение закончится; бросок тратит 1 ход времени.' : '1–4 — направление, повтор — бросок · пробел — кубик';
    const last=state.pending || state.lastMove;
    $('last-roll').hidden=!last;
    if(last){$('last-roll').replaceChildren();html('strong',$('last-roll'),`Кубик ${last.roll}`);html('span',$('last-roll'),`${state.phase==='moving'?'Пройти':'Пройдено'} ${last.path.length-1} ${word(last.path.length-1,'шаг','шага','шагов')}`);}
    $('building-target').hidden = !selected?.building || state.phase !== 'ready';
    if (selected?.building) { $('target-label').textContent = `${destination && selected.building.id !== destination ? 'По пути можно зайти' : 'Остановиться'}: ${selected.building.name} · ${selected.path.indexOf(selected.building.cell)} кл.`; $('stop-building').checked = Boolean(state.selection.stopBuilding); $('stop-building').disabled = Boolean(error); }
    const current = rules.at(state.position).find(b => rules.content.places[b.id]);
    $('visit-place').hidden = !current || state.phase !== 'ready' || Boolean(error);
    if (current) { $('visit-place').textContent = `Услуги: ${rules.content.places[current.id].name}`; $('visit-place').onclick = () => { sceneMode = 'place'; scenePlace = current.id; render(); }; }
    $('scene-status').textContent = state.phase === 'ready' ? state.feedback || '' : '';
    renderContext(); renderMap(options); positionDirectionControls();
    const sceneTitle = $('context').querySelector('h2');
    if (sceneTitle) sceneTitle.id = 'scene-title';
    $('scene-dialog').setAttribute('aria-labelledby', error ? 'save-error-title' : 'scene-title');
    const mandatory = !['ready', 'moving'].includes(state.phase), show = Boolean(error || mandatory || state.phase === 'ready' && sceneMode);
    $('scene-close').hidden = mandatory && state.phase !== 'won' || Boolean(error);
    $('scene-dialog').classList.toggle('battle', ['encounter', 'combat'].includes(state.phase) && state.encounter?.hostile);
    $('scene-seal').textContent = state.phase === 'notice' ? '❦' : ['encounter', 'combat'].includes(state.phase) ? '⚔' : ['work', 'work-result'].includes(state.phase) ? '⚒' : state.phase === 'tavern-game' ? '⚄' : '✦';
    if (show && !$('scene-dialog').open) $('scene-dialog').showModal();
    else if (!show && $('scene-dialog').open) $('scene-dialog').close();
    if ($('scene-dialog').open) {
      if (focusedEnemy) $('context').querySelector(`[data-enemy="${focusedEnemy}"]`)?.focus({preventScroll: true});
      else if (focusedAction) ($('context').querySelector(`[data-action="${focusedAction}"]`) || $('context').querySelector('button:not(:disabled)'))?.focus({preventScroll: true});
    } else if (focusedDirection) $('directions').querySelector(`[data-direction="${focusedDirection}"]`)?.focus({preventScroll: true});
  }
  function word(n, one, few, many) { return n % 100 >= 11 && n % 100 <= 14 ? many : n % 10 === 1 ? one : n % 10 >= 2 && n % 10 <= 4 ? few : many; }
  function clearMapHint() {
    if (!mapHintActive) return;
    const text = mapHintText;
    clearTimeout(mapHintTimer); mapHintTimer = null; mapHintText = ''; mapHintActive = false;
    if ($('status').textContent === text) $('status').textContent = '';
  }
  function showMapHint(text) {
    clearMapHint(); mapHintText = text; $('status').textContent = text; mapHintActive = true;
    const expected = text;
    mapHintTimer = setTimeout(() => {
      if (!mapHintActive || mapHintText !== expected) return;
      mapHintActive = false; mapHintTimer = null; mapHintText = '';
      if ($('status').textContent === expected) $('status').textContent = '';
    }, 4500);
  }
  function showReceipt(before, after) {
    clearMapHint();
    const items = [], h = before.hero, n = after.hero;
    if (n.coins !== h.coins) items.push(`${n.coins > h.coins ? '+' : '−'}${Math.abs(n.coins - h.coins)} ${word(Math.abs(n.coins - h.coins), 'монета', 'монеты', 'монет')}`);
    if (n.food !== h.food) items.push(`${n.food > h.food ? '+' : '−'}${Math.abs(n.food - h.food)} ${word(Math.abs(n.food - h.food), 'порция еды', 'порции еды', 'порций еды')} · осталось ${n.food}`);
    if (after.ticks > before.ticks && n.hp < h.hp) items.push(`Жизненные силы: −${h.hp - n.hp}`);
    if (!items.length || $('scene-dialog').open) return;
    clearTimeout(toastTimer); $('status').textContent = items.join(' · ');
    toastTimer = setTimeout(() => { $('status').textContent = ''; }, 6500);
  }
  function positionDirectionControls() {
    const matrix = svg.getScreenCTM(); if (!matrix) return;
    const canvas = document.querySelector('.map-canvas').getBoundingClientRect(), point = new DOMPoint(...cells.get(state.position).position).matrixTransform(matrix);
    const radius = canvas.width <= 780 ? 72 : 84;
    const movement = document.querySelector('.movement-dock');
    const liftDock = canvas.width <= 780 && point.y - canvas.top > canvas.height * .60;
    movement.style.top = liftDock ? '150px' : ''; movement.style.bottom = liftDock ? 'auto' : '';
    const x = Math.max(radius + 30, Math.min(canvas.width - radius - 30, point.x - canvas.left));
    let y = Math.max(165, Math.min(canvas.height - 140, point.y - canvas.top));
    $('directions').style.left = `${x}px`; $('directions').style.top = `${y}px`;
    const options = rules.directions(state.position);
    const angles = options.map(o => { const a = cells.get(state.position).position, b = cells.get(o.next).position; return Math.atan2(b[1] - a[1], b[0] - a[0]); });
    // Eight slots keep nearby branches separate, including the west-facing wrap.
    const used = new Set(), upRadius = Math.max(radius, Number($('hero-sprite').getAttribute('height')) * Math.hypot(matrix.c, matrix.d) + (canvas.width <= 780 ? 24 : 28) + 12);
    angles.forEach((angle, index) => {
      const base = Math.round(angle / (Math.PI / 4));
      const slot = [0, 1, -1, 2, -2, 3, -3, 4].map(offset => (base + offset + 16) % 8).find(value => !used.has(value));
      used.add(slot);
      const button = $('directions').children[index];
      if (button) { button.style.left = `${Math.cos(slot * Math.PI / 4) * radius}px`; button.style.top = `${Math.sin(slot * Math.PI / 4) * (Math.sin(slot * Math.PI / 4) < 0 ? upRadius : radius)}px`; }
    });
    const dock = document.querySelector('.movement-dock').getBoundingClientRect();
    for (const button of $('directions').children) {
      const r = button.getBoundingClientRect();
      if (r.right > dock.left - 8 && r.left < dock.right + 8 && r.bottom > dock.top - 8 && r.top < dock.bottom + 8) y = Math.min(y, dock.top - canvas.top - parseFloat(button.style.top) - r.height / 2 - 12);
    }
    $('directions').style.top = `${Math.max(radius + 30, y)}px`;
    const sprite = $('hero-sprite'), foot = cells.get(state.position).position;
    const a = new DOMPoint(foot[0] + Number(sprite.getAttribute('x')), foot[1] + Number(sprite.getAttribute('y'))).matrixTransform(matrix);
    const b = new DOMPoint(foot[0] + Number(sprite.getAttribute('x')) + Number(sprite.getAttribute('width')), foot[1] + Number(sprite.getAttribute('y')) + Number(sprite.getAttribute('height'))).matrixTransform(matrix);
    const hero = {left:a.x, top:a.y, right:b.x, bottom:b.y}, root = $('directions').getBoundingClientRect();
    const hit = (a, b) => a.left < b.right + 4 && a.right > b.left - 4 && a.top < b.bottom + 4 && a.bottom > b.top - 4;
    for (const button of $('directions').children) {
      const size = button.getBoundingClientRect();
      if (!hit(size, hero) && !hit(size, dock)) continue;
      const base = Math.round(Math.atan2(parseFloat(button.style.top), parseFloat(button.style.left)) / (Math.PI / 4));
      let placed = false;
      for (const distance of [radius, radius + 18, radius + 36]) {
        for (const offset of [0, 1, -1, 2, -2, 3, -3, 4]) {
          const angle = (base + offset) * Math.PI / 4, dx = Math.cos(angle) * distance, dy = Math.sin(angle) * distance;
          const r = {left:root.left + dx - size.width/2, right:root.left + dx + size.width/2, top:root.top + dy - size.height/2, bottom:root.top + dy + size.height/2};
          if (r.left < canvas.left + 4 || r.right > canvas.right - 4 || r.top < canvas.top + 4 || r.bottom > canvas.bottom - 4 || hit(r, hero) || hit(r, dock) || [...$('directions').children].some(other => other !== button && hit(r, other.getBoundingClientRect()))) continue;
          button.style.left = `${dx}px`; button.style.top = `${dy}px`; placed = true; break;
        }
        if (placed) break;
      }
    }

  }
  new ResizeObserver(positionDirectionControls).observe(document.querySelector('.map-canvas'));
  new ResizeObserver(entries=>document.documentElement.style.setProperty('--hud-height',`${entries[0].target.getBoundingClientRect().height}px`)).observe(document.querySelector('.topbar'));
  function setView(next) { view = next; svg.setAttribute('viewBox', view.join(' ')); positionDirectionControls(); }
  function ensureVisible([x, y]) {
    let [vx, vy, w, h] = view;
    if (x < vx + 60) vx = x - 60; if (x > vx + w - 60) vx = x - w + 60;
    if (y < vy + 100) vy = y - 100; if (y > vy + h - 30) vy = y - h + 30;
    setView([vx, vy, w, h]);
  }
  async function animate() {
    const token = ++animation, move = state.pending;
    if (!move || error) return;
    ensureVisible(cells.get(move.path[0]).position);
    for (let i = 1; i < move.path.length; i++) {
      if (token !== animation) return;
      const a = cells.get(move.path[i - 1]).position, b = cells.get(move.path[i]).position, direction = rules.facing(move.path[i - 1], move.path[i]); ensureVisible(b);
      await new Promise(resolve => {
        const start = performance.now(), duration = reducedMotion.matches ? 0 : 230;
        function frame(now) {
          if (token !== animation) { resolve(); return; }
          const t = duration ? Math.min(1, (now - start) / duration) : 1, eased = t * t * (3 - 2 * t);
          positionHero([a[0] + (b[0] - a[0]) * eased, a[1] + (b[1] - a[1]) * eased], direction, reducedMotion.matches ? 0 : Math.sin(t * Math.PI) * 2);
          if (t < 1) requestAnimationFrame(frame); else resolve();
        }
        requestAnimationFrame(frame);
      });
    }
    if (token === animation) act(s => rules.arrive(s));
  }
  $('roll').onclick = () => { if (state.phase === 'ready' && state.selection && !error) { clearMapHint(); rolled(s => rules.begin(s, die), 'move'); } };
  $('stop-building').onchange = () => {
    const option = rules.directions(state.position).find(o => o.next === state.selection?.next);
    if (option) act(s => rules.choose(s, option.next, $('stop-building').checked ? option.building.id : null));
  };
  $('scene-close').onclick = () => { if (state.phase === 'won') act(s => rules.acknowledge(s)); else { sceneMode = null; scenePlace = null; render(); } };
  $('scene-dialog').addEventListener('cancel', event => { event.preventDefault(); if (state.phase === 'won' && !error) act(s => rules.acknowledge(s)); else if (state.phase === 'ready' && !error) { sceneMode = null; scenePlace = null; render(); } });
  $('quest-button').onclick = () => { sceneMode = 'quest'; scenePlace = null; render(); };
  $('drink').onclick = () => act(s => rules.drink(s));
  $('next-meal').onclick = () => { const open = $('food-details').hidden; $('food-details').hidden = !open; $('next-meal').setAttribute('aria-expanded', String(open)); };
  let heroTab = 'overview', selectedGearSlot = 'mainHand', selectedStat = null, heroSheetMessage = '', heroSheetBusy = false;
  const heroTabScroll = {};
  function setHeroTab(tab, focus = false) {
    const scroller = $('hero-scroll');
    const targetScroll = heroTab === tab ? scroller.scrollTop : heroTabScroll[tab] || 0;
    if (heroTab !== tab) heroTabScroll[heroTab] = scroller.scrollTop;
    heroTab = tab;
    document.querySelectorAll('[data-hero-tab]').forEach(button => {
      const active = button.dataset.heroTab === tab;
      button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
      if (active && focus) button.focus();
    });
    for (const id of ['overview', 'equipment', 'bag']) $(`hero-panel-${id}`).hidden = id !== tab;
    scroller.scrollTop = targetScroll;
  }
  function itemEffects(item) {
    if (item.damage) return `Урон d${item.damage.sides} + сила${item.effects.attack ? ` + ${item.effects.attack}` : ''}`;
    const labels = {attack: 'атака', strength: 'сила', defense: 'защита', agility: 'ловкость', maxHp: 'максимум ЖС', mana: 'МЭ'};
    const text = Object.entries(item.effects || {}).filter(([key, value]) => labels[key] && value).map(([key, value]) => `${labels[key]} ${value > 0 ? '+' : '−'}${Math.abs(value)}`);
    if (item.effects?.peaceful) text.push('запрет агрессии');
    if (item.effects?.closedSocietyWard) text.push('защита от умений закрытых обществ');
    const description = text.join(' · ');
    return description ? description[0].toUpperCase() + description.slice(1) : 'Без боевого бонуса';
  }
  function renderItemFacts(parent, item, totalWeight = item.weight) {
    if (item.description) html('p', parent, item.description, 'item-description');
    const definition=rules.content.items[item.id]||rules.content.finds[item.id]||rules.content.artifacts[item.id];
    const slot=item.slot||definition?.slot;
    const facts = html('dl', parent, undefined, 'item-facts');
    const row = (label, value) => { const pair = html('div', facts); html('dt', pair, label); html('dd', pair, value); };
    if (slot || item.damage || Object.keys(item.effects || {}).length) row('Свойства', itemEffects(item));
    else if (item.detail) row('Применение', item.detail.split(' · ').filter(part=>part!==item.description).join(' · '));
    if (slot) {
      const requirements = [];
      if (item.requiredStrength) requirements.push(`Сила не ниже ${item.requiredStrength}`);
      if ((item.tags || []).includes('heavy')) requirements.push('Нельзя при расовом запрете тяжёлого снаряжения');
      row('Требования', requirements.join(' · ') || 'Без особых требований');
    }
    row('Вес', weightText(totalWeight));
    if (item.unique) row('Редкость', 'Единственный экземпляр');
    return facts;
  }
  function statChanges(before, after) {
    const labels = {strength:'сила', agility:'ловкость', defense:'защита', attackBonus:'атака', maxHp:'максимум ЖС', manaBonus:'МЭ'};
    return Object.entries(labels).filter(([key]) => after[key] !== before[key]).map(([key,label]) => {
      const delta = after[key] - before[key]; return `${label} ${delta > 0 ? '+' : '−'}${Math.abs(delta)}`;
    }).join(' · ');
  }
  function gearCandidate(slot, id) {
    if (state.phase !== 'ready') return {reason:'Сначала завершите событие. В бою меняйте оружие действием в окне боя.'};
    try { const next = rules.equip(state, slot, id); rules.validate(next); return {next, profile:rules.equipmentProfile(next)}; }
    catch (cause) { return {reason:cause.message}; }
  }
  async function applyGear(slot, id) {
    if (heroSheetBusy) return;
    const before = rules.equipmentProfile(state).stats;
    heroSheetBusy = true; heroSheetMessage = 'Сохраняю снаряжение…'; renderHeroSheet(false);
    try {
      if (!act(s => rules.equip(s, slot, id))) throw new Error(error || 'Не удалось сменить вещь.');
      if (online?.enabled) await online.state.pending;
      if (error) throw new Error(errorDetails || error);
      const after = rules.equipmentProfile(state).stats;
      const changes = statChanges(before, after);
      const item = id && (rules.content.items[id] || rules.content.finds[id] || rules.content.artifacts[id]);
      heroSheetMessage = `${item ? `Надето: ${item.name}` : 'Вещь убрана в сумку'}${changes ? `. ${changes[0].toUpperCase()+changes.slice(1)}` : ''}.`;
    } catch (cause) { heroSheetMessage = cause.message; }
    finally { heroSheetBusy = false; renderHeroSheet(false); $('hero-equip-status').scrollIntoView({block:'nearest'}); }
  }
  function renderGearChooser(profile) {
    const slot = profile.slots.find(slot => slot.id === selectedGearSlot) || profile.slots[0], box = $('gear-detail'); box.replaceChildren();
    html('span', box, slot.label, 'eyebrow'); html('h3', box, slot.item?.name || 'Свободный слот');
    const current = html('div', box, undefined, 'gear-current');
    if (slot.item) {
      itemIllustration(current, slot.item); const info = html('div', current);
      renderItemFacts(info, slot.item);
      if (slot.id !== 'mainHand') {
        const candidate = gearCandidate(slot.id, null);
        const remove = actionButton(info, 'Снять в сумку', () => applyGear(slot.id, null), {disabled:heroSheetBusy || Boolean(candidate.reason), action:`unequip-${slot.id}`});
        remove.dataset.equipItem = ''; remove.dataset.equipSlot = slot.id;
        if (candidate.reason) html('p', info, candidate.reason, 'hint');
      }
    } else html('p', current, 'Здесь пока ничего не надето.', 'hint');
    const choices = slot.choices.filter(item => item.id !== slot.item?.id);
    html('h4', box, 'Можно надеть');
    const list = html('div', box, undefined, 'gear-choices');
    if (!choices.length) html('p', list, 'В сумке нет других вещей для этого слота.', 'hint');
    for (const item of choices) {
      const candidate = gearCandidate(slot.id, item.id), card = html('article', list, undefined, 'gear-choice'); card.dataset.item = item.id;
      itemIllustration(card, item); const text = html('div', card); html('h4', text, item.name); renderItemFacts(text, item);
      if (candidate.profile) {
        const delta = statChanges(profile.stats, candidate.profile.stats);
        html('p', text, delta ? `Изменится: ${delta}` : 'Характеристики не изменятся', 'gear-delta');
      } else html('p', text, candidate.reason, 'gear-reason');
      const button = actionButton(text, 'Надеть', () => applyGear(slot.id, item.id), {primary:true, disabled:heroSheetBusy || Boolean(candidate.reason), action:`equip-${slot.id}-${item.id}`});
      button.dataset.equipItem = item.id; button.dataset.equipSlot = slot.id;
    }
    html('p', box, state.phase === 'ready' ? 'Вне боя смена вещей не тратит время.' : 'Снаряжение доступно для просмотра. В бою смена оружия занимает действие.', 'hint');
  }
  function renderHeroSheet(open = true) {
    const scroller = $('hero-scroll'), scrollTop = scroller.scrollTop;
    if (open) heroSheetMessage = '';
    $('hero-title').textContent = state.hero.name; $('name-input').value = state.hero.name; $('hero-form').hidden = true;
    const items = rules.inventory(state), hero = state.hero, profile = rules.equipmentProfile(state), weapon = rules.content.items[rules.equippedWeapon(hero)];
    const identity = hero.character && !hero.character.legacy ? hero.character.labels || {} : {race:'Гном', class:'Воин', sex:'Мужчина'};
    document.querySelector('.hero-identity').textContent = `${identity.race || 'Герой'} · ${identity.class || 'класс не указан'} · ${identity.sex || ''}`.replace(/ · $/, '');
    const identityDetails = document.querySelector('.race-details p');
    identityDetails.textContent = hero.character?.legacy
      ? 'Гном · Воин. Расовые бонусы уже учтены в базовых характеристиках. Гномы не ездят верхом.'
      : `${identity.race} · ${identity.origin || hero.character.origin}. Расовые бонусы и класс уже учтены в базе. Пол определяет внешний вид.`;
    const explain = key => {
      const bonuses = profile.slots.filter(slot => slot.item?.effects?.[key]);
      const parts = [`${profile.base[key]} база`];
      for (const slot of bonuses) { const bonus=slot.item.effects[key]; parts.push(`${bonus>0?'+':'−'} ${Math.abs(bonus)} ${slot.item.statLabel || slot.item.name}`); }
      const uncapped=profile.base[key]+bonuses.reduce((sum,slot)=>sum+slot.item.effects[key],0);
      return `${parts.join(' ')} = ${profile.stats[key]}${uncapped!==profile.stats[key] ? ' (с учётом предела)' : ''}`;
    };
    const attack = `d${weapon.damage.sides} + сила ${hero.strength}${weapon.effects.attack ? ` + оружие ${weapon.effects.attack}` : ''} = d${weapon.damage.sides}+${hero.attackBonus}`;
    const formulas = {strength:explain('strength'),agility:explain('agility'),defense:explain('defense'),attack};
    $('hero-health-value').textContent = `${hero.hp} / ${hero.maxHp}`;
    $('hero-health-meter').max = hero.maxHp; $('hero-health-meter').value = hero.hp; $('hero-health-meter').textContent = `${hero.hp} из ${hero.maxHp}`;
    $('hero-stats').replaceChildren();
    for (const [id,label,value] of [['strength','Сила',hero.strength],['agility','Ловкость',hero.agility],['defense','Защита',hero.defense],['attack','Атака',`d${weapon.damage.sides}+${hero.attackBonus}`]]) {
      const card = html('button', $('hero-stats'), undefined, 'hero-stat'); card.type='button'; card.dataset.stat=id;
      card.setAttribute('aria-expanded',String(selectedStat===id)); card.setAttribute('aria-controls','hero-stat-detail');
      html('span',card,label);html('strong',card,value);
      const delta=profile.stats[id]-profile.base[id];
      html('small',card,id==='attack' ? weapon.name : delta ? `${delta>0?'+':'−'}${Math.abs(delta)} от вещей` : `База ${profile.base[id]}`);
      card.onclick=()=>{selectedStat=selectedStat===id?null:id; renderHeroSheet(false); $('hero-stats').querySelector(`[data-stat="${id}"]`).focus({preventScroll:true});};
    }
    $('hero-stat-detail').hidden=!selectedStat; $('hero-stat-detail').textContent=selectedStat ? formulas[selectedStat] : '';
    $('hero-resources').replaceChildren();
    for (const [label,value] of [['Монеты',hero.coins],['Репутация',hero.reputation],['Предметов в сумке',items.bag.length]]) {
      const row=html('div',$('hero-resources'));html('dt',row,label);html('dd',row,value);
    }
    $('hero-experience').textContent = hero.experience;
    const growth = rules.characters.classes[hero.character?.class || 'warrior'];
    const growthNames = {strength:'Сила',agility:'Ловкость',intelligence:'Интеллект',aim:'Меткость'};
    $('hero-class-growth').textContent = growth ? `${growth.name}: сильная сторона — ${growthNames[growth.strong]}, слабая — ${growthNames[growth.weak]}.` : '';
    $('hero-travel').replaceChildren();
    html('p',$('hero-travel'),hero.slowMoves ? `Движение: −1 шаг ещё ${hero.slowMoves} перемещения` : 'Движение без штрафа');
    html('p',$('hero-travel'),`Вес: ${weightText(items.weight)}${items.unknownWeight ? ' + вещи без указанного веса' : ''}`);
    $('hero-stat-breakdown').replaceChildren();
    for (const [label,value] of [['Сила',formulas.strength],['Ловкость',formulas.agility],['Защита',formulas.defense],['Атака',attack],['Максимум ЖС',explain('maxHp')]]) {
      html('dt',$('hero-stat-breakdown'),label);html('dd',$('hero-stat-breakdown'),value);
    }
    for (const [key,label] of [['intelligence','Интеллект'],['aim','Меткость']]) if (Number.isFinite(profile.stats[key])) {html('dt',$('hero-stat-breakdown'),label);html('dd',$('hero-stat-breakdown'),profile.stats[key]);}
    if (profile.stats.manaBonus) {html('dt',$('hero-stat-breakdown'),'МЭ от вещей');html('dd',$('hero-stat-breakdown'),`+${profile.stats.manaBonus}`);}
    $('gear-left').replaceChildren();$('gear-right').replaceChildren();
    const oldIds={mainHand:'main-hand',offHand:'off-hand',neck:'amulet'};
    for (const slot of profile.slots) {
      const parent=['head','body','shoulders'].includes(slot.id)?$('gear-left'):$('gear-right');
      const button=html('button',parent,undefined,'gear-slot'+(selectedGearSlot===slot.id?' active':''));button.type='button';button.dataset.slot=oldIds[slot.id]||slot.id;button.dataset.equipmentSlot=slot.id;
      button.setAttribute('aria-pressed',String(selectedGearSlot===slot.id));button.setAttribute('aria-label',`${slot.label}: ${slot.item?.name||'пусто'}`);
      if(slot.item)itemIllustration(button,slot.item);else html('span',button,'◇','gear-symbol');
      const text=html('span',button,undefined,'gear-slot-text');html('small',text,slot.label);html('strong',text,slot.item?.name||'Пусто');html('em',text,slot.item?itemEffects(slot.item):'');
      button.onclick=()=>{selectedGearSlot=slot.id;renderHeroSheet(false);$('hero-paperdoll').querySelector(`[data-equipment-slot="${slot.id}"]`).focus({preventScroll:true});if(matchMedia('(max-width:780px)').matches)$('gear-detail').scrollIntoView({block:'nearest',behavior:reducedMotion.matches?'auto':'smooth'});};
    }
    renderGearChooser(profile);$('hero-equip-status').textContent=heroSheetMessage;
    const loadout=$('hero-loadout');loadout.replaceChildren();
    const heading=html('h3',loadout,'В дорожной сумке');heading.id='hero-bag';
    $('hero-bag-count').textContent=items.bag.length;
    const grid=html('div',loadout,undefined,'inventory-grid');
    if(!items.bag.length)html('p',grid,'Сумка пуста. Снятые вещи и находки появятся здесь.','hint');
    for(const item of items.bag){
      const card=html('article',grid,undefined,'inventory-item');card.dataset.item=item.id;itemIllustration(card,item);const text=html('div',card);
      html('strong',text,item.name);html('span',text,`${item.quantity} ${word(item.quantity,'штука','штуки','штук')}`,'item-slot');renderItemFacts(text,item,item.totalWeight);
      const slotId=(rules.content.items[item.id]||rules.content.finds[item.id]||rules.content.artifacts[item.id])?.slot;
      if(slotId){const button=html('button',text,'К слоту', 'bag-equip-link');button.type='button';button.onclick=()=>{selectedGearSlot=slotId;renderHeroSheet(false);setHeroTab('equipment');};}
    }
    if(hero.lore.includes('alien-lake'))html('p',loadout,'Запомнено: Чуждое Озеро в Отверженных Землях. Знакомый указал его на своей карте.','hint');
    setHeroTab(heroTab);scroller.scrollTop=scrollTop;
    if(open&&!$('hero-dialog').open)$('hero-dialog').showModal();
  }
  $('portrait').onclick=()=>renderHeroSheet();
  $('rename-toggle').onclick=()=>{$('hero-form').hidden=!$('hero-form').hidden;if(!$('hero-form').hidden)$('name-input').focus();};
  document.querySelectorAll('[data-hero-tab]').forEach((button,index,buttons)=>{
    button.onclick=()=>setHeroTab(button.dataset.heroTab);
    button.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;setHeroTab(buttons[next].dataset.heroTab,true);};
  });
  $('hero-form').onsubmit = event => { event.preventDefault(); if (!$('name-input').value.trim()) { $('name-input').setCustomValidity('Введите имя.'); $('name-input').reportValidity(); return; } if (act(s => rules.rename(s, $('name-input').value))) $('hero-dialog').close(); };
  $('name-input').oninput = () => $('name-input').setCustomValidity('');
  document.querySelectorAll('[data-close]').forEach(button => { button.onclick = () => $(button.dataset.close).close(); });
  $('journal-button').onclick = () => { $('journal').replaceChildren(); [...state.journal].reverse().forEach(e => html('li', $('journal'), e.text)); $('journal-dialog').showModal(); };
  $('places-button').onclick = () => {
    $('place-list').replaceChildren();
    const night = rules.clock(state.ticks).night, shifts = rules.workStatus(state);
    const descriptions = {
      orders:'Поручение · круглосуточно', mill:'Работа и разговоры · днём', port:'Сдать сеть всегда · работа днём',
      shop:'Сеть 5 монет · зелье 4 · днём', 'far-shop':'Зелье 3 монеты · днём', forge:'Работа, меч и щит · днём',
      'city-entry':'Вход в город', 'west-house':'Хранение монет · банк'
    };
    for (const b of map.buildings.filter(b => rules.content.places[b.id]).sort((a,b) => rules.shortestPath(state.position,a.cell).length-rules.shortestPath(state.position,b.cell).length)) {
      const button = html('button', $('place-list'));
      const label = html('span',button); html('strong',label,rules.content.places[b.id].name);
      const inn = rules.content.taverns[b.id];
      const description = inn ? `Еда ${inn.foodPortions} порции/монета · ночлег ${inn.roomCost} ${word(inn.roomCost,'монета','монеты','монет')} · всегда` : descriptions[b.id];
      const availability = night && ['mill','shop','far-shop','forge'].includes(b.id) ? ' · сейчас закрыто' : night && b.id === 'port' ? ' · работа утром' : !night && shifts.remaining === 0 && ['mill','port','forge'].includes(b.id) ? ' · смены завтра' : '';
      html('small',label,description+availability);
      html('span',button,`${rules.shortestPath(state.position, b.cell).length - 1} кл.`,'place-distance');
      button.dataset.place = b.id; button.onclick = () => { sceneMode = 'place'; scenePlace = b.id; $('places-dialog').close(); render(); };
    }
    $('places-dialog').showModal();
  };
  $('menu-button').onclick = () => $('menu-dialog').showModal();
  $('new-game').onclick = () => { $('menu-dialog').close(); $('reset-dialog').showModal(); };
  $('confirm-reset').onclick = () => {
    if (online?.enabled) { $('reset-dialog').close(); $('status').textContent = 'В сетевой партии персонаж хранится на сервере; сброс отключён.'; return; }
    animation += 1; if (save(rules.create(), true)) { setDestination(null); targetEnemy = null; $('reset-dialog').close(); setView([0, 0, 1448, 1086]); render(); if (matchMedia('(max-width: 780px)').matches) focusHero(); }
  };
  $('confirm-surrender').onclick = () => { $('surrender-dialog').close(); doBattle('surrender'); };
  $('retry-save').onclick = load;
  $('export-save').onclick = () => {
    const raw = storedSave(); if (raw === null) return;
    const url = URL.createObjectURL(new Blob([raw], {type:'application/json'}));
    const link = document.createElement('a'); link.href = url; link.download = 'tovilis-save.json';
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  $('reset-from-error').onclick = () => $('reset-dialog').showModal();
  $('clear-route').onclick = () => { setDestination(null); render(); };
  $('show-grid').onchange = () => svg.classList.toggle('grid-visible', $('show-grid').checked);
  $('whole-map').onclick = () => setView([0, 0, 1448, 1086]);
  function focusHero() {
    const canvas = document.querySelector('.map-canvas').getBoundingClientRect(), [x, y] = cells.get(state.position).position;
    const width = canvas.width <= 780 ? Math.min(560, canvas.width * 1.4) : 640, height = width * canvas.height / canvas.width;
    setView([x - width / 2, y - height * .65, width, height]);
  }
  $('find-hero').onclick = focusHero;
  function zoom(factor, point) {
    const width = Math.max(300, Math.min(1900, view[2] * factor)), scale = width / view[2];
    const [x, y] = point || [view[0] + view[2] / 2, view[1] + view[3] / 2];
    setView([x - (x - view[0]) * scale, y - (y - view[1]) * scale, width, view[3] * scale]);
  }
  $('zoom-in').onclick = () => zoom(.8); $('zoom-out').onclick = () => zoom(1.25);
  svg.addEventListener('wheel', e => { e.preventDefault(); const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse()); zoom(e.deltaY < 0 ? .9 : 1.1, [p.x, p.y]); }, {passive: false});
  svg.addEventListener('pointerdown', e => { if (!e.isPrimary || e.button !== 0) return; dragged = false; drag = {id: e.pointerId, x: e.clientX, y: e.clientY, view: [...view], matrix: svg.getScreenCTM().inverse()}; });
  svg.addEventListener('pointermove', e => {
    if (!drag || drag.id !== e.pointerId) return;
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) dragged = true;
    if (!dragged) return;
    svg.setPointerCapture(e.pointerId);
    const a = new DOMPoint(drag.x, drag.y).matrixTransform(drag.matrix), b = new DOMPoint(e.clientX, e.clientY).matrixTransform(drag.matrix);
    setView([drag.view[0] - b.x + a.x, drag.view[1] - b.y + a.y, drag.view[2], drag.view[3]]);
  });
  function finishDrag(e) { if (drag?.id === e.pointerId) { drag = null; if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId); } }
  svg.addEventListener('pointerup', finishDrag); svg.addEventListener('pointercancel', finishDrag);
  window.addEventListener('storage', e => { if (e.key === KEY || e.key === null) load(); });
  document.addEventListener('tovilis-presence', () => { if (online?.enabled) render(); });
  document.addEventListener('tovilis-online-conflict', event => {
    if (!online?.enabled || !event.detail) return;
    try { state = rules.validate(event.detail.state || event.detail.game || event.detail); serialized = JSON.stringify(state); error = ''; errorDetails = ''; render(); }
    catch (cause) { error = 'Сервер прислал неподходящее состояние партии.'; errorDetails = cause.message; render(); }
  });
  window.addEventListener('keydown', e => {
    if (e.repeat || document.querySelector('dialog[open]') || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (state.phase === 'ready' && /^[1-4]$/.test(e.key)) { const option = rules.directions(state.position)[Number(e.key) - 1]; if (option) { e.preventDefault(); select(option.next); $('directions').querySelector(`[data-direction="${option.next}"]`)?.focus({preventScroll:true}); } }
    if (e.code === 'Space' && !/^(BUTTON|A)$/.test(e.target.tagName) && state.phase === 'ready' && state.selection) { e.preventDefault(); $('roll').click(); }
  });
  window.tovilisGame = {get state() { return JSON.parse(JSON.stringify(state)); }, get view() { return [...view]; }};
  load();
})();
