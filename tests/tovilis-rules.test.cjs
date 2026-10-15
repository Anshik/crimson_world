'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const map = require('../assets/maps/geometry/tovilis-v9.json');
const rules = require('../game/rules.js')(map);
const roundtrip = state => rules.validate(JSON.parse(JSON.stringify(state)));
function stateAt(position) { return {...rules.create(), position}; }
function move(state, next, dice = [6], building = null) {
  let cursor = 0;
  return rules.begin(rules.choose(state, next, building), () => dice[cursor++]);
}
function finish(state) {
  const arrived = rules.arrive(state);
  return arrived.phase === 'notice' ? rules.acknowledge(arrived.pending.noticeVersion === 3 ? rules.noticeAction(arrived, rules.noticeCard(arrived).actions[0][0], () => 6) : arrived) : arrived.phase === 'encounter' ? rules.encounterAction(arrived, 'pass') : arrived;
}

test('direction is required before consuming a die; a roll locks the direction', () => {
  const original = stateAt('J08');
  let rolls = 0;
  assert.throws(() => rules.begin(original, () => ++rolls), /направление/);
  assert.throws(() => rules.choose(original, 'Q01'), /направлении/);
  assert.equal(rolls, 0);
  const pending = move(original, 'E06');
  assert.throws(() => rules.choose(pending, 'E07'), /текущее событие/);
  assert.throws(() => rules.begin(pending, () => ++rolls));
  assert.equal(rolls, 0);
  assert.equal(original.pending, null);
  assert.equal(original.position, 'J08');
});

test('leave starting junction, follow bends, stop at next junction and burn unused steps', () => {
  assert.deepEqual(rules.plan('J08', 'E06', 6).path, ['J08', 'E06', 'E05', 'E04', 'E03', 'E02', 'E01']);
  const stop = rules.plan('E06', 'J08', 6);
  assert.deepEqual(stop.path, ['E06', 'J08']);
  assert.equal(stop.reason, 'junction');
  assert.equal(stop.unused, 5);
  assert.deepEqual(rules.plan('U02', 'U03', 5).path, ['U02', 'U03', 'U04', 'U05', 'U06', 'J03']);
});

test('closed boundary is a dead end; the next turn can reverse', () => {
  const pending = move(stateAt('J08'), 'E07');
  assert.deepEqual(pending.pending.path, ['J08', 'E07']);
  assert.equal(pending.pending.reason, 'dead_end');
  assert.equal(pending.pending.unused, 5);
  const arrived = rules.arrive(pending);
  const back = move(arrived, 'J08');
  assert.equal(rules.arrive(back).position, 'J08');
  assert.equal(arrived.position, 'E07');
});

test('optional nearest entrance stops an overshoot but never extends a short roll', () => {
  const from = stateAt('S08');
  const option = rules.directions(from.position).find(d => d.next === 'S09');
  assert.equal(option.building.id, 'shop');
  const targeted = move(from, 'S09', [6], 'shop').pending;
  assert.equal(targeted.path.at(-1), 'S12');
  assert.equal(targeted.reason, 'building');
  assert.equal(targeted.unused, 2);
  assert.equal(move(from, 'S09', [2], 'shop').pending.path.at(-1), 'S10');
  assert.equal(move(from, 'S09').pending.path.at(-1), 'S14');
  assert.throws(() => rules.choose(from, 'S09', 'port'), /ближайший вход/);
  const atEntrance = rules.arrive(move(from, 'S09', [6], 'shop'));
  assert.equal(rules.directions(atEntrance.position).find(d => d.next === 'S13').building.id, 'forge');
});

test('passing a marked cell does not draw an event; landing does', () => {
  const pass = move(stateAt('Q02'), 'Q03');
  assert.ok(pass.pending.path.includes('Q05'));
  assert.equal(pass.pending.event, null);
  const encounter = move(stateAt('Q02'), 'Q03', [3, 4]);
  assert.equal(encounter.pending.event, 'encounter');
  assert.equal(encounter.pending.path.at(-1), 'Q05');
  const arrived = rules.arrive(encounter);
  assert.equal(arrived.phase, 'encounter');
  assert.equal(arrived.ticks, 0);
  assert.equal(rules.encounterAction(arrived, 'pass').ticks, 1);
});

test('pending dice survive reload; notice and time are applied only once', () => {
  const pending = move(stateAt('Q09'), 'Q10', [1, 4]);
  pending.pending.noticeVersion = 2; delete pending.pending.noticeId; // Existing saved city card.
  assert.equal(pending.pending.eventRoll, 4);
  const saved = roundtrip(pending);
  const arrived = roundtrip(rules.arrive(saved));
  assert.equal(arrived.position, 'Q10');
  assert.equal(arrived.ticks, 0);
  assert.equal(arrived.hero.coins, 1);
  assert.strictEqual(rules.arrive(arrived), arrived);
  const acknowledged = roundtrip(rules.acknowledge(arrived));
  assert.equal(acknowledged.ticks, 2);
  assert.equal(acknowledged.hero.coins, 1);
  assert.strictEqual(rules.acknowledge(acknowledged), acknowledged);
  assert.strictEqual(rules.arrive(acknowledged), acknowledged);
  const leave = finish(move(acknowledged, 'Q09', [1]));
  const returnAgain = finish(move(leave, 'Q10', [1, 3]));
  assert.equal(returnAgain.hero.coins, 1);
  assert.equal(returnAgain.turn, 3);
});

test('encounter uses time at departure, advancing time only after acknowledgment', () => {
  const from = {...stateAt('Q04'), turn: 11, ticks: 11};
  const arrived = rules.arrive(move(from, 'Q05', [1, 4]));
  assert.equal(arrived.pending.startedAtTick, 11);
  assert.equal(rules.clock(arrived.ticks).night, false);
  const acknowledged = rules.encounterAction(arrived, 'pass');
  assert.equal(rules.clock(acknowledged.ticks).night, true);
  assert.equal(acknowledged.hero.food, 3);
  assert.deepEqual(rules.clock(18), {day: 2, night: false, remaining: 12});
});

test('food every sixth turn, hunger and stumble cannot kill the hero', () => {
  let state = stateAt('J08');
  for (let i = 1; i <= 36; i++) {
    state = roundtrip(finish(move(state, state.position === 'J08' ? 'E07' : 'J08')));
    assert.equal(state.hero.food, Math.max(0, 4 - Math.floor(i / 6)));
  }
  assert.equal(state.hero.hp, 14);
  state = {...stateAt('Q09'), ticks: 5, turn: 5, hero: {...rules.create().hero, hp: 1, food: 0}};
  const done = finish(move(state, 'Q10', [1, 3]));
  assert.equal(done.hero.hp, 1);
  assert.equal(done.ticks, 6);
});
test('all six legacy city notices keep their saved effects after the new deck',()=>{
  const expected=[{coins:3,hp:10,ticks:1},{coins:1,hp:10,ticks:1},{coins:1,hp:8,ticks:1},{coins:1,hp:10,ticks:2},{coins:0,hp:10,ticks:1},{coins:1,hp:10,ticks:3}];
  for(let roll=1;roll<=6;roll++){
    const s=stateAt('Q09');s.hero.hp=10;s.hero.food=4;
    const pending=move(s,'Q10',[1,roll]);pending.pending.noticeVersion=2;delete pending.pending.noticeId;
    const notice=roundtrip(rules.arrive(roundtrip(pending)));
    const done=roundtrip(rules.acknowledge(notice));
    assert.deepEqual({coins:done.hero.coins,hp:done.hero.hp,ticks:done.ticks},expected[roll-1]);
    assert.strictEqual(rules.acknowledge(done),done);
  }
  const legacy=rules.arrive(move(stateAt('Q09'),'Q10',[1,4]));delete legacy.pending.noticeVersion;legacy.notice=null;
  assert.equal(rules.acknowledge(roundtrip(legacy)).hero.coins,2);
});

test('every graph direction and d6 outcome uses legal edges and respects stop boundaries', () => {
  let checked = 0;
  for (const cell of map.cells) for (const option of rules.directions(cell.id)) {
    for (const stop of [null, ...(option.building ? [option.building.id] : [])]) for (let roll = 1; roll <= 6; roll++) {
      const pending = roundtrip(move(stateAt(cell.id), option.next, [roll, 3], stop));
      const {path} = pending.pending;
      assert.equal(path[0], cell.id);
      assert.equal(path[1], option.next);
      assert.ok(path.length >= 2 && path.length <= roll + 1);
      for (let i = 1; i < path.length; i++) {
        assert.ok(map.edges.some(e => e.from === path[i - 1] && e.to === path[i] || e.bidirectional && e.to === path[i - 1] && e.from === path[i]));
        if (i < path.length - 1) assert.equal(map.cells.find(c => c.id === path[i]).kind, 'path');
      }
      const done = roundtrip(finish(pending));
      assert.equal(done.position, path.at(-1));
      assert.equal(done.previous, path.at(-2));
      assert.equal(done.turn, 1);
      checked++;
    }
  }
  assert.ok(checked > 1500);
});

test('corrupt or incompatible saves are rejected; hero names are limited', () => {
  const pending = move(stateAt('J08'), 'E06');
  for (const mutate of [s => {s.version = 99;}, s => {s.position = 'missing';}, s => {s.pending.roll = 7;}, s => {s.pending.path[1] = 'Q01';}, s => {s.hero.hp = -1;}, s => {s.ticks = -1;}, s => {s.pending.eventRoll = 3;}]) {
    const corrupt = JSON.parse(JSON.stringify(pending)); mutate(corrupt);
    assert.throws(() => rules.validate(corrupt));
  }
  assert.equal(rules.rename(rules.create(), '  Грим  ').hero.name, 'Грим');
  assert.throws(() => rules.rename(rules.create(), '   '));
  assert.equal(rules.rename(rules.create(), 'а'.repeat(60)).hero.name.length, 24);
  assert.throws(() => rules.validate({...rules.create(), lastMove: {path: ['J08', 'Q01'], roll: 6}}));
});
