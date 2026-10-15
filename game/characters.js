'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TOVILIS_CHARACTERS = factory();
})(typeof window === 'undefined' ? globalThis : window, function createCharacters() {
  const classes = {
    warrior: {id: 'warrior', name: 'Воин', strong: 'strength', weak: 'intelligence', health: 3,
      base: {strength: 3, agility: 3, defense: 3, intelligence: 1, aim: 2}},
    mage: {id: 'mage', name: 'Маг', strong: 'intelligence', weak: 'strength', health: 3,
      base: {strength: 2, agility: 3, defense: 3, intelligence: 3, aim: 1}},
    thief: {id: 'thief', name: 'Вор', strong: 'agility', weak: 'strength', health: 3,
      base: {strength: 2, agility: 4, defense: 3, intelligence: 2, aim: 2}},
    scout: {id: 'scout', name: 'Разведчик', strong: 'aim', weak: 'intelligence', health: 3,
      base: {strength: 2, agility: 3, defense: 3, intelligence: 2, aim: 3}}
  };
  const races = {
    human: {id: 'human', name: 'Человек', hpPerHealth: 2, mods: {}, origins: ['north', 'tovilis', 'taranaris', 'crimsonDragon', 'abir', 'sevenMines']},
    dwarf: {id: 'dwarf', name: 'Гном', hpPerHealth: 3, mods: {strength: 2, aim: -1}, originHp: 1, origins: ['dwarf']},
    elf: {id: 'elf', name: 'Эльф', hpPerHealth: 1, mods: {}, origins: ['highElf', 'forestElf']}
  };
  // Origin modifiers are copied from «Начальные данные». Sex is cosmetic and has no rule modifier.
  const origins = {
    north: {id: 'north', name: 'Северянин', race: 'human', mods: {strength: 2, hpBonus: 2, intelligence: -1}, skills: ['weapon-mastery', 'shaman']},
    dwarf: {id: 'dwarf', name: 'Гном', race: 'dwarf', skills: ['smith', 'miner'], restrictions: ['no-riding']},
    highElf: {id: 'highElf', name: 'Высокий эльф', race: 'elf', mods: {intelligence: 1}, skills: ['magic', 'alchemy']},
    forestElf: {id: 'forestElf', name: 'Лесной эльф', race: 'elf', mods: {agility: 1, aim: 1}, skills: ['missile', 'fast-shooter', 'druid', 'camouflage'], restrictions: ['no-heavy-weapon', 'no-heavy-armor']},
    tovilis: {id: 'tovilis', name: 'Товилис', race: 'human', mods: {hpBonus: 1, agility: 1}, skills: ['theft', 'lockpick']},
    taranaris: {id: 'taranaris', name: 'Таранарис', race: 'human', mods: {intelligence: 1}, skills: ['cheating', 'wagon']},
    crimsonDragon: {id: 'crimsonDragon', name: 'Красный Дракон', race: 'human', mods: {agility: 1, aim: 1}, skills: ['sneak', 'camouflage']},
    abir: {id: 'abir', name: 'Абир', race: 'human', mods: {strength: 2, hpBonus: 1}, skills: ['horse', 'hunting']},
    sevenMines: {id: 'sevenMines', name: 'Земли Семи Шахт', race: 'human', mods: {strength: 1, hpBonus: 2}, skills: ['miner', 'mining-tool']}
  };
  const sexes = {male: 'Мужчина', female: 'Женщина'};
  const copy = value => JSON.parse(JSON.stringify(value));
  const require = (ok, message) => { if (!ok) throw Error(message); };
  function profile(input) {
    const p = {...input};
    require(typeof p.name === 'string' && p.name.trim().length > 0 && p.name.trim().length <= 24, 'Введите имя героя.');
    require(Object.hasOwn(sexes, p.sex), 'Выберите пол героя.');
    require(Object.hasOwn(classes, p.class), 'Выберите класс героя.');
    require(Object.hasOwn(origins, p.origin), 'Выберите происхождение героя.');
    const origin = origins[p.origin], raceId = p.race || origin.race;
    require(Object.hasOwn(races, raceId) && origin.race === raceId, 'Происхождение не подходит выбранной расе.');
    const race = races[raceId], klass = classes[p.class];
    const base = {...klass.base};
    for (const source of [race.mods || {}, origin.mods || {}]) for (const [key, value] of Object.entries(source)) {
      if (key !== 'hpBonus') base[key] = (base[key] || 0) + value;
    }
    const classHp = {warrior: 3, thief: 2, mage: 1, scout: 2}[p.class];
    const hpPerHealth = classHp + race.hpPerHealth;
    const maxHp = klass.health * hpPerHealth + (race.originHp || 0) + (origin.mods?.hpBonus || 0);
    return {name: p.name.trim(), sex: p.sex, race: raceId, origin: p.origin, class: p.class,
      base: {...base, maxHp}, hpPerHealth, skills: [...(origin.skills || [])], restrictions: [...(origin.restrictions || [])],
      labels: {sex: sexes[p.sex], race: race.name, origin: origin.name, class: klass.name},
      source: {race: 'rules/sources/starting-data.md', class: 'rules/sources/character-creation.md'}};
  }
  function baseFor(hero, legacyBase) {
    if (!hero?.character || hero.character.legacy) return {...legacyBase};
    return {...profile({...hero.character, name: hero.name}).base};
  }
  return {classes, races, origins, sexes, profile, baseFor, copy};
});
