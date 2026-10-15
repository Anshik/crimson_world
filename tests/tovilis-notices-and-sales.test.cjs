'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const rules=require('../game/rules.js')(require('../assets/maps/geometry/tovilis-v9.json'));
function at(position='Q09',hero={}){const s=rules.create();s.position=position;Object.assign(s.hero,hero);
 if(hero.sword){s.hero.equipment.mainHand=hero.weapon||'sword';s.hero.weapon=s.hero.equipment.mainHand;}
 if(hero.shield)s.hero.equipment.offHand='shield';
 return s;}

const reload=s=>rules.validate(JSON.parse(JSON.stringify(s)));
const noRoll=()=>{throw Error('Unexpected roll');};
function dice(...values){return sides=>{const v=values.shift();assert.ok(v>=1&&v<=sides,`Unexpected d${sides}: ${v}`);return v;};}
function notice(id,hero={}){
 const index=rules.content.cityNotices.findIndex(n=>n.id===id)+1;assert.ok(index>0);
 return reload(rules.arrive(rules.begin(rules.choose(at('Q09',hero),'Q10'),dice(1,index))));
}
const resolve=(id,action,values=[],hero={})=>reload(rules.noticeAction(notice(id,hero),action,dice(...values)));

test('shop interest is 50/50, once per item, shop and day, saved without losing a refused item',()=>{
 for(let roll=1;roll<=6;roll++){
  const s=at('S12',{coins:0,sword:true,attackBonus:4});
  const sold=reload(rules.service(s,'sell-sword',dice(roll)));
  assert.equal(sold.hero.sword,roll<=3?false:true);assert.equal(sold.hero.coins,roll<=3?4:0);assert.equal(sold.ticks,0);
  assert.equal(sold.lastTrade.roll,roll);
  if(roll>3){
   assert.throws(()=>rules.service(sold,'sell-sword',noRoll),/завтра/);
   assert.equal(rules.service({...sold,ticks:18},'sell-sword',dice(1)).hero.coins,4);
   assert.equal(rules.service({...sold,position:'U06'},'sell-sword',dice(1)).hero.coins,4);
  }
  assert.equal(s.hero.sword,true);
 }
});
test('buyback uses neutral prices, preserves quest/starter gear, and does not apply weapon checks to potions',()=>{
 let s=at('S12',{coins:0,sword:true,attackBonus:4,shield:true,defense:5,net:true});
 assert.equal(rules.services(s).find(o=>o.id==='sell-shield').payout,2);
 s=rules.service(s,'sell-shield',dice(1));assert.equal(s.hero.defense,4);assert.equal(s.hero.coins,2);
 s=rules.service(s,'sell-potion',noRoll);assert.equal(s.hero.coins,4);assert.equal(s.hero.net,true);
 assert.ok(!rules.services(s).some(o=>/sell-(net|shortSword|armor)/.test(o.id)));
 assert.throws(()=>rules.service({...s,ticks:12},'sell-sword',noRoll),/утром/);
});
test('each find outcome is preserved as an item; protection ring affects defense exactly once',()=>{
 const ids=['glass','defenseRing','caneKnob','platinumRing','almaMedallion','chrysoberyl'];
 for(let roll=1;roll<=6;roll++){
  const s=resolve('find','search',[roll]);assert.equal(s.hero.finds[ids[roll-1]],1);
  assert.equal(s.hero.defense,roll===2?5:4);assert.equal(s.notice.rolls[0].value,roll);
  assert.throws(()=>rules.noticeAction(s,'search',noRoll),/завершено/);
  const done=reload(rules.acknowledge(s));assert.equal(done.ticks,1);assert.strictEqual(rules.acknowledge(done),done);
 }
 let s=rules.acknowledge(resolve('find','search',[2]));s.position='Q09';s.previous=null;s.selection=null;
 const n=rules.arrive(rules.begin(rules.choose(s,'Q10'),dice(1,2)));
 s=rules.noticeAction(n,'search',dice(2));assert.equal(s.hero.finds.defenseRing,2);assert.equal(s.hero.defense,5);
 s=rules.acknowledge(s);s.position='S12';s.previous=null;s.selection=null;
 s=rules.service(s,'sell-defenseRing',dice(1));assert.equal(s.hero.finds.defenseRing,1);assert.equal(s.hero.defense,5);
 s=rules.service(s,'sell-defenseRing',noRoll);assert.equal(s.hero.finds.defenseRing,0);assert.equal(s.hero.defense,4);
});
test('city deck retains source choices, rewards and bounded resource losses',()=>{
 assert.equal(rules.content.cityNotices.length,12);
 const caught=resolve('chase','chase',[3]);assert.equal(caught.hero.coins,4);assert.equal(caught.hero.reputation,1);assert.equal(caught.hero.experience,2);
 const innocent=resolve('chase','chase',[6]);assert.equal(innocent.hero.reputation,-1);
 const pass=resolve('chase','pass');assert.equal(pass.hero.reputation,0);
 const help=resolve('elf','help',[],{potions:1});assert.equal(help.hero.potions,0);assert.equal(help.hero.coins,3);assert.equal(help.hero.reputation,1);
 assert.throws(()=>rules.noticeAction(notice('elf',{potions:0}),'help',noRoll),/зель/);
 const water=resolve('water','help',[6,3]);assert.equal(water.hero.coins,1);assert.equal(water.hero.experience,3);
 const mood=resolve('mood','reflect',[6]);assert.equal(mood.hero.experience,0);
 const actors=resolve('actors','watch',[4,6],{coins:1});assert.equal(actors.hero.coins,0);assert.equal(actors.hero.experience,3);
 const cat=resolve('cat','continue',[1],{hp:1});assert.equal(cat.hero.hp,1);
});
test('old friend spends three extra ticks and penalises exactly the next two moves, minimum one step',()=>{
 let s=reload(rules.acknowledge(resolve('friend','visit',[6])));
 assert.equal(s.ticks,4);assert.equal(s.hero.slowMoves,2);assert.ok(s.hero.lore.includes('alien-lake'));
 s.position='S08';s.previous=null;s.selection=null;
 let moving=reload(rules.begin(rules.choose(s,'S09'),dice(3)));assert.equal(moving.pending.path.length-1,2);
 s=reload(rules.arrive(moving));assert.equal(s.hero.slowMoves,1);
 moving=reload(rules.begin(rules.choose(s,'S11'),dice(1)));assert.equal(moving.pending.path.length-1,1);
 s=reload(rules.arrive(moving));assert.equal(s.hero.slowMoves,0);
});
test('notice choice and resolved rolls survive reload; invalid actions and early acknowledgement cannot skip effects',()=>{
 let s=notice('find');assert.throws(()=>rules.acknowledge(s),/выберите|завершите/i);
 assert.throws(()=>rules.noticeAction(s,'help',noRoll),/действие/i);
 s=reload(rules.noticeAction(reload(s),'search',dice(6)));const saved=JSON.stringify(s);
 assert.deepEqual(reload(s),s);assert.equal(JSON.stringify(s),saved);
 const done=reload(rules.acknowledge(s));assert.equal(done.hero.finds.chrysoberyl,1);
 const corrupt=JSON.parse(saved);corrupt.notice.rolls[0].value=7;assert.throws(()=>rules.validate(corrupt));
});
test('v6 saves retain pending old notices, resources and combat while gaining empty event state',()=>{
 const old=at('Q09',{coins:17});old.version=6;
 delete old.shopInterest;delete old.lastTrade;delete old.notice;
 for(const k of ['finds','experience','reputation','slowMoves','lore'])delete old.hero[k];
 const migrated=rules.migrate(old);assert.equal(migrated.version,9);assert.equal(migrated.hero.coins,17);assert.deepEqual(migrated.hero.finds,{});
 const moving=rules.begin(rules.choose(migrated,'Q10'),dice(1,4));moving.version=6;moving.pending.noticeVersion=2;delete moving.pending.noticeId;
 const landed=rules.arrive(rules.migrate(moving));assert.equal(rules.acknowledge(landed).ticks,2);
});

test('every supported card action and pair of die faces survives saving with no duplicated effects',()=>{
 let checked=0;
 for(const card of rules.content.cityNotices)for(const [action] of card.actions)for(let first=1;first<=6;first++)for(let second=1;second<=6;second++)for(const hp of [1,10]){
  const start=notice(card.id,{hp,coins:0,food:0,potions:1});
  const values=[first,second];
  const result=reload(rules.noticeAction(start,action,sides=>Math.min(values.shift(),sides)));
  assert.equal(start.notice.stage,'choice');assert.equal(result.notice.stage,'result');
  const extra=result.notice.extraTicks,slow=result.notice.slowMoves;
  const done=reload(rules.acknowledge(reload(result)));
  assert.equal(done.turn,1);assert.equal(done.ticks,1+extra);assert.equal(done.hero.slowMoves,slow);
  assert.ok(done.hero.hp>=1&&done.hero.coins>=0&&done.hero.experience>=0);
  assert.strictEqual(rules.acknowledge(done),done);checked++;
 }
 assert.equal(checked,1080);
});
test('corrupt trade interest, found items and event counters are rejected',()=>{
 for(const mutate of [s=>s.hero.finds=true,s=>s.hero.finds.constructor=1,s=>s.hero.finds.defenseRing=-1,s=>s.hero.finds.unknown=1,s=>s.hero.experience=-1,s=>s.hero.slowMoves=3,s=>s.hero.lore=['alien-lake','alien-lake'],s=>s.shopInterest.shop={day:1,items:{sword:7}},s=>s.shopInterest.shop={day:2,items:{sword:1}}]){
  const s=rules.create();mutate(s);assert.throws(()=>rules.validate(s));
 }
 const original=notice('fortune');original.pending.noticeId='find';assert.throws(()=>rules.validate(original));
});
