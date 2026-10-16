'use strict';
/* Online shell.  The rules engine remains the renderer's source of truth in
 * offline mode; when the server meta flag is present this module owns login,
 * character creation and the small social panels. */
(() => {
  const meta = document.querySelector('meta[name="game-server"]');
  const enabled = Boolean(meta || new URLSearchParams(location.search).has('online'));
  const apiBase = meta && meta.content && meta.content !== 'true' ? meta.content.replace(/\/$/, '') : '';
  const inviteFragmentPrefix = '#invite=';
  let inviteFromFragment = ''; try { if (location.hash.startsWith(inviteFragmentPrefix)) inviteFromFragment = decodeURIComponent(location.hash.slice(inviteFragmentPrefix.length)); } catch (_) {}
  if (location.hash.startsWith(inviteFragmentPrefix)) history.replaceState(null, '', `${location.pathname}${location.search}`);
  const state = {token: null, account: null, character: null, game: null, revision: 0, presence: [], busy: false, ready: null, pending: Promise.resolve(), context: {}};
  const race = {human:'Человек', dwarf:'Гном', elf:'Эльф'};
  const origins = {north:'Север', tovilis:'Товилис', taranaris:'Таранарис', crimsonDragon:'Алый Дракон', abir:'Абир', sevenMines:'Семь Шахт', highElf:'Высшие эльфы', forestElf:'Лесные эльфы', dwarf:'Гномьи земли'};
  const originRace = {north:'human',tovilis:'human',taranaris:'human',crimsonDragon:'human',abir:'human',sevenMines:'human',highElf:'elf',forestElf:'elf',dwarf:'dwarf'};
  const classes = {warrior:'Воин', mage:'Маг', thief:'Вор', scout:'Следопыт'};
  const sexes = {male:'мужчина', female:'женщина'};
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const json = async (path, options = {}) => {
    const headers = {'Content-Type':'application/json', ...(options.headers || {})};
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const csrf = document.cookie.split('; ').find(item => item.startsWith('cw_csrf='))?.slice(8);
    if (csrf) headers['X-CSRF-Token'] = decodeURIComponent(csrf);
    const response = await fetch(`${apiBase}${path}`, {...options, headers, credentials:'include'});
    let body = null; try { body = await response.json(); } catch (_) { body = {}; }
    if (!response.ok) { const failure = new Error(body.error || body.message || `Сервер ответил ${response.status}`); failure.status = response.status; throw failure; }
    return body;
  };
  function panel(title, body, actions = '') {
    const old = document.getElementById('online-panel'); old?.remove();
    const dialog = document.createElement('dialog'); dialog.id = 'online-panel'; dialog.className = 'online-panel';
    dialog.innerHTML = `<button class="close" type="button" aria-label="Закрыть">×</button><span class="eyebrow">АЛЫЙ МИР · СЕТЕВАЯ ИГРА</span><h2>${esc(title)}</h2><div class="online-body">${body}</div>${actions ? `<div class="dialog-actions">${actions}</div>` : ''}`;
    document.body.append(dialog); dialog.querySelector('.close').onclick = () => dialog.close();
    dialog.addEventListener('close', () => dialog.remove(), {once:true}); dialog.showModal(); return dialog;
  }
  function formField(label, id, type = 'text', value = '', extra = '') { return `<label>${esc(label)}<input id="${id}" type="${type}" value="${esc(value)}" ${extra}></label>`; }
  function login() {
    const dialog = panel('Войти в Товилис', `<p class="hint">Старый логин также подойдёт.</p><form id="online-login-form" class="online-form">${formField('Логин','online-login','text','', 'autocomplete="username" required')}${formField('Пароль','online-password','password','', 'autocomplete="current-password" minlength="8" required')}<button class="primary" type="submit">Войти</button><button type="button" id="online-register">Создать аккаунт</button><button type="button" id="online-recover">Восстановить доступ</button><p class="form-error" id="online-error" role="alert"></p></form>`);
    dialog.querySelector('#online-register').onclick = register;
    dialog.querySelector('#online-recover').onclick = () => recoverAccess(dialog);
    dialog.querySelector('form').onsubmit = async event => { event.preventDefault(); const error = dialog.querySelector('#online-error'); error.textContent = ''; try { const result = await json('/api/auth/login', {method:'POST', body: JSON.stringify({login:dialog.querySelector('#online-login').value.trim(), password:dialog.querySelector('#online-password').value})}); await acceptAuth(result); dialog.close(); } catch (cause) { error.textContent = cause.message; } };
  }
  function recoverAccess(previous) {
    const loginValue = previous?.querySelector('#online-login')?.value || '';
    const dialog = panel('Восстановить доступ', `<p class="hint">Если доступ потерян, обратитесь к администратору за одноразовым кодом восстановления.</p><form id="forgot-form" class="online-form">${formField('Логин','forgot-login','text',loginValue, 'autocomplete="username" required')}<button class="primary" type="submit">Продолжить</button><p class="form-error" id="forgot-error" role="alert"></p></form>`);
    dialog.querySelector('form').onsubmit = async event => { event.preventDefault(); const error = dialog.querySelector('#forgot-error'); error.textContent = ''; resetPassword(dialog.querySelector('#forgot-login').value.trim()); };
  }
  function resetPassword(loginValue) {
    const dialog = panel('Новый пароль', `<p class="hint">Введите одноразовый код администратора.</p><form id="reset-form" class="online-form">${formField('Код','reset-token','text','', 'autocomplete="one-time-code" required')}${formField('Новый пароль','reset-password','password','', 'autocomplete="new-password" minlength="8" required')}${formField('Повторите пароль','reset-password-repeat','password','', 'autocomplete="new-password" minlength="8" required')}<button class="primary" type="submit">Сохранить пароль</button><p class="form-error" id="reset-error" role="alert"></p></form>`);
    dialog.querySelector('form').onsubmit = async event => { event.preventDefault(); const error = dialog.querySelector('#reset-error'); error.textContent = ''; if (dialog.querySelector('#reset-password').value !== dialog.querySelector('#reset-password-repeat').value) { error.textContent = 'Пароли не совпадают.'; return; } try { await json('/api/auth/reset-password', {method:'POST', body:JSON.stringify({login:loginValue, token:dialog.querySelector('#reset-token').value.trim(), password:dialog.querySelector('#reset-password').value})}); login(); } catch (cause) { error.textContent = cause.message; } };
  }
  function register() {
    const invite = inviteFromFragment || '';
    const dialog = panel('Создать аккаунт', `<p class="hint">Нужен код приглашения или ссылка целиком. Логин: 3–24 латинских или кириллических символа, цифры, точка, дефис или подчёркивание.</p><form id="online-register-form" class="online-form">${formField('Логин','online-username','text','', 'autocomplete="username" minlength="3" maxlength="24" required')}${formField('Пароль','online-password','password','', 'autocomplete="new-password" minlength="8" required')}${formField('Код или ссылка приглашения','online-invite','text',invite, 'autocomplete="one-time-code" required')}<button class="primary" type="submit">Продолжить</button><button type="button" id="online-back">Уже есть аккаунт</button><p class="form-error" id="online-error" role="alert"></p></form>`);
    dialog.querySelector('#online-back').onclick = login; dialog.querySelector('form').onsubmit = async event => { event.preventDefault(); const error = dialog.querySelector('#online-error'); error.textContent = ''; try { const result = await json('/api/auth/register', {method:'POST', body: JSON.stringify({username:dialog.querySelector('#online-username').value.trim(), password:dialog.querySelector('#online-password').value, inviteCode:dialog.querySelector('#online-invite').value.trim()})}); await acceptAuth(result); dialog.close(); } catch (cause) { error.textContent = cause.message; } };
  }
  function characterForm() {
    const raceOptions = Object.entries(race).map(([id,label]) => `<option value="${id}">${label}</option>`).join('');
    const classOptions = Object.entries(classes).map(([id,label]) => `<option value="${id}">${label}</option>`).join('');
    const body = `<p class="hint">Выберите образ героя. Происхождение задаёт правила старта; боевые действия и снаряжение сервер проверяет сам. Магические и дальнобойные умения подключаются отдельными правилами.</p><form id="character-form" class="online-form character-form">${formField('Имя','character-name','text','', 'maxlength="24" autocomplete="nickname" required')}<label>Пол<select id="character-sex"><option value="male">Мужчина</option><option value="female">Женщина</option></select></label><label>Раса<select id="character-race">${raceOptions}</select></label><label>Происхождение<select id="character-origin"></select></label><label>Класс<select id="character-class">${classOptions}</select></label><p id="character-preview" class="character-preview"></p><button class="primary" type="submit">Начать в Товилисе</button><p class="form-error" id="online-error" role="alert"></p></form>`;
    const dialog = panel('Кто войдёт в город?', body);
    const raceSelect = dialog.querySelector('#character-race'), originSelect = dialog.querySelector('#character-origin');
    const updateOrigins = () => { const selected = raceSelect.value; originSelect.replaceChildren(...Object.entries(origins).filter(([id]) => originRace[id] === selected).map(([id,label]) => { const option = document.createElement('option'); option.value = id; option.textContent = label; return option; })); update(); };
    const update = () => { const r = raceSelect.value, o = originSelect.value, c = dialog.querySelector('#character-class').value, sex = dialog.querySelector('#character-sex').value; let preview = `${race[r]} · ${origins[o] || 'происхождение'} · ${classes[c]} · ${sex === 'female' ? 'женщина' : 'мужчина'}.`; try { const profile = window.TOVILIS_CHARACTERS?.profile({name:dialog.querySelector('#character-name').value || 'Герой', sex, race:r, origin:o, class:c}); if (profile) preview += ` Старт: сила ${profile.base.strength}, ловкость ${profile.base.agility}, защита ${profile.base.defense}, ЖС ${profile.base.maxHp}.`; } catch (_) {} dialog.querySelector('#character-preview').textContent = preview; };
    dialog.querySelectorAll('select').forEach(el => el.onchange = update); raceSelect.onchange = updateOrigins; dialog.querySelector('#character-name').oninput = update; updateOrigins();
    dialog.querySelector('form').onsubmit = async event => { event.preventDefault(); const error = dialog.querySelector('#online-error'); error.textContent = ''; const profile = {name:dialog.querySelector('#character-name').value.trim(), sex:dialog.querySelector('#character-sex').value, race:raceSelect.value, origin:originSelect.value, class:dialog.querySelector('#character-class').value}; try { command('createCharacter', {profile}, next => { state.game = next; state.character = next.hero?.character || profile; }); await state.pending; await bootstrapGame(); dialog.close(); } catch (cause) { error.textContent = cause.message; } };
  }
  async function acceptAuth(result) {
    state.token = result.token || result.session || state.token; try { if (state.token) sessionStorage.setItem('crimsonworld.online.session', state.token); } catch (_) {}
    state.account = result.account || result.user || null; state.character = result.character || result.state?.hero?.character || null;
    if (!state.character) {
      // Login responses intentionally contain no game state. Read it once so
      // an existing character enters the game while a fresh account sees the creator.
      try { const me = await json('/api/me'); state.account = me.user || state.account; state.character = me.character || me.state?.hero?.character || null; } catch (_) {}
    }
    if (!state.character || state.character.legacy) { characterForm(); return; }
    await bootstrapGame();
  }
  async function bootstrapGame() {
    const result = await json('/api/me'); state.account = result.user || state.account; state.game = result.state || result.game || result; state.revision = result.revision ?? state.revision ?? 0; state.character = result.character || state.game.hero?.character || state.character;
    state.readyResolve?.(state.game); state.readyResolve = null; document.body.classList.add('online-ready'); document.dispatchEvent(new CustomEvent('tovilis-online-ready', {detail:state})); startPresence(); return state.game;
  }
  let presenceTimer = null;
  function startPresence() {
    if (!enabled || presenceTimer) return;
    const poll = () => json('/api/world/presence').then(result => { state.presence = result.players || []; document.dispatchEvent(new CustomEvent('tovilis-presence', {detail:state.presence})); }).catch(() => {});
    poll(); presenceTimer = setInterval(poll, 5000);
  }
  function boot() {
    if (!enabled) return Promise.resolve(null);
    state.ready = new Promise(resolve => { state.readyResolve = resolve; });
    const existing = sessionStorage.getItem('crimsonworld.online.session');
    if (existing) { try { state.token = existing; } catch (_) {} }
    json('/api/me').then(result => acceptAuth(result)).catch(() => { if (inviteFromFragment) register(); else login(); });
    return state.ready;
  }
  function context(extra = {}) { state.context = {...state.context, ...extra}; }
  function command(method, args = {}, apply) {
    if (!enabled) return Promise.resolve(false); if (state.busy) return state.pending;
    state.busy = true; const id = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    const request = () => json('/api/commands', {method:'POST', body:JSON.stringify({commandId:id, method, args, revision:state.revision ?? 0})});
    state.pending = request().catch(async cause => {
      // A dropped response can leave a completed roll on the server. Re-send
      // the identical idempotent command once; never generate a new commandId.
      if (!cause.status || cause.status >= 500) return request();
      throw cause;
    }).then(result => { const next = result.state || result.game || result; state.revision = result.revision ?? state.revision; if (apply) apply(next); state.game = next; return next; }).catch(async cause => {
      if (/revision|conflict|version/i.test(cause.message)) {
        const latest = await bootstrapGame();
        if (latest) document.dispatchEvent(new CustomEvent('tovilis-online-conflict', {detail:latest}));
        return latest;
      }
      throw cause;
    }).finally(() => { state.busy = false; });
    return state.pending;
  }
  function feedback() {
    const body = `<form id="feedback-form" class="online-form"><label>Сообщение<textarea id="feedback-description" rows="8" maxlength="5000" placeholder="Что случилось или что стоит улучшить?" required></textarea></label><button class="primary" type="submit">Отправить</button><p class="form-error" id="feedback-error" role="alert"></p><p class="feedback-success" role="status"></p></form><details class="feedback-history"><summary>Мои сообщения</summary><div id="feedback-list"><p class="hint">Загрузка…</p></div></details>`;
    const dialog = panel('Обратная связь', body);
    const refresh = () => json('/api/feedback').then(result => { const list = dialog.querySelector('#feedback-list'); list.replaceChildren(); const items = result.items || []; if (!items.length) { htmlText(list, 'Обращений пока нет.', 'hint'); return; } items.forEach(item => { const row = document.createElement('article'); row.className = 'feedback-item'; const title = document.createElement('strong'); title.textContent = item.title; const meta = document.createElement('small'); const statuses = {open:'открыто',in_progress:'в работе',fixed:'исправлено',closed:'закрыто'}; meta.textContent = `${item.category === 'bug' ? 'Ошибка' : item.category === 'idea' ? 'Предложение' : 'Обратная связь'} · ${statuses[item.status] || item.status}`; const text = document.createElement('p'); text.textContent = item.body; row.append(title, meta, text); list.append(row); }); }).catch(() => {});
    const htmlText = (parent, text, className) => { const p = document.createElement('p'); p.textContent = text; if (className) p.className = className; parent.append(p); };
    dialog.querySelector('form').onsubmit = async event => { event.preventDefault(); const error = dialog.querySelector('#feedback-error'); const success = dialog.querySelector('.feedback-success'); error.textContent = ''; success.textContent = ''; try { const message = dialog.querySelector('#feedback-description').value.trim(); const firstLine = message.split(/\r?\n/).map(line => line.trim()).find(Boolean) || 'Обратная связь'; const title = firstLine.slice(0, 160); await json('/api/feedback', {method:'POST', body:JSON.stringify({category:'feedback', title, body:message})}); dialog.querySelector('form').reset(); success.textContent = 'Сообщение сохранено.'; refresh(); } catch (cause) { error.textContent = cause.message; } }; refresh();
  }
  function community() {
    const dialog = panel('Товилис сегодня', `<section class="online-community"><h3>Игроки рядом</h3><div id="online-players"><p class="hint">Загрузка…</p></div><form id="trade-form" class="online-chat-form"><select id="trade-recipient" aria-label="Получатель"></select><select id="trade-asset" aria-label="Предмет"></select><input id="trade-quantity" type="number" min="1" value="1" aria-label="Количество"><button class="primary">Предложить обмен</button></form><p id="online-community-error" class="form-error" role="alert"></p><div id="online-offers"></div><h3>Чат города</h3><div id="online-chat" class="online-chat"></div><form id="online-chat-form" class="online-chat-form"><input id="online-chat-input" maxlength="500" autocomplete="off" placeholder="Сообщение в городской чат"><button class="primary">Отправить</button></form></section>`);
    const error = message => { dialog.querySelector('#online-community-error').textContent = message || ''; };
    const itemLabel = (id, kind) => { const source = kind === 'finds' ? window.TOVILIS_CONTENT?.finds : kind === 'artifacts' ? window.TOVILIS_CONTENT?.artifacts : window.TOVILIS_CONTENT?.items; return source?.[id]?.name || id; };
    const syncMe = () => json('/api/me').then(result => { const next = result.state || result.game; if (!next) return; const changed = result.revision !== undefined && result.revision !== state.revision; state.revision = result.revision ?? state.revision; state.account = result.user || state.account; state.game = next; if (changed && !state.busy) document.dispatchEvent(new CustomEvent('tovilis-online-conflict', {detail:next})); }).catch(() => {});
    const refresh = () => Promise.all([json('/api/world/presence'), json('/api/chat'), json('/api/trades/offers')]).then(([presence, chat, offers]) => {
      error('');
      const players = presence.players || [], playerBox = dialog.querySelector('#online-players');
      playerBox.replaceChildren();
      if (!players.length) { const empty = document.createElement('p'); empty.className='hint'; empty.textContent='Поблизости пока никого нет.'; playerBox.append(empty); }
      players.forEach(player => { const p=document.createElement('p'); p.textContent=`${player.name || 'Игрок'}${player.cell ? ` · ${player.cell}` : ''}`; playerBox.append(p); });
      const recipient = dialog.querySelector('#trade-recipient'), previousRecipient = recipient.value;
      recipient.replaceChildren(...players.map(player => { const option=document.createElement('option'); option.value=player.user_id; option.textContent=`${player.name || 'Игрок'}${player.cell ? ` · ${player.cell}` : ''}`; return option; }));
      if ([...recipient.options].some(option => option.value === previousRecipient)) recipient.value=previousRecipient;
      const assets=dialog.querySelector('#trade-asset'), h=state.game?.hero || {}, equipment=h.equipment || {};
      const assetRows=[['coins','Монеты',h.coins||0,false],['food','Еда',h.food||0,false],['potions','Зелья',h.potions||0,false],['sword','Меч',h.sword?1:0,equipment.mainHand==='sword'],['shield','Щит',h.shield?1:0,equipment.offHand==='shield'],...Object.entries(h.finds||{}).map(([id,n])=>[id,itemLabel(id,'finds'),n,Object.values(equipment).includes(id)]),...(h.artifacts||[]).map(id=>[id,itemLabel(id,'artifacts'),1,Object.values(equipment).includes(id)])];
      const oldAsset=assets.value; assets.replaceChildren(); assetRows.filter(([, ,n])=>n>0).forEach(([id,label,n,locked])=>{const option=document.createElement('option');option.value=id;option.dataset.kind=id==='coins'?'coins':['food','potions','sword','shield'].includes(id)?'items':(h.artifacts||[]).includes(id)?'artifacts':'finds';option.dataset.max=n;option.disabled=locked;option.textContent=`${label} · ${n} шт.${locked?' · надето, сначала снимите':''}`;assets.append(option);}); if([...assets.options].some(option=>option.value===oldAsset)) assets.value=oldAsset;
      const offerBox=dialog.querySelector('#online-offers'); offerBox.replaceChildren(); (offers.offers||[]).forEach(offer=>{const row=document.createElement('article');row.className='trade-offer';const title=document.createElement('strong');title.textContent=`Предложение · ${offer.status==='open'?'ожидает ответа':offer.status==='accepted'?'принято':offer.status}`;const detail=document.createElement('p');let payload={};try{payload=JSON.parse(offer.payload||'{}');}catch(_){}const parts=[];if(payload.coins)parts.push(`${payload.coins} монет`);for(const [id,n] of Object.entries(payload.items||{}))parts.push(`${itemLabel(id,'items')} × ${n}`);for(const [id,n] of Object.entries(payload.finds||{}))parts.push(`${itemLabel(id,'finds')} × ${n}`);for(const id of payload.artifacts||[])parts.push(`артефакт ${itemLabel(id,'artifacts')}`);detail.textContent=parts.length?`Передают: ${parts.join(', ')}`:'Содержимое не указано';row.append(title,detail);if(offer.status==='open'&&Number(offer.recipient)===Number(state.account?.id)){const accept=document.createElement('button');accept.type='button';accept.textContent='Принять обмен';accept.onclick=async()=>{accept.disabled=true;try{await json(`/api/trades/offers/${encodeURIComponent(offer.id)}/accept`,{method:'POST'});await syncMe();await refresh();}catch(cause){error(cause.message);accept.disabled=false;}};row.append(accept);}if(offer.status==='open'&&Number(offer.sender)===Number(state.account?.id)){const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Отменить';cancel.onclick=async()=>{cancel.disabled=true;try{await json(`/api/trades/offers/${encodeURIComponent(offer.id)}/cancel`,{method:'POST'});await refresh();}catch(cause){error(cause.message);cancel.disabled=false;}};row.append(cancel);}if(offer.status==='open'&&Number(offer.recipient)===Number(state.account?.id)){const decline=document.createElement('button');decline.type='button';decline.textContent='Отклонить';decline.onclick=async()=>{decline.disabled=true;try{await json(`/api/trades/offers/${encodeURIComponent(offer.id)}/decline`,{method:'POST'});await refresh();}catch(cause){error(cause.message);decline.disabled=false;}};row.append(decline);}offerBox.append(row);});
      dialog.querySelector('#online-chat').replaceChildren(...(chat.messages||[]).map(message=>{const p=document.createElement('p');p.textContent=`${message.name||'Игрок'}: ${message.body||message.text||''}`;return p;}));
    }).catch(cause=>error(cause.message || 'Не удалось обновить общение.'));
    dialog.querySelector('#trade-form').onsubmit=async event=>{event.preventDefault();const asset=dialog.querySelector('#trade-asset').selectedOptions[0], recipient=dialog.querySelector('#trade-recipient').value;if(!asset?.value||!recipient){error('Выберите игрока и предмет для передачи.');return;}const kind=asset.dataset.kind, quantity=Math.max(1,Number(dialog.querySelector('#trade-quantity').value)||1);const payload=kind==='coins'?{coins:quantity}:kind==='artifacts'?{artifacts:[asset.value]}:{[kind]:{[asset.value]:quantity}};try{await json('/api/trades/offers',{method:'POST',body:JSON.stringify({recipient:Number(recipient),payload})});await refresh();}catch(cause){error(cause.message);}};
    dialog.querySelector('#online-chat-form').onsubmit=async event=>{event.preventDefault();const input=dialog.querySelector('#online-chat-input');if(!input.value.trim()){error('Введите сообщение.');return;}try{await json('/api/chat',{method:'POST',body:JSON.stringify({body:input.value.trim()})});input.value='';await refresh();}catch(cause){error(cause.message);}};
    const timer=setInterval(()=>{if(dialog.open){syncMe();refresh();}},3000); dialog.addEventListener('close',()=>clearInterval(timer),{once:true}); syncMe(); refresh();
  }  async function logout() { try { await json('/api/auth/logout', {method:'POST'}); } catch (_) {} try { sessionStorage.removeItem('crimsonworld.online.session'); } catch (_) {} location.reload(); }
  function mount() {
    if (!enabled || document.getElementById('online-actions')) return;
    const nav = document.querySelector('.top-actions'); if (!nav) return; const wrap = document.createElement('span'); wrap.id = 'online-actions'; wrap.className = 'online-actions';
    [['Общение',community],['Обратная связь',feedback]].forEach(([label, action]) => { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.onclick = action; wrap.append(button); }); nav.prepend(wrap);
    if (state.account?.isAdmin) { const link = document.createElement('a'); link.href = '/admin'; link.textContent = 'Админка'; wrap.append(link); }
    const menu = document.querySelector('#menu-dialog .menu-help');
    if (menu) { menu.querySelectorAll('details').forEach(detail => { if (detail.textContent.includes('Разметка карты для разработчиков')) detail.remove(); }); const onlineHelp = document.createElement('div'); onlineHelp.className = 'online-menu-actions'; const open = action => () => { document.querySelector('#menu-dialog')?.close(); action(); }; [['Открыть чат города',community],['Сообщить об ошибке / предложить улучшение',feedback],['Выйти',logout]].forEach(([label, action]) => { const button = document.createElement('button'); button.type = 'button'; button.id = label === 'Выйти' ? 'online-menu-logout' : ''; button.textContent = label; button.onclick = open(action); onlineHelp.append(button); }); menu.prepend(onlineHelp); }
  }
  window.TovilisOnline = {enabled, state, boot, mount, login, register, characterForm, feedback, community, logout, command, context, get ready(){return state.ready || Promise.resolve(null);}, get busy(){return state.busy;}};
  if (enabled) { document.body.classList.add('online-mode'); boot(); }
})();
