'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const map = require('../assets/maps/geometry/tovilis-v9.json');
const rules = require('../game/rules.js')(map);
const reload = s => rules.validate(JSON.parse(JSON.stringify(s)));
const noRoll = () => { throw Error('Unexpected roll'); };
function dice(...values) { return () => { assert.ok(values.length); return values.shift(); }; }
function inside(id = 'tavern', ticks = 0, hero = {}) { const s = rules.create(); s.position = map.buildings.find(b => b.id === id).cell; s.ticks = ticks; Object.assign(s.hero, {coins: 10, hp: 8}, hero); return reload(s); }

test('both taverns offer food, ale, dice, rest and shelter by day and night', () => {
  for (const id of ['tavern', 'near-tavern']) for (const ticks of [0, 11, 12, 17, 18]) {
    const s = inside(id, ticks);
    assert.equal(rules.isTavern(id), true);
    const offers = rules.services(s);
    for (const action of ['food', 'ale', 'find-dice', 'rest']) assert.ok(offers.find(o => o.id === action)?.enabled);
    assert.equal(offers.find(o => o.id === 'food').ticks, 0);
    assert.equal(offers.find(o => o.id === 'ale').ticks, 1);
    assert.equal(offers.find(o => o.id === 'morning').enabled, ticks % 18 !== 0);
  }
});

test('bulk food purchase charges exactly the quantity and advances neither time nor movement', () => {
  for (const id of ['tavern', 'near-tavern']) {
    const s = inside(id, 5), result = reload(rules.service(s, 'food', noRoll, 7));
    assert.equal(result.hero.coins, 3); assert.equal(result.hero.food, id === 'tavern' ? 25 : 18);
    assert.equal(result.ticks, 5); assert.equal(result.turn, 0); assert.equal(result.position, s.position);
    assert.equal(result.hero.hp, s.hero.hp); assert.equal(s.hero.coins, 10);
    assert.match(result.feedback, /не расходует время/);
  }
});

test('invalid or unaffordable food quantities and purchases away from a tavern are rejected before mutation', () => {
  const s = inside('near-tavern', 17, {coins:3});
  for (const qty of [0, -1, .5, 4, NaN, Infinity, Number.MAX_SAFE_INTEGER]) assert.throws(() => rules.service(s, 'food', noRoll, qty));
  assert.equal(s.hero.coins, 3); assert.equal(s.ticks, 17); assert.equal(s.hero.food, 4);
  assert.throws(() => rules.service({...s, position:'J08'}, 'food', noRoll));
  assert.throws(() => rules.service(s, 'ale', noRoll, 2));
});

test('ale uses the local price, heals after hunger and is served at full life too', () => {
  const s = inside('near-tavern', 5, {coins: 2, food: 0, hp:5});
  const result = reload(rules.service(s, 'ale', noRoll));
  assert.equal(result.hero.coins, 0); assert.equal(result.ticks, 6); assert.equal(result.hero.hp, 6);
  assert.equal(result.hero.food, 0); assert.equal(result.turn, 0);
  const full = rules.service(inside('tavern', 12, {hp:16}), 'ale', noRoll);
  assert.equal(full.hero.hp, 16); assert.equal(full.hero.coins, 9); assert.equal(full.ticks, 13);
  assert.throws(() => rules.service(inside('tavern', 12, {coins:0}), 'ale', noRoll));
});

test('one search die decides company, search costs one tick, reload does not search again', () => {
  for (const id of ['tavern', 'near-tavern']) for (let roll=1; roll<=6; roll++) {
    const s = inside(id, 5), found = reload(rules.service(s, 'find-dice', dice(roll)));
    assert.equal(found.phase, 'tavern-game'); assert.equal(found.tavernGame.stage, roll >= 4 ? 'found' : 'empty');
    assert.equal(found.ticks, 6); assert.equal(found.hero.food, 3); assert.equal(found.hero.coins, 10);
    assert.deepEqual(reload(found), found); assert.throws(() => rules.service(found, 'find-dice', noRoll));
    if (roll < 4) assert.throws(() => rules.playDice(found, noRoll));
    const returned = reload(rules.acknowledge(found));
    assert.equal(returned.phase, 'ready'); assert.equal(returned.tavernGame, null); assert.equal(returned.ticks, 6);
    assert.equal(returned.hero.coins, 10);
  }
  assert.throws(() => rules.service(rules.create(), 'find-dice', noRoll));
});

test('dice win, loss and tie settle once, record both rolls and leave the city quest intact', () => {
  for (const [hero, visitor, delta] of [[6,1,1],[1,6,-1],[3,3,0]]) {
    const s = inside('near-tavern', 4, {coins:1, net:true}); s.quest='active';
    const ready = reload(rules.service(s, 'find-dice', dice(4)));
    const result = reload(rules.playDice(ready, dice(hero,visitor)));
    assert.equal(result.hero.coins, 1+delta); assert.equal(result.ticks, 6); assert.equal(result.turn, 0);
    assert.equal(result.tavernGame.foodUsed, 1); assert.equal(result.tavernGame.stage, 'result');
    assert.equal(result.tavernGame.heroRoll, hero); assert.equal(result.tavernGame.visitorRoll, visitor);
    assert.equal(result.hero.net, true); assert.equal(result.quest, 'active');
    assert.throws(() => rules.playDice(reload(result), noRoll));
    const done = reload(rules.acknowledge(result)); assert.strictEqual(rules.acknowledge(done), done);
    assert.equal(done.hero.coins, 1+delta); assert.equal(done.ticks, 6);
  }
});

test('no coin means no wager; corrupted dice results, place and search time are rejected', () => {
  const s = rules.service(inside('tavern', 12, {coins:0}), 'find-dice', dice(6));
  assert.throws(() => rules.playDice(s, noRoll), /монет/);
  for (const mutate of [s=>{s.tavernGame.place='near-tavern';},s=>{s.tavernGame.searchTick=0;},s=>{s.tavernGame.searchRoll=1;}]) {
    const bad=JSON.parse(JSON.stringify(s)); mutate(bad); assert.throws(()=>reload(bad));
  }
  const played=rules.playDice({...s,hero:{...s.hero,coins:1}},dice(6,1));
  played.tavernGame.delta=20; assert.throws(()=>reload(played));
});

test('v3 migration preserves resources, unfinished movement, daily work and already paid shifts', () => {
  const ready=inside('near-tavern',5,{coins:23});
  const hired=rules.service({...rules.create(),position:'A06'},'hire');
  const working=rules.service(hired,'work-mill');
  const paid=rules.finishWork(working,dice(6));
  const moving=rules.begin(rules.choose(ready,'R15'),dice(1));
  for(const state of [ready,working,paid,moving]) {
    const old=JSON.parse(JSON.stringify(state));old.version=3;delete old.tavernGame;
    const restored=reload(rules.migrate(old));
    for(const key of ['position','ticks','phase','hero','workLedger','job','pending']) assert.deepEqual(restored[key],old[key]);
    assert.equal(restored.tavernGame,null);assert.equal(restored.version,9);
  }
});

test('rooms differ in price and recovery speed, with food paid before healing', () => {
  const cheap = rules.services(inside('tavern')).find(o=>o.id==='rest');
  const noble = rules.services(inside('near-tavern')).find(o=>o.id==='rest');
  assert.equal(cheap.cost,1);assert.equal(cheap.ticks,6);
  assert.equal(noble.cost,3);assert.equal(noble.ticks,3);
  const a=reload(rules.service(inside('tavern',5,{hp:2,food:0,coins:3}),'rest',noRoll));
  const b=reload(rules.service(inside('near-tavern',5,{hp:2,food:0,coins:3}),'rest',noRoll));
  assert.equal(a.hero.hp,9);assert.equal(a.ticks,11);assert.equal(a.hero.coins,2);
  assert.equal(b.hero.hp,16);assert.equal(b.ticks,8);assert.equal(b.hero.coins,0);
  const repeated=rules.acknowledge(a);assert.deepEqual(repeated,a);
  assert.equal(rules.service(inside('tavern',0,{hp:15}),'rest',noRoll).hero.hp,16);
  assert.throws(()=>rules.service(inside('near-tavern',0,{coins:2}),'rest',noRoll));
});

test('every allowed stake pays exactly once, all 36 dice pairs remain fair', () => {
  for (const [place,max] of [['tavern',2],['near-tavern',3]]) {
    const s=rules.service(inside(place,4),'find-dice',dice(6));
    for (let stake=1;stake<=max;stake++) {
      let net=0,wins=0,losses=0,ties=0;
      for(let a=1;a<=6;a++)for(let b=1;b<=6;b++) {
        const done=reload(rules.playDice(s,dice(a,b),stake)),delta=done.hero.coins-s.hero.coins;
        assert.equal(delta,a>b?stake:a<b?-stake:0);
        assert.equal(done.tavernGame.stake,stake);assert.equal(done.ticks,6);
        assert.equal(done.tavernGame.foodUsed,1);net+=delta;
        if(delta>0)wins++;else if(delta<0)losses++;else ties++;
        assert.throws(()=>rules.playDice(done,noRoll,stake));
        const confirmed=reload(rules.acknowledge(done));assert.equal(confirmed.hero.coins,done.hero.coins);
      }
      assert.equal(net,0);assert.equal(wins,15);assert.equal(losses,15);assert.equal(ties,6);
    }
    for(const stake of [0,-1,.5,max+1,NaN,Infinity])assert.throws(()=>rules.playDice(s,noRoll,stake));
    assert.throws(()=>rules.playDice({...s,hero:{...s.hero,coins:1}},noRoll,2));
  }
});

test('v4 pending searches and settled one-coin games retain their original rolls and resources', () => {
  const found=rules.service(inside('tavern',4),'find-dice',dice(6));
  const empty=rules.service(inside('near-tavern',4),'find-dice',dice(1));
  const result=rules.playDice(found,dice(6,1));
  for(const state of [inside(),found,empty,result]) {
    const old=JSON.parse(JSON.stringify(state));old.version=4;
    if(old.tavernGame)delete old.tavernGame.stake;
    const restored=rules.migrate(old);assert.equal(restored.version,9);
    for(const key of ['hero','ticks','position','phase','workLedger'])assert.deepEqual(restored[key],old[key]);
    assert.deepEqual(restored.tavernGame,state.tavernGame);
  }
});

test('equipment and bag show the active and spare swords with quantity-weighted supplies', () => {
  let s=inside('tavern',0,{coins:40});
  let list=rules.inventory(s);
  assert.deepEqual(list.equipped.map(i=>i.id),['bronzeHelmet','armor','travelCloak','shortSword']);
  assert.equal(list.weight,7.25); // 3 sword + 3 armour + 4 quarter-weight food + one potion.
  s.position='J05';s=rules.service(rules.service(s,'sword'),'shield');
  list=rules.inventory(s);assert.deepEqual(list.equipped.map(i=>i.id),['bronzeHelmet','armor','travelCloak','sword','shield']);
  assert.equal(list.bag.find(i=>i.id==='shortSword').quantity,1);
  assert.equal(list.weight,14.25);
  s.position='S12';s.quest='active';s=rules.service(s,'net');
  assert.equal(rules.inventory(s).weight,16.25);
  s.position='T03';s=rules.service(s,'food',noRoll,2);
  assert.equal(rules.inventory(s).bag.find(i=>i.id==='food').quantity,10);
  assert.equal(rules.inventory(s).weight,17.75);
  s.position='P02';s=rules.service(s,'deliver');
  assert.equal(rules.inventory(s).bag.some(i=>i.id==='net'),false);
  assert.equal(rules.inventory(s).weight,15.75);
});
