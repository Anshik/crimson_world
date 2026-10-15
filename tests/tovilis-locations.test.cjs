'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const map=require('../assets/maps/geometry/tovilis-v9.json'),rules=require('../game/rules.js')(map);
const noRoll=()=>{throw Error('Unexpected roll');};
function at(position='Q09',hero={}){const s=rules.create();s.position=position;Object.assign(s.hero,hero);
 if(hero.sword){s.hero.equipment.mainHand=hero.weapon||'sword';s.hero.weapon=s.hero.equipment.mainHand;}
 if(hero.shield)s.hero.equipment.offHand='shield';
 return s;}

test('two shops sell different assortments and prices, and both close at night',()=>{
  for(const [cell,cost] of [['S12',4],['U06',3]]){
    const s=at(cell,{coins:10,potions:1});
    assert.equal(rules.services(s).find(o=>o.id==='potion').cost,cost);
    assert.equal(rules.services(s).some(o=>o.id==='net'),cell==='S12');
    const bought=rules.service(s,'potion',noRoll);assert.equal(bought.hero.coins,10-cost);assert.equal(bought.hero.potions,2);assert.equal(bought.ticks,0);
    assert.throws(()=>rules.service({...s,ticks:12},'potion',noRoll),/утром/);
  }
  assert.equal(rules.services(at('L03')).length,0);
  assert.equal(rules.services(at('J03'),'far-shop').length,0);
});
test('shops buy owned goods without selling quest items or starter gear',()=>{
  const central=at('S12',{coins:0,potions:1,sword:true,attackBonus:4,shield:true,defense:5,net:true});
  assert.deepEqual(rules.services(central).filter(o=>o.id.startsWith('sell-')).map(o=>[o.id,o.payout]),[['sell-potion',2],['sell-sword',4],['sell-shield',2]]);
  let sold=rules.service(central,'sell-potion',noRoll); assert.equal(sold.hero.potions,0);assert.equal(sold.hero.coins,2);assert.equal(sold.hero.net,true);
  sold=rules.service(sold,'sell-sword',()=>1); assert.equal(sold.hero.sword,false);assert.equal(sold.hero.attackBonus,3);assert.equal(sold.hero.coins,6);
  sold=rules.service(sold,'sell-shield',()=>1); assert.equal(sold.hero.shield,false);assert.equal(sold.hero.defense,4);assert.equal(sold.hero.coins,8);assert.equal(sold.ticks,0);
  assert.equal(rules.validate(JSON.parse(JSON.stringify(sold))).hero.net,true);
  assert.throws(()=>rules.service(sold,'sell-sword',()=>1),/вещи для продажи/);
  assert.throws(()=>rules.service({...central,ticks:12},'sell-potion',noRoll),/утром/);
  assert.equal(rules.service(at('U06',{coins:0,potions:1}),'sell-potion',noRoll).hero.coins,1);
  assert.equal(rules.services(at('U06',{coins:0,potions:1})).some(o=>o.id==='sell-sword'),true);
});
test('saved rolls aimed at the former junction shop still load without another die',()=>{
  const start=at('U07');const old=rules.begin(rules.choose(start,'J03'),()=>6);
  old.pending.stopBuilding='far-shop';old.pending.reason='building';
  assert.equal(rules.validate(JSON.parse(JSON.stringify(old))).pending.roll,6);
  const arrived=rules.arrive(old);
  assert.equal(rules.validate(JSON.parse(JSON.stringify(arrived))).position,'J03');
  const selected={...at('U07'),selection:{next:'J03',stopBuilding:'far-shop'}};
  assert.equal(rules.validate(selected).selection.next,'J03');
});
test('current shop entrance remains a valid selected stop after reaching its junction',()=>{
  const selected=rules.choose(at('J03'),'U06','far-shop');
  assert.equal(rules.validate(JSON.parse(JSON.stringify(selected))).selection.stopBuilding,'far-shop');
  const pending=rules.begin(selected,()=>1);
  const arrived=rules.arrive(pending);
  assert.equal(rules.validate(JSON.parse(JSON.stringify(arrived))).position,'U06');
});
test('v5 revision-1 positions and pending order stops migrate without reroll or relocation',()=>{
  const selected=rules.choose(at('Q02'),'Q01','orders');
  const pending=rules.begin(selected,()=>6);
  const arrived=rules.arrive(pending);
  for(const s of [selected,pending,arrived,at('J08')]){
    const old=JSON.parse(JSON.stringify(s));old.version=5;old.mapRevision=1;
    for(const m of [old.selection,old.pending,old.lastMove].filter(Boolean))if(m.stopBuilding==='orders')m.stopBuilding='mill';
    const copy=JSON.stringify(old),loaded=rules.migrate(old);
    assert.equal(JSON.stringify(old),copy);assert.equal(loaded.version,9);assert.equal(loaded.mapRevision,2);
    assert.equal(loaded.position,s.position);assert.equal(loaded.ticks,s.ticks);assert.deepEqual(loaded.hero,s.hero);
    if(loaded.pending){assert.deepEqual(loaded.pending.path,pending.pending.path);assert.equal(loaded.pending.roll,6);assert.equal(rules.arrive(loaded).position,'Q01');}
  }
});
test('an old mill shift at the order office can finish or acknowledge once, without granting new work there',()=>{
  const hired=rules.service(at('A06'),'hire'),working=rules.service(hired,'work-mill'),paid=rules.finishWork(working,()=>5);
  for(const original of [working,paid]){
    const old=JSON.parse(JSON.stringify(original));old.version=5;old.mapRevision=1;old.position='Q01';
    const loaded=rules.migrate(old);assert.equal(loaded.job.legacyAtOrders,true);assert.equal(loaded.position,'Q01');
    const done=loaded.phase==='work'?rules.finishWork(loaded,()=>5):loaded;
    const ready=rules.acknowledge(rules.validate(done));assert.equal(ready.hero.coins,4);assert.equal(ready.ticks,3);
    assert.throws(()=>rules.service(ready,'work-mill',noRoll));assert.deepEqual(rules.acknowledge(ready),ready);
    const moved={...ready,position:'A06'};assert.ok(rules.services(moved).find(o=>o.id==='work-mill').enabled);
  }
});
