'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = map => factory(map, require('./content.js'), require('./equipment.js'), require('./characters.js'));
  else root.createTovilisRules = map => factory(map, root.TOVILIS_CONTENT, root.createTovilisEquipment, root.TOVILIS_CHARACTERS);
})(typeof window === 'undefined' ? globalThis : window, function createRules(map, content, createEquipment, characters) {
  const equipment = createEquipment(content);
  const VERSION = 9;
  const cells = new Map(map.cells.map(c => [c.id, c]));
  const neighbours = new Map(map.cells.map(c => [c.id, []]));
  const buildings = new Map(map.buildings.map(b => [b.id, b]));
  for (const e of map.edges) {
    if (!cells.get(e.from).walkable || !cells.get(e.to).walkable) continue;
    neighbours.get(e.from).push(e.to);
    if (e.bidirectional) neighbours.get(e.to).push(e.from);
  }
  const copy = v => JSON.parse(JSON.stringify(v));
  const FIND_IDS = ['glass','defenseRing','caneKnob','platinumRing','almaMedallion','chrysoberyl'];
  const require = (condition, message) => { if (!condition) throw new Error(message); };
  const integer = (v, min, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= min && v <= max;
  const at = id => map.buildings.filter(b => b.cell === id);
  function draw(die, sides = 6) {
    const value = die(sides);
    require(integer(value, 1, sides), `Нужен бросок от 1 до ${sides}.`);
    return value;
  }
  function log(s, text) { s.journal.push({turn: s.turn, text}); s.journal = s.journal.slice(-80); }
  function clock(ticks) {
    const step = ticks % 18;
    return {day: Math.floor(ticks / 18) + 1, night: step >= 12, remaining: step < 12 ? 12 - step : 18 - step};
  }
  function facing(from, to) {
    const a = cells.get(from).position, b = cells.get(to).position;
    const i = (Math.round(Math.atan2(b[1] - a[1], b[0] - a[0]) / (Math.PI / 4)) + 8) % 8;
    return ['east', 'southeast', 'south', 'southwest', 'west', 'northwest', 'north', 'northeast'][i];
  }
  function create(name = 'Борин') {
    const state = {
      version: VERSION, mapId: map.id, mapRevision: map.revision,
      phase: 'ready', position: buildings.get(content.startingPlace).cell, previous: null, facing: 'south', turn: 0, ticks: 0,
      hero: {name, character: {legacy: true, sex: 'male', race: 'dwarf', origin: 'dwarf', class: 'warrior'}, hp: content.equipment.base.maxHp, food: 4, coins: 1, potions: 1, sword: false, shield: false, net: false, finds: {}, experience: 0, reputation: 0, slowMoves: 0, lore: []},
      bank: {}, world: {uniqueArtifacts: {}}, shopInterest: {}, lastTrade: null, notice: null,
      quest: 'none', millJob: false, familyMet: false,
      workLedger: {day: 1, count: 0}, job: null, tavernGame: null,
      selection: null, pending: null, landing: null, encounter: null, outcome: null, lastMove: null, feedback: null,
      journal: [{turn: 0, text: `${name} вошёл в Товилис между лавкой и трактиром. Первое поручение можно получить в городском Заказе.`}]
    };
    equipment.migrateHero(state.hero);
    return state;
  }
  function createCharacter(input) {
    const profile = characters.profile(input);
    const state = create(profile.name);
    state.hero.character = profile;
    state.hero.hp = profile.base.maxHp;
    equipment.migrateHero(state.hero);
    state.journal = [{turn: 0, text: `${profile.name} вошёл в Товилис как ${profile.labels.race} ${profile.labels.class}. Первое поручение можно получить в городском Заказе.`}];
    return state;
  }
  function corridor(from, next) {
    require(neighbours.get(from)?.includes(next), 'Выберите соседнюю клетку.');
    const path = [from, next];
    while (neighbours.get(path.at(-1)).length === 2) {
      const onward = neighbours.get(path.at(-1)).find(id => id !== path.at(-2));
      if (path.includes(onward)) break;
      path.push(onward);
    }
    return path;
  }
  function directions(from) {
    require(cells.has(from), 'Неизвестная клетка.');
    return neighbours.get(from).map(next => {
      const path = corridor(from, next), entrance = path.slice(1).find(id => at(id).length);
      return {next, path, building: entrance ? at(entrance)[0] : null};
    });
  }
  function shortestPath(from, to) {
    require(cells.has(from) && cells.has(to), 'Неизвестная клетка.');
    const parents = new Map([[from, null]]), queue = [from];
    for (const id of queue) {
      if (id === to) {
        const path = [];
        for (let cur = to; cur !== null; cur = parents.get(cur)) path.unshift(cur);
        return path;
      }
      for (const n of neighbours.get(id)) if (!parents.has(n)) { parents.set(n, id); queue.push(n); }
    }
    return [];
  }
  function choose(s, next, stopBuilding = null) {
    require(s.phase === 'ready', 'Сначала завершите текущее событие.');
    const option = directions(s.position).find(d => d.next === next);
    require(option, 'В этом направлении нет улицы.');
    require(stopBuilding === null || option.building?.id === stopBuilding, 'Доступен только ближайший вход на выбранной улице.');
    return {...copy(s), selection: {next, stopBuilding}, facing: facing(s.position, next), feedback: null};
  }
  function plan(from, next, roll, stopBuilding = null, movementPenalty = 0) {
    require(integer(roll, 1, 6), 'Кубик должен дать число от 1 до 6.');
    const option = directions(from).find(d => d.next === next);
    require(option, 'В этом направлении нет улицы.');
    require(stopBuilding === null || option.building?.id === stopBuilding, 'Недоступный вход.');
    const stopIndex = stopBuilding ? option.path.indexOf(buildings.get(stopBuilding).cell) : Infinity;
    const usableRoll = Math.max(1, roll - movementPenalty);
    const steps = Math.min(usableRoll, option.path.length - 1, stopIndex), path = option.path.slice(0, steps + 1);
    const degree = neighbours.get(path.at(-1)).length;
    return {path, reason: steps === stopIndex ? 'building' : degree > 2 ? 'junction' : degree === 1 ? 'dead_end' : 'dice', unused: usableRoll - steps, stopBuilding};
  }
  function makeEncounter(roll, night, countRoll = null) {
    const kind = ['merchant', 'merchant', 'bard', 'soldier', 'bandits', 'robber'][roll - 1];
    const hostile = night && ['bandits', 'robber'].includes(kind);
    const count = kind === 'bandits' ? countRoll >= 5 ? 2 : 1 : kind === 'robber' ? 1 : 0;
    const profile = kind === 'bandits' ? 'bandit' : 'robber';
    return {kind, roll, night, hostile, countRoll, demand: kind === 'bandits' ? 2 : kind === 'robber' ? 3 : 0,
      enemies: Array.from({length: count}, (_, i) => ({...content.enemies[profile], profile, id: `enemy-${i + 1}`, maxHp: content.enemies[profile].hp})),
      round: 0, report: null};
  }
  function begin(s, die) {
    require(s.phase === 'ready' && s.selection, 'Сначала выберите направление.');
    choose(s, s.selection.next, s.selection.stopBuilding);
    const roll = draw(die), movementPenalty = s.hero.slowMoves > 0 ? 1 : 0, move = plan(s.position, s.selection.next, roll, s.selection.stopBuilding, movementPenalty);
    const event = cells.get(move.path.at(-1)).event || null;
    const eventRoll = event ? draw(die, event === 'notice' ? content.cityNotices.length : 6) : null;
    const eventData = event === 'encounter' ? makeEncounter(eventRoll, clock(s.ticks).night, eventRoll === 5 ? draw(die) : null) : null;
    const result = copy(s);
    result.phase = 'moving'; result.feedback = null;
    result.pending = {...move, roll, movementPenalty, event, eventRoll, eventData, ...(event === 'notice' ? {noticeVersion: 3, noticeId: content.cityNotices[eventRoll - 1].id} : {}), id: s.turn + 1, startedAtTick: s.ticks};
    return result;
  }
  function advanceTime(s, ticks) {
    for (let i = 0; i < ticks; i++) {
      s.ticks += 1;
      if (s.ticks % 6 !== 0) continue;
      if (s.hero.food > 0) { s.hero.food -= 1; log(s, 'В дороге съедена порция еды.'); }
      else { s.hero.hp = Math.max(1, s.hero.hp - 1); log(s, 'Голод: −1 жизненная сила (минимум 1).'); }
    }
  }
  function endTurn(s) {
    const move = s.pending;
    if (move && s.hero.slowMoves > 0) s.hero.slowMoves -= 1;
    s.turn += 1; advanceTime(s, 1);
    s.phase = 'ready'; s.notice = null; s.selection = null; s.pending = null; s.landing = null; s.encounter = null; s.outcome = null;
    // Keep the chosen street between junctions, with reversal still available before the next roll.
    if (move && s.position === move.path.at(-1) && move.reason === 'dice' && neighbours.get(s.position).length === 2) {
      const next = neighbours.get(s.position).find(id => id !== s.previous);
      const option = directions(s.position).find(d => d.next === next);
      s.selection = {next, stopBuilding: option.building?.id === move.stopBuilding ? move.stopBuilding : null};
    }
    return s;
  }
  function arrive(s) {
    if (s.phase !== 'moving') return s;
    const result = copy(s), m = result.pending;
    result.position = m.path.at(-1); result.previous = m.path.at(-2); result.facing = facing(result.previous, result.position); result.lastMove = copy(m);
    const stops = {building: 'у входа', junction: 'на перекрёстке', dead_end: 'в конце улицы', dice: 'по броску'};
    log(result, `Кубик ${m.roll}: пройдено ${m.path.length - 1} кл., остановка ${stops[m.reason]}.`);
    if (m.event === 'notice') {
      result.phase = 'notice'; result.landing = {id: m.id, kind: 'notice', roll: m.eventRoll};
      if (m.noticeVersion === 3) result.notice = {id: m.noticeId, stage: 'choice', action: null, rolls: [], text: null, extraTicks: 0, slowMoves: 0};
      return result;
    }
    if (m.event === 'encounter') { result.phase = 'encounter'; result.encounter = copy(m.eventData);
      if (equipment.stats(result.hero).peaceful && result.encounter.enemies.length) { result.encounter.hostile = false; result.encounter.protectedByArtifact = true; } log(result, `Встреча (${m.eventRoll}): ${content.encounters[result.encounter.kind].name}.`); return result; }
    return endTurn(result);
  }
  function acknowledge(s) {
    if (s.phase === 'hunting') {
      require(s.hunt.stage === 'result', 'Сначала завершите охоту.');
      const result = copy(s); result.phase = 'ready'; result.hunt = null; result.feedback = 'Охота завершена. Вы у входа в Товилис, U07.'; return result;
    }
    if (s.phase === 'won') { const result = copy(s); result.phase = 'ready'; result.feedback = 'Заказ выполнен. Можно продолжать прогулку по Товилису.'; return result; }
    if (s.phase === 'tavern-game') { const result = copy(s); result.phase = 'ready'; result.tavernGame = null; return result; }
    if (s.phase === 'work-result') { const result = copy(s); result.phase = 'ready'; result.job = null; return result; }
    if (s.phase === 'outcome') return endTurn(copy(s));
    if (s.phase !== 'notice') return s;
    const result = copy(s), roll = result.landing.roll;
    if (result.pending.noticeVersion === 3) {
      require(result.notice?.stage === 'result', 'Сначала выберите действие и завершите извещение.');
      const {extraTicks, slowMoves} = result.notice;
      advanceTime(result, extraTicks);
      endTurn(result);
      if (slowMoves) result.hero.slowMoves = slowMoves;
      return result;
    }
    if (result.pending.noticeVersion === 2) {
      if (roll === 1) result.hero.coins += 2;
      if (roll === 3) result.hero.hp = Math.max(1, result.hero.hp - 2);
      if (roll === 4) advanceTime(result, 1);
      if (roll === 5) result.hero.coins = Math.max(0, result.hero.coins - 2);
      if (roll === 6) advanceTime(result, 2);
      log(result, `Извещение (${roll}): ${content.notices[roll - 1].title}.`);
    } else if (roll <= 2) log(result, `Извещение (${roll}): в порту ищут помощников для дневной работы.`);
    else if (roll <= 4) { result.hero.coins += 1; log(result, `Извещение (${roll}): +1 монета.`); }
    else { result.hero.hp = Math.max(1, result.hero.hp - 1); log(result, `Извещение (${roll}): гном споткнулся, −1 жизненная сила.`); }
    return endTurn(result);
  }
  function noticeCard(s) { return content.cityNotices.find(n => n.id === s.notice?.id) || null; }
  function noticeFind(s) {
    if (!s || s.notice?.id !== 'find' || s.notice.stage !== 'result' || s.notice.action !== 'search') return null;
    const result = [...(s.notice.rolls || [])].reverse().find(r => r && r.label === 'Находка' && integer(r.value, 1, 6));
    if (!result) return null;
    const id = FIND_IDS[result.value - 1];
    return id ? {id, ...copy(content.finds[id])} : null;
  }
  function noticeAction(s, action, die) {
    require(s.phase === 'notice' && s.pending.noticeVersion === 3 && s.notice?.stage === 'choice', 'Извещение уже завершено.');
    const card = noticeCard(s);
    require(card?.actions.some(a => a[0] === action), 'Это действие недоступно.');
    require(!(card.id === 'elf' && action === 'help') || s.hero.potions > 0, 'Для помощи нужно лечебное зелье.');
    const result = copy(s), n = result.notice, h = result.hero, effects = [];
    const roll = (label, sides = 6) => { const value = draw(die, sides); n.rolls.push({label, value, sides}); return value; };
    const coins = amount => { const delta = Math.max(-h.coins, amount); h.coins += delta; effects.push(`Монеты: ${delta >= 0 ? '+' : ''}${delta}`); };
    const xp = amount => { const delta = Math.max(-h.experience, amount); h.experience += delta; effects.push(`Опыт: ${delta >= 0 ? '+' : ''}${delta}`); };
    const rep = amount => { h.reputation += amount; effects.push(`Репутация: ${amount > 0 ? '+' : ''}${amount}`); };
    const hurt = () => { const loss = Math.min(2, h.hp - 1); h.hp -= loss; effects.push(`Жизненные силы: −${loss}`); };
    let text = '';
    if (action === 'pass') text = 'Гном продолжил путь, не вмешиваясь.';
    else if (card.id === 'fortune') { coins(2); text = 'Удача улыбнулась: монеты уже в кошельке.'; }
    else if (card.id === 'find') {
      const id = FIND_IDS[roll('Находка') - 1];
      h.finds[id] = (h.finds[id] || 0) + 1;
      if (id === 'defenseRing' && h.finds[id] === 1) { h.equipment.ring = id; equipment.refresh(h); }
      text = `Найдено: ${content.finds[id].name}. ${id === 'defenseRing' ? 'Одно кольцо надето: защита +1. Остальные остаются в сумке.' : content.finds[id].detail}`;
    } else if (card.id === 'fall') { hurt(); text = 'Гном поднялся с мостовой и отряхнулся.'; }
    else if (card.id === 'mood') {
      if (roll('Настроение') <= 3) { xp(10); n.extraTicks = 1; text = 'Красота мира прогнала тревоги. Ещё один ход времени ушёл на созерцание.'; }
      else { xp(-10); text = 'Мрачные мысли никак не выходят из головы.'; }
    } else if (card.id === 'actors') {
      coins(-roll('Пропавшие монеты', 4));
      if (roll('Игра актёров') >= 5) { xp(3); text = 'Актёры играли прекрасно. Даже потеря денег не испортила настроения.'; }
      else text = 'Пока вы смотрели представление, карманники успели добраться до монет.';
    } else if (card.id === 'friend') {
      n.extraTicks = 3; n.slowMoves = 2;
      text = 'Разговор затянулся. Ещё три хода времени прошли за столом; головная боль укоротит следующие два перемещения на один шаг.';
      if (roll('Рассказ знакомого') === 6) { if (!h.lore.includes('alien-lake')) h.lore.push('alien-lake'); text += ' Знакомый рассказал о Чуждом Озере в Отверженных Землях и указал его на своей карте.'; }
    } else if (card.id === 'chase') {
      const value = roll('Погоня');
      if (value <= 2) text = 'Догнать прохожего не удалось.';
      else if (value <= 4) { coins(3); rep(1); xp(2); text = 'Это оказался вор. Горожане благодарят за помощь.'; }
      else { rep(-1); text = 'Это обычный горожанин, спешивший по делам. Вы обознались.'; }
    } else if (card.id === 'elf') { h.potions -= 1; coins(2); rep(1); text = 'Лечебное зелье спасло эльфа. Он благодарит вас за помощь. Зелья: −1.'; }
    else if (card.id === 'wasp') { rep(1); text = 'Горожане долго будут вспоминать эту сцену. Укус оказался безвредным.'; }
    else if (card.id === 'cat') {
      if (roll('Простуда') <= 3) { hurt(); text = 'Холодная вода и прохладный воздух не прошли бесследно: вы простудились.'; }
      else text = 'Несмотря на холодную воду, вы не заболели.';
    } else if (card.id === 'water') {
      n.extraTicks = 3;
      if (roll('Помощь с вёдрами') <= 4) { coins(2); rep(1); xp(10); text = 'Вы донесли воду. Женщина от души благодарит вас.'; }
      else { xp(roll('Полученный опыт', 3)); text = 'Вы споткнулись, расплескали воду и облили прохожих. Награды нет, но опыт пригодится.'; }
    } else if (card.id === 'rescuer') { coins(3); rep(1); xp(5); text = 'Горожане рассказывают, как вы спасли ребёнка. Благодарность заслужена.'; }
    n.stage = 'result'; n.action = action; n.text = [text, ...effects].join(' ');
    log(result, `${card.title}. ${n.text}`);
    return result;
  }
  function outcome(s, kind, title, text) {
    s.phase = 'outcome'; s.outcome = {kind, title, text}; log(s, text); return s;
  }
  function encounterAction(s, action) {
    require(s.phase === 'encounter', 'Эта встреча уже завершена.');
    const e = s.encounter, result = copy(s);
    if (action === 'provoke') {
      require(!equipment.stats(s.hero).peaceful, 'Слеза Сострадания запрещает агрессию. Снимите её до встречи.');
      require(e.kind === 'robber' && !e.night && !e.hostile, 'Сейчас нельзя вызвать разбойника на бой.');
      result.encounter.hostile = true; result.encounter.provoked = true; result.phase = 'combat';
      log(result, 'Гном вызвал дневного разбойника на бой.'); return result;
    }
    if (action === 'pass') {
      require(!e.hostile, 'Враги преградили дорогу. Выберите способ уйти.');
      log(result, 'Путник продолжил дорогу.'); return endTurn(result);
    }
    if (action === 'pay') {
      require(e.hostile && s.hero.coins >= e.demand, 'Не хватает монет для откупа.');
      result.hero.coins -= e.demand;
      return outcome(result, 'peace', 'Дорога свободна', `Заплачено ${e.demand} монеты. Противники пропустили гнома.`);
    }
    if (action === 'buy') {
      require(e.kind === 'merchant' && s.hero.coins >= 3 && s.hero.potions < 3, 'Для покупки нужны 3 монеты и место в сумке.');
      result.hero.coins -= 3; result.hero.potions += 1;
      return outcome(result, 'trade', 'Зелье в сумке', 'Куплено одно зелье за 3 монеты.');
    }
    if (action === 'heal') {
      require(e.kind === 'bard' && s.hero.coins >= 4 && s.hero.hp < s.hero.maxHp, 'Для лечения нужны ранения и 4 монеты.');
      result.hero.coins -= 4; result.hero.hp = result.hero.maxHp;
      return outcome(result, 'heal', 'Песня помогла', 'Певица восстановила все жизненные силы за 4 монеты.');
    }
    throw new Error('Недоступное действие встречи.');
  }
  function escapeThreshold(s) { return Math.max(2, Math.min(6, 4 + Math.max(...s.encounter.enemies.filter(e => e.hp > 0).map(e => e.agility)) - s.hero.agility)); }
  function equippedWeapon(hero) { return hero.equipment.mainHand; }
  function equipmentProfile(s) { return equipment.profile(s.hero); }
  function equip(s, slot, id) {
    require(s.phase === 'ready', 'Снаряжение можно менять вне боя и незавершённого события.');
    const result = copy(s);
    equipment.change(result.hero, slot, id);
    result.feedback = id ? `Надето: ${equipment.definition(id).name}.` : `${content.equipment.slots[slot]}: вещь убрана в сумку.`;
    log(result, result.feedback); return result;
  }
  function grantArtifact(s, id) {
    require(s.phase === 'ready', 'Сначала завершите событие.');
    const item = content.artifacts[id];
    require(item && Object.hasOwn(content.artifacts, id), 'Неизвестный артефакт.');
    require(!s.hero.artifacts.includes(id) && (!item.unique || !Object.hasOwn(s.world.uniqueArtifacts, id)), 'Единственный экземпляр артефакта уже получен.');
    const result = copy(s); result.hero.artifacts.push(id);
    if (item.unique) result.world.uniqueArtifacts[id] = 'hero';
    log(result, `Получен артефакт: ${item.name}.`); return result;
  }
  function defeat(s) {
    const lost = Math.ceil(s.hero.coins / 2);
    s.hero.coins -= lost; s.hero.hp = Math.min(8, s.hero.maxHp); s.position = buildings.get('tavern').cell; s.previous = null; s.facing = 'south';
    return outcome(s, 'defeat', 'Обратно в таверну', `Гном вернулся в таверну с 8 жизненными силами. Потеряно монет: ${lost}. Снаряжение и сеть сохранены.`);
  }
  function victory(s) {
    const reward = s.encounter.enemies.reduce((sum, e) => sum + e.reward, 0);
    s.hero.coins += reward;
    return outcome(s, 'victory', 'Победа', `Противники повержены. Награда: ${reward} монеты.`);
  }
  function battle(s, action, die, targetId = null) {
    require(['encounter', 'combat'].includes(s.phase) && s.encounter?.hostile && !equipment.stats(s.hero).peaceful, 'Сейчас нет боя.');
    require(['attack', 'potion', 'flee', 'surrender', 'switch'].includes(action), 'Неизвестное действие боя.');
    const target = s.encounter.enemies.find(e => e.id === targetId && e.hp > 0);
    if (action === 'attack') require(target, 'Выберите живого противника.');
    if (action === 'potion') require(s.hero.potions > 0 && s.hero.hp < s.hero.maxHp, 'Сейчас зелье не требуется или его нет.');
    if (action === 'switch') require(s.hero.sword && ['shortSword', 'sword'].includes(targetId) && targetId !== equippedWeapon(s.hero), 'Нет другого оружия для смены.');
    const result = copy(s), e = result.encounter;
    if (action === 'surrender') return defeat(result);
    result.phase = 'combat'; e.round += 1;
    e.report = {round: e.round, action, initiative: [], hits: [], flee: null, switch: null};
    function strike(attacker, defender, attackerId, defenderId) {
      const attackDie = draw(die, attackerId === 'hero' ? equipment.definition(equippedWeapon(result.hero)).damage.sides : 6), absorption = defender.defense ? draw(die, defender.defense) : 0;
      const attack = attackDie + attacker.attackBonus, damage = Math.max(0, attack - absorption);
      defender.hp = Math.max(0, defender.hp - damage);
      e.report.hits.push({attacker: attackerId, defender: defenderId, attackDie, bonus: attacker.attackBonus, attack, absorption, damage});
      log(result, `${attackerId === 'hero' ? result.hero.name : attacker.name}: ${attackDie}+${attacker.attackBonus} − ${absorption} защиты = ${damage} урона.`);
    }
    if (action === 'flee') {
      const roll = draw(die), threshold = escapeThreshold(result);
      e.report.flee = {roll, threshold};
      if (roll >= threshold) {
        const from = result.position;
        result.position = result.pending.path.at(-2); result.previous = result.pending.path.length > 2 ? result.pending.path.at(-3) : null;
        result.facing = facing(from, result.position);
        return outcome(result, 'flee', 'Удалось уйти', `Бегство: ${roll} ≥ ${threshold}. Гном отступил на предыдущую клетку; нового события нет.`);
      }
      log(result, `Бегство: ${roll} < ${threshold}. Противники атакуют.`);
      for (const enemy of e.enemies.filter(enemy => enemy.hp > 0)) {
        strike(enemy, result.hero, enemy.id, 'hero');
        if (result.hero.hp === 0) return defeat(result);
      }
      return result;
    }
    const actors = [{id: 'hero', stats: result.hero, order: 0}, ...e.enemies.filter(enemy => enemy.hp > 0).map((stats, i) => ({id: stats.id, stats, order: i + 1}))];
    for (const actor of actors) { actor.die = draw(die); actor.initiative = actor.die + actor.stats.agility; }
    actors.sort((a, b) => b.initiative - a.initiative || b.stats.agility - a.stats.agility || a.order - b.order);
    e.report.initiative = actors.map(a => ({id: a.id, die: a.die, agility: a.stats.agility, total: a.initiative}));
    for (const actor of actors) {
      if (actor.stats.hp <= 0) continue;
      if (actor.id === 'hero') {
        if (action === 'potion') {
          result.hero.potions -= 1;
          const healed = Math.min(5, result.hero.maxHp - result.hero.hp); result.hero.hp += healed;
          e.report.hits.push({heal: healed}); log(result, `Зелье: +${healed} жизненных сил. Действие героя потрачено.`);
        } else if (action === 'switch') {
          const from = equippedWeapon(result.hero);
          equipment.change(result.hero, 'mainHand', targetId);
          e.report.switch = {from, to: targetId};
          log(result, `Оружие сменено: ${content.items[targetId].name}. Действие героя потрачено.`);
        } else strike(result.hero, e.enemies.find(enemy => enemy.id === targetId), 'hero', targetId);
      } else strike(actor.stats, result.hero, actor.id, 'hero');
      if (result.hero.hp === 0) return defeat(result);
      if (e.enemies.every(enemy => enemy.hp === 0)) return victory(result);
    }
    return result;
  }
  // Pilot parameters and historical animal profiles are kept separately in content.hunting.
  function huntingProfile(s) {
    const hunt = s.hunt;
    if (!hunt) return null;
    const row = content.hunting.rows[hunt.roll - 1], animal = content.hunting.animals[row.animal];
    return {row, animal, skill: s.hero.character?.skills?.includes('hunting') ? 1 : 0,
      aim: characters.baseFor(s.hero, content.equipment.base).aim ?? 2};
  }
  function huntingActions(s) {
    if (s.phase !== 'hunting' || s.hunt.stage === 'result') return [];
    const {animal} = huntingProfile(s), fighting = s.hunt.stage === 'combat';
    if (s.hunt.fled) return [{id:'leave', label:'Зверь убежал · вернуться', enabled:true}];
    const peaceful = equipment.stats(s.hero).peaceful;
    return [
      {id:'melee', label:'Атаковать мечом', enabled:!animal.rangedOnly && !peaceful, reason:animal.rangedOnly ? 'Только метательное оружие' : peaceful ? 'Слеза Сострадания запрещает агрессию' : ''},
      {id:'shoot', label:'Выстрелить из пращи', enabled:s.hero.sling === true && !peaceful, reason:!s.hero.sling ? 'Нужна праща из лавки · 2 монеты' : peaceful ? 'Слеза Сострадания запрещает агрессию' : ''},
      ...(!fighting && !s.hunt.hostile ? [{id:'leave', label:'Отказаться от столкновения', enabled:true}] : [{id:'flee', label:'Бежать · d6 + ловкость против d6 + ловкость зверя', enabled:true}]),
      ...(fighting || s.hunt.hostile ? [{id:'potion',label:'Выпить зелье · +5 ЖС, вместо атаки',enabled:s.hero.potions > 0 && s.hero.hp < s.hero.maxHp}, {id:'surrender',label:'Признать поражение',enabled:true}] : [])
    ];
  }
  function startHunt(s, die) {
    require(s.phase === 'ready' && s.position === 'U07', 'Охота доступна только у входа U07.');
    require(s.hero.food >= content.hunting.food, 'Для охоты нужна 1 порция еды.');
    const result = copy(s), roll = draw(die, 20), row = content.hunting.rows[roll - 1], animal = content.hunting.animals[row.animal];
    result.hero.food -= content.hunting.food;
    advanceTime(result, content.hunting.ticks);
    const behavior = roll === 9 || roll === 18 ? draw(die) : null;
    result.phase = 'hunting'; result.selection = null; result.feedback = null;
    result.hunt = {roll, behavior, stage:'choice', startedAtTick:s.ticks,
      hostile: !equipment.stats(result.hero).peaceful && animal.damageCount > 0 && (roll !== 18 || behavior >= 5),
      fled: roll === 9 && behavior === 6, hp:Array(row.count).fill(animal.hp),
      round:0, rolls:[{label:'Встреча d20',sides:20,value:roll}, ...(behavior ? [{label:'Поведение d6',sides:6,value:behavior}] : [])], loot:{}, result:null};
    log(result, `Окрестности Товилиса: d20 = ${roll}, ${animal.name} × ${row.count}${behavior ? `; поведение d6 = ${behavior}` : ''}.`);
    return result;
  }
  function finishHunt(s, kind) {
    const h = s.hunt, {animal} = huntingProfile(s);
    const kills = h.hp.filter(hp => hp === 0).length;
    h.stage = 'result'; h.result = kind;
    // Loot is awarded only at this transition; result cannot be resolved again.
    if (kind !== 'defeat' && kills) {
      if (animal.meat) h.loot.gameMeat = animal.meat * kills;
      for (const id of animal.trophies) h.loot[id] = kills;
      s.hero.huntingBag = s.hero.huntingBag || {};
      for (const [id, count] of Object.entries(h.loot)) s.hero.huntingBag[id] = (s.hero.huntingBag[id] || 0) + count;
      s.hero.experience += kills;
    }
    if (kind === 'defeat') {
      const lost = Math.ceil(s.hero.coins / 2); s.hero.coins -= lost;
      s.hero.hp = Math.min(8, s.hero.maxHp);
      log(s, `Поражение на охоте: потеряно ${lost} монет, добыча оставлена; восстановлено до 8 ЖС.`);
    }
    const label = {victory:'победа', 'animal-fled':'звери убежали', declined:'отказ от столкновения', escaped:'успешное бегство', defeat:'поражение'}[kind];
    log(s, `Охота завершена: ${label}; добыто зверей: ${kills}. Возвращение на U07.`);
    return s;
  }
  function huntAction(s, action, die, target = 0) {
    require(s.phase === 'hunting' && s.hunt && s.hunt.stage !== 'result', 'Охота уже завершена.');
    const choice = huntingActions(s).find(a => a.id === action);
    require(choice?.enabled, choice?.reason || 'Действие охоты недоступно.');
    const result = copy(s), hunt = result.hunt, {animal, skill, aim} = huntingProfile(result);
    if (action === 'leave') return finishHunt(result, hunt.fled ? 'animal-fled' : 'declined');
    if (action === 'surrender') return finishHunt(result, 'defeat');
    if (['melee','shoot'].includes(action)) require(integer(target, 0, hunt.hp.length - 1) && hunt.hp[target] > 0, 'Выберите живого зверя.');
    const first = hunt.stage === 'choice'; hunt.stage = 'combat'; hunt.round++;
    const roll = (label, sides = 6) => { const value = draw(die, sides); hunt.rolls.push({label, sides, value}); return value; };
    // Keep a bounded saved roll history; no roll is drawn again on reload.
    const enemyAttack = index => {
      let damage = animal.damageBonus;
      for (let i = 0; i < animal.damageCount; i++) damage += roll(`Зверь ${index + 1}: атака`);
      const absorbed = result.hero.defense ? roll('Защита героя', result.hero.defense) : 0;
      const dealt = Math.max(0, damage - absorbed);
      result.hero.hp = Math.max(0, result.hero.hp - dealt);
      log(result, `${animal.name} ${index + 1}: ${damage} − ${absorbed} = ${dealt} урона.`);
    };
    const enemyTurn = () => {
      if (!animal.damageCount) return;
      for (let i = 0; i < hunt.hp.length; i++) if (hunt.hp[i] > 0) {
        enemyAttack(i); if (!result.hero.hp) break;
      }
    };
    if (action === 'flee') {
      const hero = roll('Бегство героя') + result.hero.agility, enemy = roll('Преследование зверя') + (animal.agility || 0);
      if (hero >= enemy) return finishHunt(result, 'escaped');
      enemyTurn();
    } else {
      // One ranged opening before a predator closes; later rounds use initiative.
      const heroFirst = action === 'shoot' && first || !animal.damageCount ||
        roll('Инициатива героя') + result.hero.agility >= roll('Инициатива зверя') + animal.agility;
      if (!heroFirst) enemyTurn();
      if (result.hero.hp > 0) {
        if (action === 'potion') { result.hero.potions--; result.hero.hp = Math.min(result.hero.maxHp, result.hero.hp + 5); }
        else {
          const damage = roll(action === 'shoot' ? 'Выстрел' : 'Удар мечом') + (action === 'shoot' ? aim : result.hero.attackBonus) + skill;
          const absorbed = animal.defense ? roll('Защита зверя', animal.defense) : 0;
          const dealt = Math.max(0, damage - absorbed); hunt.hp[target] = Math.max(0, hunt.hp[target] - dealt);
          log(result, `${action === 'shoot' ? 'Выстрел' : 'Удар'}: ${damage} − ${absorbed} = ${dealt} урона.`);
        }
        if (heroFirst) enemyTurn();
      }
      if (result.hero.hp > 0 && animal.rangedOnly) return finishHunt(result, hunt.hp.every(hp => !hp) ? 'victory' : 'animal-fled');
    }
    hunt.rolls = hunt.rolls.slice(-200);
    if (result.hero.hp === 0) return finishHunt(result, 'defeat');
    if (hunt.hp.every(hp => hp === 0)) return finishHunt(result, 'victory');
    return result;
  }
  function validateHunt(s) {
    const bag = s.hero.huntingBag;
    require(bag === undefined || bag && typeof bag === 'object' && !Array.isArray(bag) && Object.entries(bag).every(([id,n]) => Object.hasOwn(content.hunting.items,id) && integer(n,0)), 'Повреждена охотничья добыча.');
    require(s.hero.sling === undefined || typeof s.hero.sling === 'boolean', 'Повреждена праща.');
    if (s.phase !== 'hunting') { require(s.hunt == null, 'Незавершённая охота.'); return; }
    const h = s.hunt;
    require(h && integer(h.roll,1,20), 'Повреждён исход охоты.');
    const {row,animal} = huntingProfile(s);
    require(s.position === 'U07' && integer(h.startedAtTick,0) && s.ticks === h.startedAtTick + content.hunting.ticks && ['choice','combat','result'].includes(h.stage), 'Повреждено место или время охоты.');
    require((h.roll === 9 || h.roll === 18) ? integer(h.behavior,1,6) : h.behavior === null, 'Повреждено поведение зверя.');
    const expectedHostile = !equipment.stats(s.hero).peaceful && animal.damageCount > 0 && (h.roll !== 18 || h.behavior >= 5);
    require(h.hostile === expectedHostile && h.fled === (h.roll === 9 && h.behavior === 6) && integer(h.round,0) && Array.isArray(h.hp) && h.hp.length === row.count && h.hp.every(hp => integer(hp,0,animal.hp)), 'Повреждены звери.');
    require(Array.isArray(h.rolls) && h.rolls.length <= 260 && h.rolls.every(r => r && typeof r.label === 'string' && integer(r.sides,1,20) && integer(r.value,1,r.sides)), 'Повреждены броски охоты.');
    const kills = h.hp.filter(hp => hp === 0).length, expected = {};
    if (h.stage === 'result' && h.result !== 'defeat' && kills) { if (animal.meat) expected.gameMeat = animal.meat * kills; for (const id of animal.trophies) expected[id] = kills; }
    require(h.loot && typeof h.loot === 'object' && !Array.isArray(h.loot) && Object.keys(h.loot).length === Object.keys(expected).length && Object.entries(h.loot).every(([id,count]) => Object.hasOwn(expected,id) && count === expected[id]) && (h.stage === 'result' ? ['victory','animal-fled','declined','escaped','defeat'].includes(h.result) : h.result === null), 'Повреждён результат охоты.');
    if (h.stage === 'choice') require(h.round === 0 && h.hp.every(hp => hp === animal.hp), 'Повреждено начало охоты.');
    if (h.result === 'victory') require(kills === row.count, 'Не все звери повержены.');
  }

  // City keys are stable domain identifiers, independent of map asset revisions.
  function bankStatus(s, city = 'tovilis') {
    return s.bank?.[city] || {balance: 0, history: []};
  }
  function bankTransfer(s, action, amount) {
    require(s.phase === 'ready' && s.position === buildings.get('west-house').cell, 'Операции доступны только при посещении банка между событиями и боями.');
    require(['deposit', 'withdraw'].includes(action), 'Неизвестная банковская операция.');
    require(integer(amount, 1), 'Введите положительное целое число монет.');
    const account = bankStatus(s), deposit = action === 'deposit';
    require(amount <= (deposit ? s.hero.coins : account.balance), 'Недостаточно монет для операции.');
    const cash = s.hero.coins + (deposit ? -amount : amount), balance = account.balance + (deposit ? amount : -amount);
    require(integer(cash, 0) && integer(balance, 0), 'Слишком большая сумма.');
    const result = copy(s);
    result.hero.coins = cash;
    result.bank ||= {};
    result.bank.tovilis = {balance, history: [...account.history, {action, amount, cash, balance, turn: s.turn, ticks: s.ticks}]};
    log(result, `Банк Товилиса: ${deposit ? 'внесено' : 'снято'} ${amount} монет. Наличные: ${cash}, счёт: ${balance}.`);
    return result;
  }
  function services(s, buildingId = at(s.position)[0]?.id) {
    const b = buildings.get(buildingId);
    if (s.phase !== 'ready' || !b || b.cell !== s.position) return [];
    const night = clock(s.ticks).night, h = s.hero, options = [];
    function offer(id, label, {cost = 0, payout = 0, ticks = 0, day = false, condition = true, reason = '', interest = false} = {}) {
      const blocked = day && night ? 'Откроется утром' : h.coins < cost ? `Нужно ${cost} монеты` : !condition ? reason : '';
      const meals = Math.floor((s.ticks + ticks) / 6) - Math.floor(s.ticks / 6);
      const foodNeeded = meals + (id === 'hunt' ? content.hunting.food : 0);
      options.push({id, label, cost, payout, ticks, interest, foodCost: Math.min(h.food, foodNeeded), hungerCost: Math.min(h.hp - 1, Math.max(0, foodNeeded - h.food)), enabled: !blocked, reason: blocked});
    }
    if (buildingId === 'city-entry') offer('hunt', 'Охотиться · Окрестности Товилиса', {ticks:content.hunting.ticks, condition:h.food >= 1, reason:'Нужна 1 порция еды'});
    if ((buildingId === 'city-entry' || isTavern(buildingId)) && h.huntingBag?.gameMeat > 0) offer('cook-meat', 'Приготовить 1 мясо → 1 порция еды');
    const shifts = workStatus(s);
    const jobOffer = (id, label) => offer(id, label, {day: true, ticks: content.work.shiftTicks, condition: shifts.remaining > 0, reason: 'На сегодня работа закончена. Новые смены — завтра.'});
    if (buildingId === 'orders') {
      if (s.quest === 'none') offer('quest', 'Взять поручение «Сеть для порта»');
    }
    if (buildingId === 'mill') {
      offer('family', 'Поговорить с дочерьми мельника', {day: true});
      if (!s.millJob) offer('hire', 'Устроиться помощником мельника', {day: true});
      else jobOffer('work-mill', 'Помочь мельнику · 1–3 монеты');
    }
    if (buildingId === 'port') {
      jobOffer('work-port', 'Помочь грузчикам · 1–3 монеты');
      if (s.quest === 'active') offer('deliver', 'Сдать сеть · +10 монет', {condition: h.net, reason: 'Сначала купите сеть в лавке'});
    }
    if (buildingId === 'shop') {
      if (s.quest !== 'complete') offer('net', h.net ? 'Сеть уже в сумке' : 'Купить сеть', {cost: 5, day: true, condition: !h.net, reason: 'Предмет уже куплен'});
      offer('potion', 'Купить зелье · +5 сил', {cost: 4, day: true, condition: h.potions < 3, reason: 'Сумка вмещает 3 зелья'});
      offer('sell-potion', 'Продать зелье', {payout: 2, day: true, condition: h.potions > 0, reason: 'Нет зелья для продажи'});

    }
    if (buildingId === 'far-shop') {
      offer('potion', 'Лечебный настой травника · +5 сил', {cost: 3, day: true, condition: h.potions < 3, reason: 'Сумка вмещает 3 зелья'});
      offer('sell-potion', 'Продать зелье травнику', {payout: 1, day: true, condition: h.potions > 0, reason: 'Нет зелья для продажи'});
    }
    if (['shop','far-shop'].includes(buildingId)) {
      offer('sling', 'Купить охотничью пращу', {cost:2, day:true, condition:!h.sling, reason:'Праща уже в сумке'});
      for (const [id,count] of Object.entries(h.huntingBag || {})) if (count && content.hunting.items[id].value > 0) offer(`sell-${id}`, `Продать: ${content.hunting.items[id].name}`, {payout:content.hunting.items[id].value, day:true});
      const day = clock(s.ticks).day, ledger = s.shopInterest[buildingId];
      const sell = (id, owned, payout, interest = false) => {
        const refused = interest && ledger?.day === day && ledger.items[id] >= 4;
        offer(`sell-${id}`, `Продать: ${(content.items[id] || content.finds[id]).name}`, {
          payout, day: true, interest, condition: owned && !refused,
          reason: refused ? 'Сегодня торговцу вещь не нужна. Спросите завтра.' : 'Нет вещи для продажи'
        });
      };
      sell('sword', h.sword, content.trade.neutralPrices.sword / 2, true);
      sell('shield', h.shield, content.trade.neutralPrices.shield / 2, true);
      for (const [id, count] of Object.entries(h.finds)) if (count && content.finds[id].value > 0)
        sell(id, true, content.finds[id].value, id === 'defenseRing');
    }
    if (buildingId === 'forge') {
      offer('sword', h.sword ? 'Меч уже улучшен' : 'Меч · +1 к атаке', {cost: 8, day: true, condition: !h.sword, reason: 'Бонус уже получен'});
      offer('shield', h.shield ? 'Щит уже куплен' : 'Малый щит · +1 к защите', {cost: 6, day: true, condition: !h.shield, reason: 'Бонус уже получен'});
      jobOffer('work-forge', 'Помочь кузнецу · 1–3 монеты');
    }
    if (isTavern(buildingId)) {
      const inn = content.taverns[buildingId];
      offer('food', `Купить набор · ${inn.foodPortions} порции еды`, {cost: 1});
      offer('ale', `Выпить кружку эля · до +${inn.aleHeal} ЖС`, {cost: inn.aleCost, ticks: 1});
      offer('find-dice', 'Найти компанию для игры в кости', {ticks: 1});
      offer('rest', `${inn.roomName} · ${inn.roomHeal >= h.maxHp ? 'все силы' : `до +${inn.roomHeal} ЖС`}`, {cost: inn.roomCost, ticks: inn.roomTicks, condition: h.hp < h.maxHp, reason: 'Жизненные силы полные'});
      offer('morning', 'Дождаться утра', {ticks: 18 - s.ticks % 18, condition: s.ticks % 18 !== 0, reason: 'Уже утро'});
    }
    if (night && ['mill', 'port', 'shop', 'far-shop', 'forge'].includes(buildingId)) {
      offer('wait-opening', buildingId === 'port' || buildingId === 'mill' ? 'Дождаться начала работы' : 'Дождаться открытия', {ticks: 18 - s.ticks % 18});
    }
    if (!night && shifts.remaining === 0 && ['mill', 'port', 'forge'].includes(buildingId)) {
      offer('wait-work', 'Переждать до завтрашних смен', {ticks: 18 - s.ticks % 18});
    }
    return options;
  }
  function isTavern(id) { return content.places[id]?.kind === 'tavern'; }
  function tavernProfile(s) { return content.taverns[at(s.position).find(b => isTavern(b.id))?.id] || null; }
  function inventory(s) { return equipment.inventory(s.hero); }
  function workStatus(s) {
    const day = clock(s.ticks).day, used = s.workLedger.day === day ? s.workLedger.count : 0;
    return {day, used, remaining: content.work.dailyLimit - used};
  }
  function service(s, action, die, quantity = 1) {
    const offer = services(s).find(o => o.id === action);
    require(offer && offer.enabled, offer?.reason || 'Действие недоступно в этом месте.');
    const inn = tavernProfile(s), portions = action === 'food' ? quantity * inn.foodPortions : 0;
    require(action === 'food' ? integer(quantity, 1) && integer(s.hero.food + portions, 0) : quantity === 1, 'Укажите целое число наборов.');
    const cost = offer.cost * (action === 'food' ? quantity : 1);
    require(integer(cost, 0) && s.hero.coins >= cost, 'Не хватает монет на выбранное количество.');
    if (action === 'hunt') return startHunt(s, die);
    if (action === 'find-dice') return findDice(s, die);
    const result = copy(s), h = result.hero;
    result.lastTrade = null;
    if (offer.interest) {
      const place = at(s.position).find(b => ['shop','far-shop'].includes(b.id)).id, day = clock(s.ticks).day, item = action.slice(5);
      const ledger = result.shopInterest[place]?.day === day ? result.shopInterest[place] : {day, items: {}};
      const value = ledger.items[item] || draw(die);
      ledger.items[item] = value; result.shopInterest[place] = ledger;
      result.lastTrade = {place, item, day, roll: value, accepted: value <= 3, payout: value <= 3 ? offer.payout : 0};
      if (value >= 4) {
        result.feedback = 'Торговцу сегодня не нужна эта вещь. Она остаётся у вас; спросить снова можно завтра.';
        log(result, result.feedback); return result;
      }
    }
    h.coins += offer.payout - cost;
    let text = '';
    if (action === 'sling') { h.sling = true; text = 'Куплена охотничья праща за 2 монеты.'; }
    else if (action === 'cook-meat') { h.huntingBag.gameMeat--; h.food++; text = 'Приготовлено мясо: +1 порция еды.'; }
    else if (action.startsWith('sell-') && Object.hasOwn(content.hunting.items, action.slice(5))) { const id = action.slice(5); h.huntingBag[id]--; text = `${content.hunting.items[id].name}: продано 1 за ${offer.payout} монет.`; }
    else if (action === 'quest') { result.quest = 'active'; text = 'Заказ принят: купить сеть за 5 монет и доставить в порт. Награда — 10 монет.'; }
    else if (action === 'hire') { result.millJob = true; text = 'Мельник нанял гнома помощником. Можно работать дневные смены за 1–3 монеты.'; }
    else if (action === 'family') { result.familyMet = true; text = 'Дочери мельника рассказали о работе, лавке и порте.'; }
    else if (action.startsWith('work-')) {
      result.phase = 'work'; result.feedback = null;
      result.job = {place: action.slice(5), startedAtTick: s.ticks, day: clock(s.ticks).day, ticks: offer.ticks, roll: null, pay: null, foodUsed: null, hungerDamage: null};
      return result;
    }
    else if (action === 'net') { h.net = true; text = 'Куплена сеть за 5 монет. Предмет заказа сохранится при поражении.'; }
    else if (action === 'potion') { h.potions += 1; text = `Куплено зелье за ${offer.cost} монеты.`; }
    else if (action === 'sell-potion') { h.potions -= 1; text = `Зелье продано за ${offer.payout} ${offer.payout === 1 ? 'монету' : 'монеты'}.`; }
    else if (action === 'sell-sword') { h.sword = false; if (h.equipment.mainHand === 'sword') h.equipment.mainHand = 'shortSword'; equipment.refresh(h); text = `Стальной меч продан за ${offer.payout} монеты. Снова используется дорожный меч.`; }
    else if (action === 'sell-shield') { h.shield = false; h.equipment.offHand = null; equipment.refresh(h); text = `Малый щит продан за ${offer.payout} монеты.`; }
    else if (action.startsWith('sell-')) {
      const id = action.slice(5); h.finds[id] -= 1;
      if (id === 'defenseRing' && h.finds[id] === 0 && h.equipment.ring === id) { h.equipment.ring = null; equipment.refresh(h); }
      text = `${content.finds[id].name}: продано за ${offer.payout} монет.`;
    }
    else if (action === 'sword') { h.sword = true; equipment.change(h, 'mainHand', 'sword'); text = `Куплен стальной меч: атака теперь d${content.items.sword.damage.sides} + ${h.attackBonus}. Дорожный меч остаётся в сумке.`; }
    else if (action === 'shield') { h.shield = true; equipment.change(h, 'offHand', 'shield'); text = `Куплен малый щит: защита теперь ${h.defense}.`; }
    else if (action === 'food') { h.food += portions; text = `Куплено наборов: ${quantity}, порций: ${portions}. Потрачено монет: ${cost}. Покупка не расходует время.`; }
    else if (action === 'ale') text = `Гном выпил кружку эля. Потрачено монет: ${offer.cost}. Прошёл 1 ход времени.`;
    else if (action === 'rest') text = `${inn.roomName}. Потрачено монет: ${offer.cost}. Прошло ${offer.ticks} хода времени.`;
    else if (action === 'morning') text = 'Гном переждал в таверне до следующего утра.';
    else if (action === 'wait-opening') text = 'Гном дождался утра у входа. Можно воспользоваться дневными услугами.';
    else if (action === 'wait-work') text = 'Наступило новое утро. Доступны две новые смены.';
    else if (action === 'deliver') { h.net = false; h.coins += 10; result.quest = 'complete'; result.phase = 'won'; result.selection = null; text = 'Сеть доставлена в порт. Получено 10 монет. Заказ выполнен!'; }
    advanceTime(result, offer.ticks);
    if (action === 'rest' || action === 'ale') {
      const healed = Math.min(h.maxHp - h.hp, action === 'rest' ? inn.roomHeal : inn.aleHeal);
      h.hp += healed; text += ` Восстановлено сил: ${healed}.`;
    }
    result.feedback = text; log(result, text);
    return result;
  }
  function findDice(s, die) {
    require(s.phase === 'ready' && at(s.position).some(b => isTavern(b.id)), 'Играть можно в таверне.');
    const result = copy(s), before = {...s.hero}, roll = draw(die);
    const place = at(s.position).find(b => isTavern(b.id)).id;
    advanceTime(result, 1);
    result.phase = 'tavern-game'; result.feedback = null;
    result.tavernGame = {place, searchTick: s.ticks, stage: roll >= 4 ? 'found' : 'empty', searchRoll: roll, heroRoll: null, visitorRoll: null, stake: null, delta: 0, foodUsed: before.food - result.hero.food, hungerDamage: before.hp - result.hero.hp};
    log(result, `Поиск компании в кости: кубик ${roll}. ${roll >= 4 ? 'Нашёлся желающий сыграть.' : 'Пока никто не хочет играть.'} Прошёл 1 ход времени.`);
    return result;
  }
  function playDice(s, die, stake = 1) {
    require(s.phase === 'tavern-game' && s.tavernGame?.stage === 'found', 'Сначала найдите партнёра по игре.');
    const limit = content.taverns[s.tavernGame.place].maxStake;
    require(integer(stake, 1, limit), `Ставка должна быть целым числом от 1 до ${limit}.`);
    require(s.hero.coins >= stake, 'Не хватает монет на выбранную ставку.');
    const result = copy(s), game = result.tavernGame, before = {...s.hero};
    game.stake = stake;
    game.heroRoll = draw(die); game.visitorRoll = draw(die); game.delta = stake * Math.sign(game.heroRoll - game.visitorRoll);
    result.hero.coins += game.delta; advanceTime(result, 1); game.stage = 'result';
    game.foodUsed += before.food - result.hero.food; game.hungerDamage += before.hp - result.hero.hp;
    log(result, `Кости: ставка ${stake}, гном ${game.heroRoll}, посетитель ${game.visitorRoll}. ${game.delta ? `Монеты: ${game.delta > 0 ? '+' : ''}${game.delta}.` : 'Ничья: ставка возвращена.'} Прошёл 1 ход времени.`);
    return result;
  }
  function finishWork(s, die) {
    require(s.phase === 'work' && s.job, 'Сначала возьмите смену.');
    const result = copy(s), j = result.job, before = {...result.hero};
    j.roll = draw(die); j.pay = Math.ceil(j.roll / 2); result.hero.coins += j.pay;
    result.workLedger = {day: j.day, count: workStatus(s).used + 1};
    advanceTime(result, j.ticks);
    j.foodUsed = before.food - result.hero.food; j.hungerDamage = before.hp - result.hero.hp;
    result.phase = 'work-result';
    result.feedback = `Смена окончена. Кубик ${j.roll}: +${j.pay} монеты, прошло ${j.ticks} хода времени.${j.foodUsed ? ` Еда: −${j.foodUsed} порция.` : ''}${j.hungerDamage ? ` Голод: −${j.hungerDamage} ЖС.` : ''}`;
    log(result, result.feedback); return result;
  }
  function cancelWork(s) {
    require(s.phase === 'work', 'Смена уже завершена.');
    const result = copy(s); result.phase = 'ready'; result.job = null; return result;
  }
  function drink(s) {
    require(s.phase === 'ready' && s.hero.potions > 0 && s.hero.hp < s.hero.maxHp, 'Зелье сейчас недоступно.');
    const result = copy(s), healed = Math.min(5, s.hero.maxHp - s.hero.hp);
    result.hero.potions -= 1; result.hero.hp += healed;
    result.feedback = `Зелье: +${healed} жизненных сил.`; log(result, result.feedback); return result;
  }
  function rename(s, name) {
    const clean = name.trim().slice(0, 24); require(clean.length > 0, 'Введите имя героя.');
    const result = copy(s); result.hero.name = clean; return result;
  }
  function validateMove(m) {
    require(m && Array.isArray(m.path), 'Повреждён путь.');
    if (m.stopBuilding === 'far-shop' && m.path.at(-1) === 'J03' && m.reason === 'building') {
      const oldApproach = plan(m.path[0], m.path[1], m.roll, null);
      if (oldApproach.path.at(-1) === 'J03' && JSON.stringify(m.path) === JSON.stringify(oldApproach.path) && m.unused === oldApproach.unused) return;
    }
    const expected = plan(m.path[0], m.path[1], m.roll, m.stopBuilding, m.movementPenalty || 0);
    require(JSON.stringify(m.path) === JSON.stringify(expected.path) && m.reason === expected.reason && m.unused === expected.unused, 'Повреждён путь броска.');
  }
  function validate(s) {
    require(s && s.version === VERSION && s.mapId === map.id && s.mapRevision === map.revision, 'Сохранение относится к другой версии игры.');
    require(['ready', 'moving', 'notice', 'encounter', 'combat', 'outcome', 'work', 'work-result', 'tavern-game', 'won', 'hunting'].includes(s.phase) && cells.has(s.position), 'Повреждено положение героя.');
    require(s.bank === undefined || s.bank && typeof s.bank === 'object' && !Array.isArray(s.bank), 'Повреждены банковские счета.');
    for (const account of Object.values(s.bank || {})) {
      require(account && integer(account.balance, 0) && Array.isArray(account.history), 'Повреждён банковский счёт.');
      let previous = 0;
      for (const entry of account.history) {
        require(entry && ['deposit', 'withdraw'].includes(entry.action) && integer(entry.amount, 1) && integer(entry.cash, 0) && integer(entry.balance, 0) && integer(entry.turn, 0, s.turn) && integer(entry.ticks, 0, s.ticks), 'Повреждена история банка.');
        require(entry.balance === previous + (entry.action === 'deposit' ? entry.amount : -entry.amount), 'Нарушен баланс банка.');
        previous = entry.balance;
      }
      require(account.balance === previous, 'Нарушен итог банка.');
    }
    require(s.previous === null || neighbours.get(s.position).includes(s.previous), 'Повреждён предыдущий шаг.');
    require(['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'].includes(s.facing), 'Повреждено направление фигурки.');
    require(integer(s.turn, 0) && integer(s.ticks, s.turn), 'Повреждено время.');
    require(s.workLedger && integer(s.workLedger.day, 1, clock(s.ticks).day) && integer(s.workLedger.count, 0, content.work.dailyLimit), 'Повреждён учёт смен.');
    if (['work', 'work-result'].includes(s.phase)) {
      const j = s.job;
      const legacyWork = j?.legacyAtOrders === true && j.place === 'mill' && s.position === buildings.get('orders').cell;
      require(j && ['mill', 'port', 'forge'].includes(j.place) && (legacyWork || j.legacyAtOrders !== true && buildings.get(j.place).cell === s.position) && j.ticks === content.work.shiftTicks && integer(j.startedAtTick, 0) && j.day === clock(j.startedAtTick).day && !clock(j.startedAtTick).night, 'Повреждена смена.');
      require(j.place !== 'mill' || s.millJob, 'Гном не нанят на мельницу.');
      if (s.phase === 'work') require(s.ticks === j.startedAtTick && workStatus(s).remaining > 0 && [j.roll, j.pay, j.foodUsed, j.hungerDamage].every(v => v === null), 'Повреждено начало смены.');
      else require(s.ticks === j.startedAtTick + j.ticks && integer(j.roll, 1, 6) && j.pay === Math.ceil(j.roll / 2) && integer(j.foodUsed, 0, 1) && integer(j.hungerDamage, 0, 1) && j.foodUsed + j.hungerDamage <= 1 && s.workLedger.day === j.day && s.workLedger.count > 0, 'Повреждён результат смены.');
    } else require(s.job === null, 'Незавершённая смена.');
    if (s.phase === 'tavern-game') {
      const g = s.tavernGame;
      require(g && isTavern(g.place) && buildings.get(g.place).cell === s.position && integer(g.searchTick, 0) && integer(g.searchRoll, 1, 6) && ['found', 'empty', 'result'].includes(g.stage), 'Повреждена игра в кости.');
      require(integer(g.foodUsed, 0, 1) && integer(g.hungerDamage, 0, 1) && g.foodUsed + g.hungerDamage <= 1, 'Повреждены затраты игры.');
      if (g.stage === 'result') require(g.searchRoll >= 4 && s.ticks === g.searchTick + 2 && integer(g.heroRoll, 1, 6) && integer(g.visitorRoll, 1, 6) && integer(g.stake, 1, content.taverns[g.place].maxStake) && g.delta === g.stake * Math.sign(g.heroRoll - g.visitorRoll), 'Повреждён результат костей.');
      else require(s.ticks === g.searchTick + 1 && (g.stage === 'found') === (g.searchRoll >= 4) && g.heroRoll === null && g.visitorRoll === null && g.stake === null && g.delta === 0, 'Повреждён поиск компании.');
    } else require(s.tavernGame === null, 'Незавершённая игра в кости.');
    const h = s.hero;
    require(h && typeof h.name === 'string' && h.name.trim().length && h.name.length <= 24, 'Повреждено имя.');
    const identity = h.character?.legacy ? null : characters.profile({...h.character, name: h.name});
    require(h.character?.legacy === true || identity && identity.race === h.character.race && identity.class === h.character.class, 'Повреждена анкета героя.');
    const expectedBase = characters.baseFor(h, content.equipment.base);
    require(h.maxHp === expectedBase.maxHp && integer(h.hp, 1, h.maxHp) && integer(h.food, 0) && integer(h.coins, 0) && integer(h.potions, 0, 3), 'Повреждены ресурсы.');
    require(h.finds && typeof h.finds === 'object' && !Array.isArray(h.finds) && Object.entries(h.finds).every(([id, count]) => Object.hasOwn(content.finds, id) && integer(count, 0)) && integer(h.experience, 0) && Number.isSafeInteger(h.reputation) && integer(h.slowMoves, 0, 2) && Array.isArray(h.lore) && new Set(h.lore).size === h.lore.length && h.lore.every(id => id === 'alien-lake'), 'Повреждены находки или последствия извещений.');
    require(s.shopInterest && typeof s.shopInterest === 'object' && !Array.isArray(s.shopInterest) && Object.entries(s.shopInterest).every(([place, ledger]) => ['shop','far-shop'].includes(place) && integer(ledger.day, 1, clock(s.ticks).day) && ledger.items && typeof ledger.items === 'object' && !Array.isArray(ledger.items) && Object.entries(ledger.items).every(([id, value]) => ['sword','shield','defenseRing'].includes(id) && integer(value, 1, 6))), 'Повреждён интерес торговца.');
    if (s.lastTrade !== null) {
      const t = s.lastTrade;
      require(t && s.shopInterest[t.place]?.day === t.day && s.shopInterest[t.place].items[t.item] === t.roll && t.accepted === (t.roll <= 3) && t.payout === (t.accepted ? content.trade.neutralPrices[t.item] / 2 : 0), 'Повреждён результат продажи.');
    }
    if (s.notice !== null) {
      const n = s.notice, card = noticeCard(s);
      require(s.phase === 'notice' && s.pending?.noticeVersion === 3 && card && n.id === s.pending.noticeId && ['choice','result'].includes(n.stage) && Array.isArray(n.rolls) && n.rolls.length <= 2 && n.rolls.every(r => integer(r.sides, 1, 6) && integer(r.value, 1, r.sides) && typeof r.label === 'string') && integer(n.extraTicks, 0, 3) && integer(n.slowMoves, 0, 2), 'Повреждено извещение.');
      require(n.stage === 'choice' ? n.action === null && n.text === null && !n.rolls.length && n.extraTicks === 0 && n.slowMoves === 0 : card.actions.some(a => a[0] === n.action) && typeof n.text === 'string', 'Повреждён выбор извещения.');
    }
    require(!(s.phase === 'notice' && s.pending?.noticeVersion === 3) || s.notice !== null, 'Потеряно извещение.');
    require(typeof h.sword === 'boolean' && typeof h.shield === 'boolean' && typeof h.net === 'boolean', 'Повреждено владение снаряжением.');
    validateHunt(s);
    equipment.validate(h);
    require(s.world && s.world.uniqueArtifacts && typeof s.world.uniqueArtifacts === 'object' && !Array.isArray(s.world.uniqueArtifacts), 'Повреждены уникальные артефакты мира.');
    require(Object.entries(s.world.uniqueArtifacts).every(([id, owner]) => Object.hasOwn(content.artifacts, id) && content.artifacts[id].unique && owner === 'hero' && h.artifacts.includes(id)) && h.artifacts.every(id => !content.artifacts[id].unique || s.world.uniqueArtifacts[id] === 'hero'), 'Потерян или продублирован единственный экземпляр артефакта.');
    require(['none', 'active', 'complete'].includes(s.quest) && typeof s.millJob === 'boolean' && typeof s.familyMet === 'boolean', 'Повреждён заказ или работа.');
    require(s.phase !== 'won' || s.quest === 'complete', 'Повреждено завершение заказа.');
    require(s.quest !== 'complete' || !h.net, 'Сеть уже сдана.');
    require(s.feedback === null || typeof s.feedback === 'string', 'Повреждено сообщение.');
    require(Array.isArray(s.journal) && s.journal.length <= 80 && s.journal.every(item => integer(item.turn, 0) && typeof item.text === 'string'), 'Повреждён журнал.');
    if (s.lastMove !== null) validateMove(s.lastMove);
    if (['ready', 'won', 'work', 'work-result', 'tavern-game', 'hunting'].includes(s.phase)) {
      require(s.pending === null && s.landing === null && s.encounter === null && s.outcome === null, 'Незавершённое событие.');
      if (s.selection) {
        const selectedOption = directions(s.position).find(d => d.next === s.selection.next);
        const oldShopStop = s.selection.stopBuilding === 'far-shop' && selectedOption?.building?.id !== 'far-shop' && buildings.get('far-shop').cell !== 'J03';
        if (oldShopStop) require(selectedOption?.path.at(-1) === 'J03', 'Повреждена прежняя остановка у лавки.');
        choose({...s, phase: 'ready'}, s.selection.next, oldShopStop ? null : s.selection.stopBuilding);
      }
    } else {
      const m = s.pending;
      validateMove(m);
      require(m.id === s.turn + 1 && m.startedAtTick === s.ticks && m.event === (cells.get(m.path.at(-1)).event || null), 'Повреждён незавершённый ход.');
      require(m.event ? integer(m.eventRoll, 1, m.event === 'notice' && m.noticeVersion === 3 ? content.cityNotices.length : 6) : m.eventRoll === null, 'Повреждён бросок события.');
      if (m.event === 'notice') require(m.noticeVersion === undefined || m.noticeVersion === 2 || m.noticeVersion === 3 && m.noticeId === content.cityNotices[m.eventRoll - 1].id, 'Повреждена версия извещения.');
      require(m.movementPenalty === undefined || m.movementPenalty === Number(h.slowMoves > 0), 'Повреждён штраф движения.');
      if (m.event === 'encounter') {
        require(m.eventData && (m.eventRoll !== 5 || integer(m.eventData.countRoll, 1, 6)), 'Повреждена численность встречи.');
        const expected = makeEncounter(m.eventRoll, clock(m.startedAtTick).night, m.eventData.countRoll);
        require(JSON.stringify(expected) === JSON.stringify(m.eventData), 'Повреждены участники встречи.');
      } else require(m.eventData === null, 'Неожиданная встреча.');
      if (s.phase === 'moving') require(s.position === m.path[0] && s.landing === null && s.encounter === null && s.outcome === null, 'Повреждено начало хода.');
      else if (s.phase === 'notice') require(m.event === 'notice' && s.position === m.path.at(-1) && s.landing?.roll === m.eventRoll && s.encounter === null && s.outcome === null, 'Повреждено извещение.');
      else {
        const e = s.encounter, original = m.eventData;
        const validProtection = e?.protectedByArtifact === true && equipment.stats(h).peaceful && original?.enemies.length > 0 && e.hostile === false && e.provoked !== true;
        const validProvocation = e?.provoked === true && original?.kind === 'robber' && !original.night && !original.hostile && e.hostile === true;
        require(original && e && e.kind === original.kind && e.roll === original.roll && e.night === original.night && (e.hostile === original.hostile && e.provoked !== true && e.protectedByArtifact !== true || validProvocation || validProtection) && e.demand === original.demand && integer(e.round, 0), 'Повреждена встреча.');
        require(Array.isArray(e.enemies) && e.enemies.length === original.enemies.length, 'Повреждён состав противников.');
        e.enemies.forEach((enemy, i) => { const basis = original.enemies[i]; require(integer(enemy.hp, 0, basis.hp) && ['id', 'profile', 'name', 'attackBonus', 'defense', 'agility', 'reward', 'maxHp'].every(key => enemy[key] === basis[key]), 'Повреждён профиль противника.'); });
        require(e.report === null || (e.report && Array.isArray(e.report.hits) && Array.isArray(e.report.initiative)), 'Повреждён отчёт боя.');
        if (s.phase === 'outcome') require(s.outcome && typeof s.outcome.title === 'string' && typeof s.outcome.text === 'string', 'Повреждён итог встречи.');
        else require(s.position === m.path.at(-1) && s.outcome === null && (s.phase !== 'combat' || e.hostile && e.enemies.some(enemy => enemy.hp > 0)), 'Повреждено состояние боя.');
      }
    }
    return s;
  }
  function migrate(old) {
    if (old.version === VERSION) return validate(old);
    if (old.version === 8) {
      const next = {...copy(old), version: VERSION};
      next.hero = {...next.hero, character: {legacy: true, sex: 'male', race: 'dwarf', origin: 'dwarf', class: 'warrior'}};
      next.world = next.world || {uniqueArtifacts: {}};
      return migrate(next);
    }
    if (old.version === 7) {
      const next = {...copy(old), version: 8, world: {uniqueArtifacts: {}}};
      const h = next.hero;
      require(h.strength === 3 && h.agility === 3 && h.defense === 4 + Number(h.shield) + Number(h.finds?.defenseRing > 0) && h.attackBonus === 3 + Number((h.weapon || (h.sword ? 'sword' : 'shortSword')) === 'sword'), 'Повреждено прежнее снаряжение.');
      equipment.migrateHero(h);
      return migrate(next);
    }
    if (old.version === 6) {
      const next = {...copy(old), version: 7, shopInterest: {}, lastTrade: null, notice: null};
      next.hero = {...next.hero, finds: {}, experience: 0, reputation: 0, slowMoves: 0, lore: []};
      return migrate(next);
    }
    old = copy(old);
    if (integer(old.version, 1, 5) && old.mapId === map.id && old.mapRevision === 1 && map.revision === 2) {
      old.mapRevision = map.revision;
      if(old.selection?.stopBuilding==='mill') {
        const option=directions(old.position).find(o=>o.next===old.selection.next);
        old.selection.stopBuilding=option?.building?.id==='orders'?'orders':null;
      }
      for (const move of [old.pending, old.lastMove].filter(Boolean)) if (move.stopBuilding === 'mill') move.stopBuilding = 'orders';
      if (old.job?.place === 'mill' && old.position === buildings.get('orders').cell) old.job.legacyAtOrders = true;
    }
    if (old.version === 5) return migrate({...old, version: 6});
    if (old.version === 4) {
      const s = {...copy(old), version: 6};
      if (s.tavernGame) s.tavernGame.stake = s.tavernGame.stage === 'result' ? 1 : null;
      return migrate(s);
    }
    if (old.version === 3) return migrate({...copy(old), version: 6, tavernGame: null});
    if (old.version === 2) return migrate({...copy(old), version: 6, workLedger: {day: clock(old.ticks).day, count: 0}, job: null, tavernGame: null});
    require(old.version === 1 && old.mapId === map.id && old.mapRevision === map.revision && ['ready', 'moving', 'landing'].includes(old.phase), 'Неизвестная версия сохранения.');
    const s = {...copy(old), version: 6, workLedger: {day: clock(old.ticks).day, count: 0}, job: null, tavernGame: null, facing: old.previous && cells.has(old.previous) && cells.has(old.position) ? facing(old.previous, old.position) : 'north', quest: 'none', millJob: false, familyMet: false, encounter: null, outcome: null, feedback: 'Прежняя прогулка перенесена: теперь доступны встречи, бой и городской заказ.'};
    s.hero = {...s.hero, sword: false, shield: false, net: false};
    for (const m of [s.pending, s.lastMove].filter(Boolean)) {
      m.eventData = null;
      if (m.event === 'encounter') { m.eventRoll = 4; m.eventData = makeEncounter(4, clock(m.startedAtTick).night); }
    }
    if (s.phase === 'landing') {
      if (s.landing?.kind === 'notice') s.phase = 'notice';
      else { s.phase = 'encounter'; s.landing = null; s.encounter = copy(s.pending.eventData); }
    }
    return migrate(s);
  }
  return {huntingProfile, huntingActions, huntAction, bankStatus, bankTransfer, content, characters, create, createCharacter, clock, facing, directions, shortestPath, plan, choose, begin, arrive, acknowledge, noticeCard, noticeFind, noticeAction, encounterAction, battle, escapeThreshold, equippedWeapon, services, service, workStatus, finishWork, cancelWork, isTavern, tavernProfile, inventory, equipmentProfile, equip, grantArtifact, playDice, drink, rename, validate, migrate, at};
});
