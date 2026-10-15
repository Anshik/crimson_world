'use strict';
/* Online shell.  The rules engine remains the renderer's source of truth in
 * offline mode; when the server meta flag is present this module owns login,
 * character creation and the small social panels. */
(() => {
  const meta = document.querySelector('meta[name="game-server"]');
  const enabled = Boolean(meta || new URLSearchParams(location.search).has('online'));
  const apiBase = meta && meta.content && meta.content !== 'true' ? meta.content.replace(/\/$/, '') : '';
  const state = {token: null, account: null, character: null, game: null, busy: false, ready: null, pending: Promise.resolve(), context: {}};
  const race = {human:'Человек', dwarf:'Гном', elf:'Эльф'};
  const origins = {north:'Север', tovilis:'Товилис', taranaris:'Таранарис', crimsonDragon:'Алый Дракон', abir:'Абир', sevenMines:'Семь Шахт', highElf:'Высшие эльфы', forestElf:'Лесные эльфы', dwarf:'Гномьи земли'};
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
    if (!response.ok) throw new Error(body.error || body.message || `Сервер ответил ${response.status}`);
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
    const dialog = panel('Войти в Товилис', `<p class="hint">В общей версии города прогресс хранится на сервере. Для первой регистрации понадобится только почта и пароль.</p><form id="online-login-form" class="online-form">${formField('Почта','online-email','email','', 'autocomplete="email" required')}${formField('Пароль','online-password','password','', 'autocomplete="current-password" minlength="8" required')}<button class="primary" type="submit">Войти</button><button type="button" id="online-register">Создать персонажа</button><p class="form-error" id="online-error" role="alert"></p></form>`);
    dialog.querySelector('#online-register').onclick = register; dialog.querySelector('form').onsubmit = async event => { event.preventDefault(); const error = dialog.querySelector('#online-error'); error.textContent = ''; try { const result = await json('/api/auth/login', {method:'POST', body: JSON.stringify({email:dialog.querySelector('#online-email').value.trim(), password:dialog.querySelector('#online-password').value})}); await acceptAuth(result); dialog.close(); } catch (cause) { error.textContent = cause.message; } };
  }
  function register() {
    const dialog = panel('Создать персонажа', `<p class="hint">Почта используется для входа. Регистрируйтесь только на сервере игры, которому доверяете.</p><form id="online-register-form" class="online-form">${formField('Почта','online-email','email','', 'autocomplete="email" required')}${formField('Пароль','online-password','password','', 'autocomplete="new-password" minlength="8" required')}<button class="primary" type="submit">Продолжить</button><button type="button" id="online-back">Уже есть аккаунт</button><p class="form-error" id="online-error" role="alert"></p></form>`);
    dialog.querySelector('#online-back').onclick = login; dialog.querySelector('form').onsubmit = async event => { event.preventDefault(); const error = dialog.querySelector('#online-error'); error.textContent = ''; try { const result = await json('/api/auth/register', {method:'POST', body: JSON.stringify({email:dialog.querySelector('#online-email').value.trim(), password:dialog.querySelector('#online-password').value})}); await acceptAuth(result); dialog.close(); } catch (cause) { error.textContent = cause.message; } };
  }
  function characterForm() {
    const raceOptions = Object.entries(race).map(([id,label]) => `<option value="${id}">${label}</option>`).join('');
    const originOptions = Object.entries(origins).map(([id,label]) => `<option value="${id}">${label}</option>`).join('');
    const classOptions = Object.entries(classes).map(([id,label]) => `<option value="${id}">${label}</option>`).join('');
    const body = `<p class="hint">Выберите образ героя. Происхождение задаёт правила старта; боевые действия и снаряжение сервер проверяет сам. Магические и дальнобойные умения подключаются отдельными правилами.</p><form id="character-form" class="online-form character-form">${formField('Имя','character-name','text','', 'maxlength="24" autocomplete="nickname" required')}<label>Пол<select id="character-sex"><option value="male">Мужчина</option><option value="female">Женщина</option></select></label><label>Раса<select id="character-race">${raceOptions}</select></label><label>Происхождение<select id="character-origin">${originOptions}</select></label><label>Класс<select id="character-class">${classOptions}</select></label><p id="character-preview" class="character-preview"></p><button class="primary" type="submit">Начать в Товилисе</button><p class="form-error" id="online-error" role="alert"></p></form>`;
    const dialog = panel('Кто войдёт в город?', body); const update = () => { const r = dialog.querySelector('#character-race').value, o = dialog.querySelector('#character-origin').value, c = dialog.querySelector('#character-class').value; dialog.querySelector('#character-preview').textContent = `${race[r]} · ${origins[o]} · ${classes[c]}. Начальные характеристики рассчитываются по правилам сервера.`; };
    dialog.querySelectorAll('select').forEach(el => el.onchange = update); update(); dialog.querySelector('form').onsubmit = async event => { event.preventDefault(); const error = dialog.querySelector('#online-error'); error.textContent = ''; const profile = {name:dialog.querySelector('#character-name').value.trim(), sex:dialog.querySelector('#character-sex').value, race:dialog.querySelector('#character-race').value, origin:dialog.querySelector('#character-origin').value, class:dialog.querySelector('#character-class').value}; try { command('createCharacter', {profile}, next => { state.game = next; state.character = next.hero?.character || profile; }); await state.pending; await bootstrapGame(); dialog.close(); } catch (cause) { error.textContent = cause.message; } };
  }
  async function acceptAuth(result) { state.token = result.token || result.session || state.token; try { if (state.token) sessionStorage.setItem('crimsonworld.online.session', state.token); } catch (_) {} state.account = result.account || result.user || null; state.character = result.character || result.state?.hero?.character || null; if (!state.character) { characterForm(); return; } await bootstrapGame(); }
  async function bootstrapGame() {
    const result = await json('/api/me'); state.game = result.state || result.game || result; state.revision = result.revision ?? state.revision ?? 0; state.character = result.character || state.game.hero?.character || state.character;
    state.readyResolve?.(state.game); state.readyResolve = null; document.body.classList.add('online-ready'); document.dispatchEvent(new CustomEvent('tovilis-online-ready', {detail:state}));
  }
  function boot() {
    if (!enabled) return Promise.resolve(null);
    state.ready = new Promise(resolve => { state.readyResolve = resolve; });
    const existing = sessionStorage.getItem('crimsonworld.online.session');
    if (existing) { try { state.token = existing; } catch (_) {} }
    json('/api/me').then(result => acceptAuth(result)).catch(() => login());
    return state.ready;
  }
  function context(extra = {}) { state.context = {...state.context, ...extra}; }
  function command(method, args = {}, apply) {
    if (!enabled) return Promise.resolve(false); if (state.busy) return state.pending;
    state.busy = true; const id = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    state.pending = json('/api/commands', {method:'POST', body:JSON.stringify({commandId:id, method, args, revision:state.revision ?? 0})}).then(result => { const next = result.state || result.game || result; state.revision = result.revision ?? state.revision; if (apply) apply(next); state.game = next; return next; }).catch(cause => { if (/revision|conflict|version/i.test(cause.message)) return bootstrapGame().then(() => { throw cause; }); throw cause; }).finally(() => { state.busy = false; });
    return state.pending;
  }
  function feedback() {
    const body = `<form id="feedback-form" class="online-form">${formField('Заголовок','feedback-title','text','', 'maxlength="120" required')}<label>Тип<select id="feedback-kind"><option value="bug">Ошибка</option><option value="idea">Предложение</option><option value="rule">Вопрос по правилам</option></select></label><label>Описание<textarea id="feedback-description" rows="6" maxlength="5000" required></textarea></label><label>Что ожидали?<textarea id="feedback-expected" rows="3" maxlength="1500"></textarea></label><label>Что произошло?<textarea id="feedback-actual" rows="3" maxlength="1500"></textarea></label><p class="hint">К обращению автоматически добавятся версия игры, клетка, фаза и последнее действие.</p><button class="primary" type="submit">Отправить</button><p class="form-error" id="feedback-error" role="alert"></p></form>`;
    const dialog = panel('Обратная связь', body); dialog.querySelector('form').onsubmit = async event => { event.preventDefault(); const error = dialog.querySelector('#feedback-error'); error.textContent = ''; try { const f = id => dialog.querySelector(`#${id}`).value.trim(); const expected = f('feedback-expected'), actual = f('feedback-actual'); const description = `${f('feedback-description')}${expected ? `\n\nОжидалось:\n${expected}` : ''}${actual ? `\n\nПолучилось:\n${actual}` : ''}`; await json('/api/feedback', {method:'POST', body:JSON.stringify({category:dialog.querySelector('#feedback-kind').value === 'rule' ? 'feedback' : dialog.querySelector('#feedback-kind').value, title:f('feedback-title'), body:description})}); dialog.querySelector('.online-body').innerHTML = '<p class="feedback-success">Спасибо. Обращение сохранено, разработчик увидит его вместе с контекстом партии.</p>'; } catch (cause) { error.textContent = cause.message; } };
  }
  function community() {
    const dialog = panel('Товилис сегодня', `<section class="online-community"><h3>Игроки рядом</h3><div id="online-players"><p class="hint">Загрузка…</p></div><form id="trade-form" class="online-chat-form"><select id="trade-recipient" aria-label="Получатель"></select><select id="trade-asset" aria-label="Предмет"></select><input id="trade-quantity" type="number" min="1" value="1" aria-label="Количество"><button class="primary">Предложить обмен</button></form><div id="online-offers"></div><h3>Чат города</h3><div id="online-chat" class="online-chat"></div><form id="online-chat-form" class="online-chat-form"><input id="online-chat-input" maxlength="500" autocomplete="off" placeholder="Сообщение в городской чат"><button class="primary">Отправить</button></form></section>`);
    const refresh = () => Promise.all([json('/api/world/presence'), json('/api/chat'), json('/api/trades/offers')]).then(([presence, chat, offers]) => { const players = presence.players || []; const recipient = dialog.querySelector('#trade-recipient'); recipient.replaceChildren(...players.map(player => { const option = document.createElement('option'); option.value = player.user_id; option.textContent = `${player.name || 'Игрок'}${player.cell ? ` · ${player.cell}` : ''}`; return option; })); const assets = dialog.querySelector('#trade-asset'); assets.replaceChildren(); const h = state.game?.hero || {}; [['coins','Монеты',h.coins || 0], ...Object.entries(h.finds || {}).map(([id,n]) => [id,`Находка: ${id}`,n]), ...(h.artifacts || []).map(id => [id,`Артефакт: ${id}`,1])].filter(([, ,n]) => n > 0).forEach(([id,label]) => { const option = document.createElement('option'); option.value = id; option.dataset.kind = id === 'coins' ? 'coins' : (h.artifacts || []).includes(id) ? 'artifacts' : 'finds'; option.textContent = `${label} · ${id === 'coins' ? 'монеты' : '1 шт.'}`; assets.append(option); }); const offerBox = dialog.querySelector('#online-offers'); offerBox.replaceChildren(...(offers.offers || []).map(offer => { const p = document.createElement('p'); p.textContent = `Обмен ${offer.status}`; if (offer.status === 'open' && Number(offer.recipient) === Number(state.account?.id)) { const button = document.createElement('button'); button.type='button'; button.textContent='Принять'; button.onclick=async()=>{await json(`/api/trades/offers/${encodeURIComponent(offer.id)}/accept`,{method:'POST'});refresh();}; p.append(' ',button); } return p; })); const messages = chat.messages || []; dialog.querySelector('#online-chat').replaceChildren(...messages.map(message => { const p = document.createElement('p'); p.textContent = `${message.name || 'Игрок'}: ${message.body || message.text || ''}`; return p; })); }).catch(() => {});
    dialog.querySelector('#trade-form').onsubmit = async event => { event.preventDefault(); const asset = dialog.querySelector('#trade-asset').selectedOptions[0]; if (!asset?.value) return; const kind = asset.dataset.kind; const quantity = Number(dialog.querySelector('#trade-quantity').value) || 1; const payload = kind === 'coins' ? {coins:quantity} : {[kind]: {[asset.value]:quantity}}; try { await json('/api/trades/offers', {method:'POST', body:JSON.stringify({recipient:Number(dialog.querySelector('#trade-recipient').value),payload})}); refresh(); } catch (_) {} };
    dialog.querySelector('form').onsubmit = async event => { event.preventDefault(); const input = dialog.querySelector('#online-chat-input'); if (!input.value.trim()) return; try { await json('/api/chat', {method:'POST', body:JSON.stringify({body:input.value.trim()})}); input.value = ''; refresh(); } catch (_) {} }; refresh();
  }
  function mount() {
    if (!enabled || document.getElementById('online-actions')) return;
    const nav = document.querySelector('.top-actions'); if (!nav) return; const wrap = document.createElement('span'); wrap.id = 'online-actions'; wrap.className = 'online-actions';
    [['Общение',community],['Обратная связь',feedback]].forEach(([label, action]) => { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.onclick = action; wrap.append(button); }); nav.prepend(wrap);
    const menu = document.querySelector('#menu-dialog .menu-help');
    if (menu) { const onlineHelp = document.createElement('div'); onlineHelp.className = 'online-menu-actions'; [['Открыть чат города',community],['Сообщить об ошибке / предложить улучшение',feedback]].forEach(([label, action]) => { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.onclick = action; onlineHelp.append(button); }); menu.prepend(onlineHelp); }
  }
  window.TovilisOnline = {enabled, state, boot, mount, login, register, characterForm, feedback, community, command, context, get ready(){return state.ready || Promise.resolve(null);}, get busy(){return state.busy;}};
  if (enabled) boot();
})();
