'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const map=require('../assets/maps/geometry/tovilis-v9.json'),rules=require('../game/rules.js')(map);
const fixture=()=>({...rules.create(),position:'L03'});
test('legacy saves have zero balance and opening requires a deposit',()=>{
  const s=fixture();delete s.bank;
  assert.equal(rules.bankStatus(rules.migrate(s)).balance,0);
  assert.equal(s.hero.coins,1);
  assert.throws(()=>rules.bankTransfer(s,'withdraw',1),/Недостаточно/);
  const next=rules.bankTransfer(s,'deposit',1);
  assert.equal(next.hero.coins,0);assert.equal(rules.bankStatus(next).balance,1);
  assert.equal(rules.validate(next),next);
});
test('cash purchases and ordinary defeat preserve the bank',()=>{
  let s=fixture();s.hero.coins=20;s=rules.bankTransfer(s,'deposit',19);
  s.position='S12';assert.throws(()=>rules.service(s,'potion',()=>1),/Нужно/);
  s.hero.coins=10;
  // Build an authentic nighttime encounter via the movement rules.
  const from=map.cells.find(c=>rules.directions(c.id).some(d=>map.cells.find(x=>x.id===d.next).event==='encounter'));
  const next=rules.directions(from.id).find(d=>map.cells.find(x=>x.id===d.next).event==='encounter').next;
  s.position=from.id;s.ticks=12;
  const rolls=[1,6];s=rules.arrive(rules.begin(rules.choose(s,next),()=>rolls.shift()));
  assert.equal(s.phase,'encounter');s=rules.battle(s,'surrender',()=>1);
  assert.equal(s.outcome.kind,'defeat');assert.equal(rules.bankStatus(s).balance,19);
});
test('overflow and corrupt bank histories cannot pass validation',()=>{
  let s=fixture();s.hero.coins=Number.MAX_SAFE_INTEGER;
  s=rules.bankTransfer(s,'deposit',1);s.hero.coins=Number.MAX_SAFE_INTEGER;
  assert.throws(()=>rules.bankTransfer(s,'withdraw',1),/большая/);
  s.bank.tovilis.balance=2;assert.throws(()=>rules.validate(s),/итог/);
});
