'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = content => factory(content, require('./characters.js'));
  else root.createTovilisEquipment = content => factory(content, root.TOVILIS_CHARACTERS);
})(typeof window === 'undefined' ? globalThis : window, (content, characters) => {
  const slots = content.equipment.slots;
  const definition = id => Object.hasOwn(content.items, id) ? content.items[id] : Object.hasOwn(content.finds, id) ? content.finds[id] : Object.hasOwn(content.artifacts, id) ? content.artifacts[id] : null;
  const require = (ok, message) => { if (!ok) throw Error(message); };
  function owned(hero) {
    return {shortSword: 1, armor: 1, bronzeHelmet: 1, travelCloak: 1,
      sword: Number(hero.sword), shield: Number(hero.shield),
      ...hero.finds, ...Object.fromEntries(hero.artifacts.map(id => [id, 1]))};
  }
  function stats(hero) {
    const base = characters.baseFor(hero, content.equipment.base), result = {...base, attackBonus: base.strength, manaBonus: 0, peaceful: false, closedSocietyWard: false};
    const effects = Object.values(hero.equipment).filter(Boolean).map(id => definition(id).effects || {});
    for (const key of ['strength','agility','defense','maxHp']) result[key] += effects.reduce((sum, e) => sum + (e[key] || 0), 0);
    for (const key of ['strength','agility','defense']) result[key] = Math.max(0, Math.min(content.equipment.caps[key], result[key]));
    result.attackBonus = result.strength + effects.reduce((sum, e) => sum + (e.attack || 0), 0);
    result.manaBonus = effects.reduce((sum, e) => sum + (e.mana || 0), 0);
    result.peaceful = effects.some(e => e.peaceful === true);
    result.closedSocietyWard = effects.some(e => e.closedSocietyWard === true);
    return result;
  }
  function refresh(hero) {
    const values = stats(hero);
    for (const key of ['strength','agility','defense','attackBonus','maxHp']) hero[key] = values[key];
    hero.hp = Math.min(hero.hp, hero.maxHp);
    hero.weapon = hero.equipment.mainHand;
    return hero;
  }
  function migrateHero(hero) {
    hero.artifacts = Array.isArray(hero.artifacts) ? hero.artifacts : [];
    hero.equipment = {head: 'bronzeHelmet', body: 'armor', shoulders: 'travelCloak',
      mainHand: hero.weapon || (hero.sword ? 'sword' : 'shortSword'), offHand: hero.shield ? 'shield' : null,
      ring: hero.finds.defenseRing > 0 ? 'defenseRing' : null, neck: null};
    return refresh(hero);
  }
  function change(hero, slot, id) {
    require(Object.hasOwn(slots, slot), 'Неизвестный слот.');
    require(slot !== 'mainHand' || id !== null, 'Для городского боя нужно выбрать оружие.');
    const item = id === null ? null : definition(id);
    require(id === null || item && item.slot === slot, 'Вещь не подходит в этот слот.');
    require(id === null || owned(hero)[id] > 0, 'У героя нет этой вещи.');
    const restrictions = hero.character?.restrictions || [];
    require(!(item?.tags || []).includes('heavy') || !(restrictions.includes('no-heavy-weapon') || restrictions.includes('no-heavy-armor')), 'Этой расе запрещено тяжёлое снаряжение.');
    if (item) {
      // A requirement is checked without counting the item itself as its own prerequisite.
      const without = {...hero, equipment: {...hero.equipment, [slot]: null}};
      require(stats(without).strength >= (item.requiredStrength || 0), `Нужно силы: ${item.requiredStrength}.`);
    }
    hero.equipment[slot] = id;
    return refresh(hero);
  }
  function validate(hero) {
    require(hero.equipment && typeof hero.equipment === 'object' && !Array.isArray(hero.equipment) && Object.keys(hero.equipment).length === Object.keys(slots).length, 'Повреждены слоты снаряжения.');
    require(Array.isArray(hero.artifacts) && new Set(hero.artifacts).size === hero.artifacts.length && hero.artifacts.every(id => Object.hasOwn(content.artifacts, id)), 'Повреждены артефакты.');
    const counts = owned(hero), used = {};
    for (const [slot, id] of Object.entries(hero.equipment)) {
      require(Object.hasOwn(slots, slot), 'Неизвестный слот.');
      require(id === null || typeof id === 'string' && definition(id)?.slot === slot && counts[id] > (used[id] || 0), 'В слоте нет принадлежащей герою вещи.');
      require(id === null || !(definition(id).tags || []).includes('heavy') || !(hero.character?.restrictions || []).some(r => r === 'no-heavy-weapon' || r === 'no-heavy-armor'), 'Нарушено ограничение расы на тяжёлое снаряжение.');
      if (id !== null) used[id] = (used[id] || 0) + 1;
    }
    require(hero.equipment.mainHand !== null, 'Не выбрано оружие.');
    const expected = stats(hero);
    for (const id of Object.values(hero.equipment).filter(Boolean)) {
      const item = definition(id), slot = item.slot;
      require(stats({...hero, equipment: {...hero.equipment, [slot]: null}}).strength >= (item.requiredStrength || 0), 'Не выполнено требование силы предмета.');
    }
    require(hero.weapon === hero.equipment.mainHand && ['strength','agility','defense','attackBonus','maxHp'].every(key => hero[key] === expected[key]), 'Характеристики не совпадают со снаряжением.');
    return hero;
  }
  function profile(hero) {
    const counts = owned(hero);
    return {base: characters.baseFor(hero, content.equipment.base), stats: stats(hero), slots: Object.entries(slots).map(([id, label]) => ({id, label,
      item: hero.equipment[id] ? {id: hero.equipment[id], ...definition(hero.equipment[id])} : null,
      choices: Object.entries(counts).filter(([key, count]) => count > 0 && definition(key)?.slot === id).map(([key]) => ({id: key, ...definition(key)}))}))};
  }
  function inventory(hero) {
    const entry = (id, quantity, slot = null) => { const item = definition(id); return {id, ...item, quantity, slot, totalWeight: item.weight === null ? null : item.weight * quantity}; };
    const counts = owned(hero), equipped = [];
    for (const [slot, id] of Object.entries(hero.equipment)) if (id !== null) { equipped.push(entry(id, 1, slots[slot])); counts[id] -= 1; }
    const bag = Object.entries(counts).filter(([, count]) => count > 0).map(([id, count]) => entry(id, count));
    for (const [id, quantity] of [['food', hero.food], ['potion', hero.potions], ['net', Number(hero.net)]]) if (quantity > 0) bag.push(entry(id, quantity));
    const all = [...equipped, ...bag];
    return {equipped, bag, unknownWeight: all.some(item => item.weight === null), weight: all.reduce((sum, item) => sum + (item.totalWeight || 0), 0)};
  }
  return {definition, owned, stats, refresh, migrateHero, change, validate, profile, inventory};
});
