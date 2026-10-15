'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const map = require('../assets/maps/geometry/tovilis-v9.json');
const rules = require('../game/rules.js')(map);
const reload = s => rules.validate(JSON.parse(JSON.stringify(s)));
const noRoll = () => { throw Error('Unexpected roll'); };
const hired = () => rules.service({...rules.create(),position:'A06'}, 'hire');
const shift = (s, action = 'work-mill', value = 6) => reload(rules.acknowledge(rules.finishWork(rules.service(s, action), () => value)));

test('work preview reserves no reward or time; cancellation keeps resources and remaining shifts', () => {
  const s = hired(), job = reload(rules.service(s, 'work-mill', noRoll));
  assert.equal(job.phase, 'work'); assert.deepEqual(job.hero, s.hero); assert.equal(job.ticks, s.ticks);
  assert.throws(() => rules.service(job, 'work-mill', noRoll));
  assert.throws(() => rules.begin(job, noRoll));
  const cancelled = reload(rules.cancelWork(job));
  assert.deepEqual(cancelled.hero, s.hero); assert.equal(rules.workStatus(cancelled).remaining, 2);
  assert.equal(cancelled.job, null); assert.equal(cancelled.ticks, 0);
});

test('saved work and result resume with one roll, one reward, exact time and food receipt', () => {
  const s = {...hired(), ticks: 4};
  let calls = 0;
  const pending = reload(rules.service(s, 'work-mill', noRoll));
  const finished = reload(rules.finishWork(pending, () => {calls++; return 5;}));
  assert.equal(calls, 1); assert.equal(finished.phase, 'work-result');
  assert.equal(finished.hero.coins, 4); assert.equal(finished.ticks, 7); assert.equal(finished.hero.food, 3);
  assert.equal(finished.job.foodUsed, 1); assert.equal(finished.job.hungerDamage, 0);
  assert.equal(finished.workLedger.count, 1);
  assert.throws(() => rules.finishWork(reload(finished), noRoll));
  assert.throws(() => rules.cancelWork(finished));
  const done = reload(rules.acknowledge(finished));
  assert.equal(done.job, null); assert.equal(done.hero.coins, 4); assert.equal(done.ticks, 7);
  assert.strictEqual(rules.acknowledge(done), done);
});

test('two shifts is a city-wide daily limit, including other employers and saved games', () => {
  let s = shift(hired());
  s.position = 'P02'; s.previous = null;
  s = shift(reload(s), 'work-port', 3);
  assert.equal(s.ticks, 6); assert.equal(s.hero.food, 3);
  for (const [position, action] of [['A06','work-mill'],['P02','work-port'],['J05','work-forge']]) {
    const here = reload({...s, position, previous:null});
    assert.equal(rules.workStatus(here).remaining, 0);
    assert.throws(() => rules.service(here, action, noRoll), /сегодня работа закончена/);
  }
  const waited = reload(rules.service(s, 'wait-work', noRoll));
  assert.equal(waited.ticks, 18); assert.equal(waited.hero.coins, s.hero.coins); assert.equal(waited.hero.food, 1);
  assert.equal(rules.workStatus(waited).remaining, 2);
  const tomorrow = shift(waited, 'work-port', 1);
  assert.equal(tomorrow.workLedger.day, 2); assert.equal(tomorrow.workLedger.count, 1);
});

test('work can end after closing; hunger receipt respects minimum life and never heals', () => {
  const s = {...hired(), ticks:11}; s.hero.food = 0; s.hero.hp = 2;
  const done = reload(rules.finishWork(rules.service(s, 'work-mill'), () => 1));
  assert.equal(done.ticks, 14); assert.equal(done.hero.hp, 1); assert.equal(done.job.hungerDamage, 1);
  assert.equal(done.job.foodUsed, 0); assert.equal(done.hero.coins, 2);
  assert.throws(() => rules.service(rules.acknowledge(done), 'work-mill', noRoll), /утром/);
});

test('v2 ready, movement and combat migrate without relocating the hero, resetting gear or rerolling events', () => {
  const states = [];
  const ready = hired(); ready.position='J08'; ready.hero.coins=9; ready.quest='active'; ready.hero.net=true;
  states.push(ready);
  states.push(rules.begin(rules.choose({...hired(),position:'Q04',ticks:12},'Q05'), (() => {const d=[1,6];return()=>d.shift();})()));
  states.push(rules.battle(rules.arrive(states[1]),'attack', (()=>{const d=[6,1,1,4,1,4];return()=>d.shift();})(),'enemy-1'));
  for (const state of states) {
    const old = JSON.parse(JSON.stringify(state)); old.version=2; delete old.workLedger; delete old.job;
    const restored=reload(rules.migrate(old));
    assert.equal(restored.version,9); assert.equal(restored.position,old.position); assert.equal(restored.ticks,old.ticks);
    assert.equal(restored.phase,old.phase); assert.deepEqual(restored.hero,old.hero);
    assert.deepEqual(restored.pending,old.pending); assert.deepEqual(restored.encounter,old.encounter);
    assert.equal(restored.workLedger.count,0);
  }
});

test('corrupt work duration, payment and daily counts are rejected', () => {
  const pending = rules.service(hired(),'work-mill');
  for (const mutate of [s=>{s.job.ticks=0;},s=>{s.job.place='port';},s=>{s.workLedger.count=3;},s=>{s.job.roll=6;}]) {
    const bad=JSON.parse(JSON.stringify(pending)); mutate(bad); assert.throws(()=>reload(bad));
  }
  const done=rules.finishWork(pending,()=>6); const bad=JSON.parse(JSON.stringify(done)); bad.job.pay=100;
  assert.throws(()=>reload(bad));
});

test('minimum wages still allow the order: wait for new shifts, buy the net and deliver on the real graph', () => {
  let s = rules.service({...hired(),position:'Q01'}, 'quest');s.position='A06';
  s = shift(s, 'work-mill', 1); s = shift(s, 'work-mill', 1);
  assert.equal(s.hero.coins, 3);
  s = rules.service(s, 'wait-work', noRoll);
  s = shift(s, 'work-mill', 1); s = shift(s, 'work-mill', 1);
  assert.equal(s.hero.coins, 5);
  function travel(target) {
    for (let guard=0;s.position!==target;guard++) {
      assert.ok(guard<80);
      const path=rules.shortestPath(s.position,target), option=rules.directions(s.position).find(o=>o.next===path[1]);
      const building=map.buildings.find(b=>b.cell===target);
      const values=[6,4];
      s=rules.arrive(rules.begin(rules.choose(s,path[1],option.building?.id===building.id?building.id:null),()=>values.shift()));
      if(s.phase==='notice'){if(s.pending.noticeVersion===3)s=rules.noticeAction(s,rules.noticeCard(s).actions[0][0],()=>6);s=rules.acknowledge(s);}
      if(s.phase==='encounter')s=rules.encounterAction(s,'pass');
      s=reload(s);
    }
  }
  travel('S12');
  if(rules.clock(s.ticks).night)s=rules.service(s,'wait-opening',noRoll);
  s=rules.service(s,'net',noRoll); travel('P02'); s=reload(rules.service(s,'deliver',noRoll));
  assert.equal(s.phase,'won'); assert.ok(s.hero.hp>0); assert.equal(s.hero.net,false);
});
