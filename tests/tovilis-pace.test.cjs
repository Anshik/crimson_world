'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const map = require('../assets/maps/geometry/tovilis-v9.json');
const rules = require('../game/rules.js')(map);
const reload = s => rules.validate(JSON.parse(JSON.stringify(s)));
const at = (position, ticks = 0) => ({...rules.create(), position, ticks});
function dice(...values) { return () => { assert.ok(values.length, 'Unexpected roll'); return values.shift(); }; }
const noRoll = () => { throw Error('This action must not roll'); };

test('new party enters between the shops; orders and mill services belong to separate places', () => {
  const s=reload(rules.create());assert.equal(s.position,'U07');assert.equal(s.turn,0);assert.equal(s.ticks,0);
  assert.equal(rules.services(s).length,0);
  const orders={...s,position:'Q01'};assert.ok(rules.services(orders).find(o=>o.id==='quest')?.enabled);
  assert.ok(!rules.services(orders).some(o=>['hire','family','work-mill'].includes(o.id)));
  const ordered=rules.service(orders,'quest',noRoll),mill={...ordered,position:'A06'};
  assert.ok(!rules.services(mill).some(o=>o.id==='quest'));
  const hired=rules.service(mill,'hire',noRoll);
  const worked=reload(rules.acknowledge(rules.finishWork(rules.service(hired,'work-mill'),dice(6))));
  assert.equal(worked.hero.coins,4);assert.equal(worked.ticks,3);assert.equal(worked.turn,0);
});

test('existing positions and unfinished building stops load without relocation or reroll', () => {
  const old = rules.choose(at('J08', 7), 'E06');
  old.hero.hp = 9;
  assert.deepEqual(reload(old), old);
  assert.equal(rules.arrive(rules.begin(reload(old), dice(6))).position, 'E01');
  const pending = rules.begin(rules.choose(at('S08'), 'S09', 'shop'), dice(6));
  const loaded = reload(pending);
  assert.equal(loaded.position, 'S08'); assert.deepEqual(loaded.pending.path, pending.pending.path);
  const done = reload(rules.arrive(loaded)); assert.equal(done.position, 'S12'); assert.equal(done.ticks, 1);
  assert.equal(reload(done).position, 'S12');
});

test('encounters cannot be chosen as stops; a random landing requires resolution before the next move', () => {
  const start = at('Q02', 12);
  assert.throws(() => rules.choose(start, 'Q03', 'Q05'), /ближайший вход/);
  const pass = rules.begin(rules.choose(start, 'Q03'), dice(6));
  assert.equal(pass.pending.path.at(-1), 'Q08'); assert.equal(pass.pending.event, null);
  const pending = reload(rules.begin(rules.choose(start, 'Q03'), dice(3, 6)));
  const met = reload(rules.arrive(pending));
  assert.equal(met.position, 'Q05'); assert.equal(met.encounter.kind, 'robber');
  assert.equal(met.phase, 'encounter'); assert.equal(met.ticks, 12);
  assert.throws(() => rules.begin(met, noRoll));
  assert.throws(() => rules.choose(met, 'Q06'));
  assert.throws(() => rules.encounterAction(met, 'pass'));
  assert.strictEqual(rules.acknowledge(met), met);
});

test('waiting at a closed workplace previews and applies food or hunger once, without travel, healing or dice', () => {
  for (const position of ['A06', 'S12', 'U06', 'J05', 'P02']) for (let ticks = 12; ticks < 18; ticks++) for (const food of [0, 1, 4]) {
    const s = at(position, ticks); s.hero.food = food; s.hero.hp = 5;
    const offer = rules.services(s).find(o => o.id === 'wait-opening');
    assert.ok(offer.enabled); assert.equal(offer.ticks, 18 - ticks); assert.equal(offer.cost, 0);
    const done = reload(rules.service(s, 'wait-opening', noRoll));
    assert.equal(done.position, position); assert.equal(done.turn, 0); assert.equal(done.ticks, 18);
    assert.equal(s.hero.food - done.hero.food, offer.foodCost);
    assert.equal(s.hero.hp - done.hero.hp, offer.hungerCost);
    assert.equal(done.hero.coins, s.hero.coins); assert.equal(done.phase, 'ready');
    assert.throws(() => rules.service(done, 'wait-opening', noRoll));
    assert.ok(rules.services(done).every(o => o.reason !== 'Откроется утром'));
  }
  const empty = at('S12', 17); empty.hero.hp = 1; empty.hero.food = 0;
  assert.equal(rules.services(empty).find(o => o.id === 'wait-opening').hungerCost, 0);
  assert.equal(rules.service(empty, 'wait-opening', noRoll).hero.hp, 1);
  for (const position of ['J08', 'J01', 'T03']) assert.throws(() => rules.service(at(position, 12), 'wait-opening', noRoll));
  const moving = rules.begin(rules.choose(at('S11', 12), 'S12', 'shop'), dice(1));
  assert.throws(() => rules.service(moving, 'wait-opening', noRoll));
});
