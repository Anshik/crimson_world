'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const map = require('../assets/maps/geometry/tovilis-v9.json');
const rules = require('../game/rules.js')(map);
const reload = state => rules.validate(JSON.parse(JSON.stringify(state)));
const work = (s, action, die) => reload(rules.acknowledge(rules.finishWork(rules.service(s, action), die)));
function dice(...values) { return sides => { assert.ok(values.length, 'Unexpected roll'); const value = values.shift(); assert.ok(value <= sides); return value; }; }
function at(position, extra = {}) { return {...rules.create(), position, ...extra}; }
function meet(roll, {night = true, count = 1, hero = {}} = {}) {
  const s = at('Q04', {ticks: night ? 12 : 0}); s.hero = {...s.hero, ...hero};
  if(hero.sword){s.hero.equipment.mainHand=hero.weapon||'sword';s.hero.weapon=s.hero.equipment.mainHand;}
  if(hero.shield)s.hero.equipment.offHand='shield';
  return reload(rules.arrive(rules.begin(rules.choose(s, 'Q05'), dice(1, roll, count))));
}
function settle(s) {
  s = rules.arrive(s);
  if (s.phase === 'notice' && s.pending.noticeVersion === 3) s = rules.noticeAction(s, rules.noticeCard(s).actions[0][0], () => 6);
  if (s.phase === 'notice' || s.phase === 'outcome') s = rules.acknowledge(s);
  if (s.phase === 'encounter') s = rules.encounterAction(s, 'pass');
  return reload(s);
}
function travel(s, target) {
  for (let turns = 0; s.position !== target; turns++) {
    assert.ok(turns < 80, 'Unreachable target');
    const path = rules.shortestPath(s.position, target), option = rules.directions(s.position).find(d => d.next === path[1]);
    const building = map.buildings.find(b => b.cell === target);
    const stop = building && option.building?.id === building.id ? building.id : null;
    s = settle(rules.begin(rules.choose(s, path[1], stop), dice(6, 4)));
  }
  return s;
}
function waitOutsideUntilDay(s) {
  return rules.clock(s.ticks).night ? reload(rules.service(s, 'wait-opening')) : s;
}

test('d6 city table, count and time are saved before animation', () => {
  const expected = ['merchant', 'merchant', 'bard', 'soldier', 'bandits', 'robber'];
  for (let roll = 1; roll <= 6; roll++) for (const night of [false, true]) {
    const s = at('Q04', {ticks: night ? 12 : 11});
    const moving = reload(rules.begin(rules.choose(s, 'Q05'), dice(1, roll, 6)));
    assert.equal(moving.pending.eventData.kind, expected[roll - 1]);
    const arrived = reload(rules.arrive(moving));
    assert.equal(arrived.encounter.hostile, night && roll >= 5);
    if (roll === 5) assert.equal(arrived.encounter.enemies.length, 2);
    assert.equal(arrived.ticks, s.ticks);
  }
});

test('peaceful people and daytime bandits cannot be attacked', () => {
  for (const roll of [1, 3, 4, 5, 6]) {
    const s = meet(roll, {night: false});
    assert.throws(() => rules.battle(s, 'attack', () => {throw Error('rolled');}, 'enemy-1'), /нет боя/);
    assert.equal(rules.encounterAction(s, 'pass').phase, 'ready');
  }
});
test('daytime robber reveals fixed stats and can be challenged or passed',()=>{
  const daytime=meet(6,{night:false});
  assert.deepEqual(daytime.encounter.enemies.map(e=>[e.hp,e.attackBonus,e.defense,e.agility]),[[12,3,4,3]]);
  assert.equal(rules.encounterAction(daytime,'pass').phase,'ready');
  const challenged=reload(rules.encounterAction(daytime,'provoke'));
  assert.equal(challenged.phase,'combat');assert.equal(challenged.encounter.hostile,true);assert.equal(challenged.encounter.provoked,true);
  assert.equal(challenged.ticks,0);assert.throws(()=>rules.encounterAction(challenged,'provoke'));
  const escaped=reload(rules.battle(challenged,'flee',dice(6)));
  assert.equal(escaped.outcome.kind,'flee');assert.equal(rules.acknowledge(escaped).ticks,1);
  assert.throws(()=>rules.encounterAction(meet(5,{night:false}),'provoke'),/нельзя/);
});
test('switching between owned swords spends the hero action and gives enemies their turn',()=>{
  const s=meet(6,{hero:{coins:12,sword:true,attackBonus:4,shield:true,defense:5}});
  assert.equal(rules.equippedWeapon(s.hero),'sword');
  assert.throws(()=>rules.battle(s,'switch',dice(), 'sword'),/другого оружия/);
  const first=reload(rules.battle(s,'switch',dice(6,1,1,5),'shortSword'));
  assert.equal(first.phase,'combat');assert.equal(first.encounter.round,1);assert.equal(first.hero.weapon,'shortSword');assert.equal(first.hero.attackBonus,3);
  assert.equal(first.encounter.report.switch.to,'shortSword');
  assert.equal(first.encounter.report.hits.some(hit=>hit.attacker==='hero'),false);
  assert.equal(first.encounter.report.hits.some(hit=>hit.attacker==='enemy-1'),true);
  assert.equal(first.ticks,s.ticks);
  assert.equal(rules.inventory(first).bag.find(item=>item.id==='sword').quantity,1);
  const second=reload(rules.battle(first,'switch',dice(6,1,1,5),'sword'));
  assert.equal(second.encounter.round,2);assert.equal(second.hero.attackBonus,4);
  assert.throws(()=>rules.battle(meet(6),'switch',dice(),'sword'),/другого оружия/);
  const corrupt=JSON.parse(JSON.stringify(second));corrupt.hero.attackBonus=3;
  assert.throws(()=>rules.validate(corrupt),/снаряжение/);
});

test('merchant, bard and ransom apply once with no attack or extra reward', () => {
  const merchant = meet(1, {hero: {coins: 5}});
  const bought = reload(rules.encounterAction(merchant, 'buy'));
  assert.equal(bought.hero.coins, 2); assert.equal(bought.hero.potions, 2);
  assert.throws(() => rules.encounterAction(bought, 'buy'));
  assert.equal(rules.acknowledge(bought).ticks, 13);
  const healed = rules.encounterAction(meet(3, {hero: {coins: 4, hp: 2}}), 'heal');
  assert.equal(healed.hero.hp, 16); assert.equal(healed.hero.coins, 0);
  const paid = rules.encounterAction(meet(5, {count: 6, hero: {coins: 2}}), 'pay');
  assert.equal(paid.hero.coins, 0); assert.equal(paid.position, 'Q05');
  assert.equal(paid.encounter.round, 0); assert.equal(paid.outcome.kind, 'peace');
  assert.throws(() => rules.encounterAction(meet(6), 'pay'));
  assert.throws(() => rules.encounterAction(meet(1, {hero: {coins: 5, potions: 3}}), 'buy'));
});

test('initiative tie favours agility, then hero; killed enemy cannot retaliate', () => {
  const s = meet(5);
  const won = reload(rules.battle(s, 'attack', dice(6, 6, 6, 1), 'enemy-1'));
  assert.equal(won.phase, 'outcome'); assert.equal(won.outcome.kind, 'victory');
  assert.equal(won.hero.hp, 16); assert.equal(won.hero.coins, 3);
  assert.equal(won.encounter.report.hits.length, 1);
  assert.equal(won.encounter.report.initiative[0].id, 'hero');
  const robber = rules.battle(meet(6), 'attack', dice(3, 3, 1, 4, 1, 4), 'enemy-1');
  assert.equal(robber.encounter.report.initiative[0].id, 'hero');
  assert.equal(robber.hero.hp, 16); assert.equal(robber.encounter.enemies[0].hp, 12);
});

test('initiative is rolled each round, defenses use their own die, damage can be zero', () => {
  let s = meet(6);
  s = reload(rules.battle(s, 'attack', dice(1, 6, 1, 4, 1, 4), 'enemy-1'));
  assert.equal(s.encounter.report.initiative[0].id, 'enemy-1');
  assert.equal(s.encounter.report.hits[0].damage, 0);
  s = reload(rules.battle(s, 'attack', dice(6, 1, 1, 4, 1, 4), 'enemy-1'));
  assert.equal(s.encounter.round, 2); assert.equal(s.encounter.report.initiative[0].id, 'hero');
  assert.equal(s.ticks, 12);
});

test('two enemies attack separately and target selection is honoured', () => {
  const s = meet(5, {count: 6});
  const result = reload(rules.battle(s, 'attack', dice(6, 1, 1, 6, 1, 2, 4), 'enemy-2'));
  assert.equal(result.encounter.enemies[1].hp, 0); assert.equal(result.encounter.enemies[0].hp, 8);
  assert.equal(result.encounter.report.hits.length, 2);
  assert.throws(() => rules.battle(result, 'attack', () => 1, 'enemy-2'), /живого/);
  const win = reload(rules.battle(result, 'attack', dice(6, 1, 6, 1), 'enemy-1'));
  assert.equal(win.hero.coins, 5);
  assert.throws(() => rules.battle(win, 'attack', () => 1, 'enemy-1'));
  assert.equal(rules.acknowledge(win).ticks, 13);
});

test('potion takes hero action, enemies still attack, and consumption survives reload', () => {
  const s = meet(5, {hero: {hp: 6}});
  const healed = reload(rules.battle(s, 'potion', dice(6, 1, 6, 1)));
  assert.equal(healed.hero.potions, 0); assert.equal(healed.hero.hp, 5);
  assert.equal(healed.encounter.enemies[0].hp, 8);
  assert.throws(() => rules.battle(healed, 'potion', () => 1));
});

test('successful flee returns to previous cell without an event; failure gives only enemy attacks', () => {
  const s = meet(5, {count: 6});
  assert.equal(rules.escapeThreshold(s), 3);
  const fled = reload(rules.battle(s, 'flee', dice(3)));
  assert.equal(fled.position, 'Q04'); assert.equal(fled.outcome.kind, 'flee');
  assert.equal(rules.acknowledge(fled).ticks, 13);
  assert.equal(rules.acknowledge(fled).phase, 'ready');
  const failed = reload(rules.battle(s, 'flee', dice(1, 2, 4, 2, 4)));
  assert.equal(failed.phase, 'combat'); assert.equal(failed.encounter.report.hits.length, 2);
  assert.ok(failed.encounter.report.hits.every(h => h.attacker !== 'hero'));
  assert.equal(failed.ticks, 12);
});

test('death and surrender return to tavern, halve coins upward, preserve gear and quest net', () => {
  for (const mode of ['death', 'surrender']) {
    const s = meet(6, {hero: {hp: 1, coins: 5, sword: true, shield: true, attackBonus: 4, defense: 5, net: true}});
    s.quest = 'active';
    const result = reload(mode === 'death' ? rules.battle(s, 'attack', dice(1, 6, 6, 1), 'enemy-1') : rules.battle(s, 'surrender', () => {throw Error('No roll');}));
    assert.equal(result.position, 'T03'); assert.equal(result.hero.hp, 8); assert.equal(result.hero.coins, 2);
    assert.equal(result.hero.net, true); assert.equal(result.hero.sword, true); assert.equal(result.hero.potions, 1);
    assert.equal(result.quest, 'active'); assert.equal(result.outcome.kind, 'defeat');
  }
});

test('work requires correct place, employment, daytime and exactly one pay roll', () => {
  let s = at('A06');
  assert.throws(() => rules.service(s, 'work-mill', () => 6));
  s = reload(rules.service(s, 'hire')); assert.equal(s.ticks, 0);
  s = work(s, 'work-mill', dice(6)); assert.equal(s.hero.coins, 4); assert.equal(s.ticks, 3);
  const lastDay = {...s, ticks: 11};
  const lastShift = work(lastDay, 'work-mill', dice(1));
  assert.equal(lastShift.ticks, 14); assert.throws(() => rules.service(lastShift, 'work-mill', () => 6), /утром/);
  assert.throws(() => rules.service(at('J08'), 'hire'));
  const family = reload(rules.service(s, 'family')); assert.equal(family.familyMet, true); assert.equal(family.ticks, 3);
});

test('night closures are enforced by rules; tavern and port delivery stay open', () => {
  for (const [position, action] of [['S12', 'net'], ['J05', 'sword'], ['J05', 'work-forge'], ['P02', 'work-port'], ['A06', 'hire'], ['A06', 'family']]) {
    const s = at(position, {ticks: 12}); s.hero.coins = 30;
    assert.throws(() => rules.service(s, action, () => 6), /утром/);
  }
  const inn = at('T03', {ticks: 12}); inn.hero.coins = 2;
  assert.equal(rules.service(inn, 'food').hero.food, 7);
  const port = at('P02', {ticks: 12, quest: 'active'}); port.hero.net = true;
  assert.equal(rules.service(port, 'deliver').phase, 'won');
  assert.equal(rules.service(at('Q01', {ticks: 12}), 'quest').quest, 'active');
});

test('equipment does not stack; capacity, funds and net protection are enforced', () => {
  let s = at('J05'); s.hero.coins = 30;
  s = reload(rules.service(s, 'sword')); s = reload(rules.service(s, 'shield'));
  assert.equal(s.hero.attackBonus, 4); assert.equal(s.hero.defense, 5); assert.equal(s.hero.coins, 16);
  assert.throws(() => rules.service(s, 'sword')); assert.throws(() => rules.service(s, 'shield'));
  s.position = 'S12'; s = reload(rules.service(s, 'net'));
  assert.equal(s.hero.net, true); assert.throws(() => rules.service(s, 'net'));
  assert.throws(() => rules.service(at('S12'), 'net'), /Нужно/);
});

test('cheap bunk includes hunger before partial healing; waiting reaches next morning', () => {
  let s = at('T03', {ticks: 17}); s.hero = {...s.hero, hp: 2, food: 0, coins: 2};
  const rest = reload(rules.service(s, 'rest')); assert.equal(rest.ticks, 23); assert.equal(rest.hero.hp, 9);
  const wait = reload(rules.service(s, 'morning')); assert.equal(wait.ticks, 18); assert.equal(wait.hero.hp, 1); assert.equal(wait.hero.coins, 2);
  assert.throws(() => rules.service(at('T03'), 'morning'));
});

test('complete quest through real graph, employment, wages, shop and port; reward only once', () => {
  let s = travel(rules.create(), 'Q01');
  s = reload(rules.service(s, 'quest'));s=travel(s,'A06');s=waitOutsideUntilDay(s); s = reload(rules.service(s, 'hire')); s = reload(rules.service(s, 'family'));
  s = work(s, 'work-mill', dice(6));s=waitOutsideUntilDay(s);s = work(s, 'work-mill', dice(4));
  s = travel(s, 'S12'); s = waitOutsideUntilDay(s); s = reload(rules.service(s, 'net'));
  s = travel(s, 'P02'); const before = s.hero.coins;
  s = reload(rules.service(s, 'deliver'));
  assert.equal(s.phase, 'won'); assert.equal(s.hero.coins, before + 10); assert.equal(s.hero.net, false);
  assert.throws(() => rules.service(s, 'deliver')); assert.throws(() => rules.begin(s, () => 6));
  const journalLength = s.journal.length;
  s = reload(rules.acknowledge(s));
  assert.equal(s.phase, 'ready'); assert.equal(s.quest, 'complete'); assert.equal(s.hero.coins, before + 10);
  assert.equal(s.journal.length, journalLength);
  assert.throws(() => rules.service(s, 'deliver'));
  assert.equal(rules.begin(rules.choose(s, rules.directions(s.position)[0].next), dice(1, 4)).phase, 'moving');
  assert.equal(rules.services({...s, position: 'S12'}, 'shop').some(offer => offer.id === 'net'), false);
  assert.ok(s.turn > 0 && s.turn < 40); assert.equal(s.familyMet, true);
});

test('a saved combat round and outcome resume without new dice or rewards', () => {
  let s = meet(6);
  s = rules.battle(s, 'attack', dice(6, 1, 6, 1, 1, 4), 'enemy-1');
  const restored = reload(s); assert.deepEqual(restored, s);
  s = rules.battle(restored, 'attack', dice(6, 1, 6, 1), 'enemy-1');
  assert.equal(s.outcome.kind, 'victory'); assert.equal(s.hero.coins, 5);
  const done = rules.acknowledge(reload(s)); assert.strictEqual(rules.acknowledge(done), done);
  assert.equal(done.hero.coins, 5); assert.equal(done.ticks, 13);
});

test('old ready, moving and event saves migrate without resetting resources or movement', () => {
  const fresh = rules.create();
  function old(s) {
    s = JSON.parse(JSON.stringify(s)); s.version = 1;
    for (const k of ['facing', 'quest', 'millJob', 'familyMet', 'encounter', 'outcome', 'feedback']) delete s[k];
    for (const k of ['sword', 'shield', 'net']) delete s.hero[k];
    for (const m of [s.pending, s.lastMove].filter(Boolean)) delete m.eventData;
    for (const m of [s.pending, s.lastMove].filter(Boolean)) delete m.noticeVersion;
    if (s.phase === 'notice') s.phase = 'landing';
    return s;
  }
  fresh.hero.name = 'Грим'; fresh.hero.hp = 7;
  assert.equal(reload(rules.migrate(old(fresh))).hero.hp, 7);
  const pending = rules.begin(rules.choose(at('Q09'), 'Q10'), dice(1, 4));
  const migrated = reload(rules.migrate(old(pending)));
  assert.deepEqual(migrated.pending.path, pending.pending.path); assert.equal(migrated.pending.eventRoll, 4);
  const landed = rules.migrate(old(rules.arrive(pending)));
  assert.equal(rules.acknowledge(landed).hero.coins, 2);
  const previousV = old(rules.arrive(rules.begin(rules.choose(at('Q04'), 'Q05'), dice(1, 4))));
  previousV.phase = 'landing'; previousV.landing = {id: 1, kind: 'encounter', roll: null}; previousV.pending.eventRoll = null;
  assert.equal(reload(rules.migrate(previousV)).encounter.kind, 'soldier');
});

test('saved enemy profiles cannot silently scale or change', () => {
  const bad = meet(5); bad.encounter.enemies[0].attackBonus = 50;
  assert.throws(() => rules.validate(bad), /профиль/);
  const strong = meet(5, {hero: {sword: true, shield: true, attackBonus: 4, defense: 5}});
  assert.deepEqual(strong.encounter.enemies, meet(5).encounter.enemies);
});
