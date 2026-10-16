'use strict';
const {test}=require('node:test'), assert=require('node:assert/strict');
const rules=require('../game/rules.js')(require('../assets/maps/geometry/tovilis-v9.json'));
const reload=s=>rules.validate(JSON.parse(JSON.stringify(s)));
const noRoll=()=>{throw Error('Unexpected roll');};
function dice(...values){return sides=>{const v=values.shift();assert.ok(v>=1&&v<=sides,`Unexpected d${sides}: ${v}`);return v;};}
function start(roll,behavior=1,hero={}) {const s=rules.create();Object.assign(s.hero,hero);return reload(rules.service(s,'hunt',dice(roll,...([9,18].includes(roll)?[behavior]:[]))));}

test('all 20 rows, stats, behavior and counts match Tamrus and survive saving',()=>{
 const expected=[['hedgehog',1],['boar',1],['tiger',1],['lynx',1],['wolf',12],['boar',1],['goat',1],['duck',3],['boar',1],['crow',12],['wolf',6],['deer',1],['partridge',1],['crow',6],['squirrel',1],['anaconda',1],['wolf',6],['bear',1],['duck',1],['elephant',1]];
 for(let roll=1;roll<=20;roll++)for(let behavior=1;behavior<=6;behavior++){
  const s=start(roll,behavior),{row,animal}=rules.huntingProfile(s);
  assert.deepEqual([row.animal,row.count],expected[roll-1]);assert.equal(s.hunt.hp.length,row.count);assert.ok(s.hunt.hp.every(h=>h===animal.hp));
  assert.equal(s.hunt.fled,roll===9&&behavior===6);
  if(roll===18)assert.equal(s.hunt.hostile,behavior>=5);
  assert.equal(s.position,'U07');assert.equal(s.ticks,3);assert.equal(s.hero.food,3);
  assert.throws(()=>rules.acknowledge(s),/завершите/);assert.throws(()=>rules.service(s,'hunt',noRoll));
 }
 const fields=['hp','strength','damageCount','damageBonus','defense','agility','meat'];
 const expectedStats=[[1,null,0,0,1,null,1],[12,3,1,2,3,5,5],[9,5,2,1,4,6,4],[5,4,1,3,3,6,3],[2,3,1,1,2,5,0],[4,3,0,0,3,null,4],[1,4,0,0,1,null,1],[1,2,0,0,1,null,1],[7,4,0,0,3,null,5],[2,4,0,0,1,null,2],[1,4,0,0,1,null,1],[5,4,1,3,3,5,3],[10,6,2,3,4,5,5],[6,4,0,0,4,null,6]];
 Object.values(rules.content.hunting.animals).forEach((a,i)=>assert.deepEqual(fields.map(k=>a[k]),expectedStats[i]));
});
test('passive and fleeing animals cannot be killed by sword; only one ranged shot before escape',()=>{
 for(const row of [7,8,10,12,13,14,15,19,20]){
  const noWeapon=start(row);assert.throws(()=>rules.huntAction(noWeapon,'melee',noRoll),/метательное/);assert.throws(()=>rules.huntAction(noWeapon,'shoot',noRoll),/праща/);
  const s=start(row,1,{sling:true}),result=reload(rules.huntAction(s,'shoot',dice(6,1)));
  assert.equal(result.hunt.stage,'result');assert.ok(['victory','animal-fled'].includes(result.hunt.result));
  const {animal}=rules.huntingProfile(result),kills=result.hunt.hp.filter(hp=>!hp).length;
  assert.equal(result.hero.huntingBag?.gameMeat||0,kills*animal.meat);
  for(const id of animal.trophies)assert.equal(result.hero.huntingBag?.[id]||0,kills);
  assert.throws(()=>rules.huntAction(result,'shoot',noRoll),/завершена/);
 }
 const fled=start(9,6);assert.deepEqual(rules.huntingActions(fled).map(a=>a.id),['leave']);assert.equal(reload(rules.huntAction(fled,'leave',noRoll)).hunt.result,'animal-fled');
});
test('victory awards exact independent loot and experience once; cooking and sales are previewed and consumed',()=>{
 let s=reload(rules.huntAction(start(1),'melee',dice(6,1)));
 assert.equal(s.hunt.result,'victory');assert.deepEqual(s.hero.huntingBag,{gameMeat:1,hedgehogHide:1});assert.equal(s.hero.experience,1);
 assert.deepEqual(reload(s),s);s=reload(rules.acknowledge(s));assert.equal(s.position,'U07');assert.strictEqual(rules.acknowledge(s),s);
 s=reload(rules.service(s,'cook-meat',noRoll));assert.equal(s.hero.food,4);assert.equal(s.hero.huntingBag.gameMeat,0);assert.throws(()=>rules.service(s,'cook-meat',noRoll));
 s.position='U06';const offer=rules.services(s).find(o=>o.id==='sell-hedgehogHide');assert.equal(offer.payout,25);assert.equal(offer.interest,false);
 s=reload(rules.service(s,'sell-hedgehogHide',noRoll));assert.equal(s.hero.coins,26);assert.equal(s.hero.huntingBag.hedgehogHide,0);assert.throws(()=>rules.service(s,'sell-hedgehogHide',noRoll));
 assert.ok(rules.inventory({...s,hero:{...s.hero,sling:true}}).bag.some(i=>i.id==='sling'));
});
test('hostile pack, initiative, unfinished rounds, flee, defeat and refusal',()=>{
 let s=start(2);assert.ok(!rules.huntingActions(s).some(a=>a.id==='leave'));
 s=reload(rules.huntAction(s,'melee',dice(6,1,1,3,1,4)));assert.equal(s.hunt.stage,'combat');assert.equal(s.hunt.round,1);
 const saved=JSON.stringify(s);assert.deepEqual(reload(s),s);assert.equal(JSON.stringify(s),saved);
 s=reload(rules.huntAction(s,'flee',dice(6,1)));assert.equal(s.hunt.result,'escaped');assert.equal(s.position,'U07');
 const loss=reload(rules.huntAction(start(3,1,{hp:1,coins:7}),'melee',dice(1,6,6,6,1)));
 assert.equal(loss.hunt.result,'defeat');assert.equal(loss.hero.hp,8);assert.equal(loss.hero.coins,3);assert.deepEqual(loss.hunt.loot,{});assert.equal(loss.position,'U07');
 const bear=start(18,4);assert.ok(rules.huntingActions(bear).some(a=>a.id==='leave'));assert.equal(reload(rules.huntAction(bear,'leave',noRoll)).hunt.result,'declined');
 const pack=start(5);assert.equal(pack.hunt.hp.length,12);
});
test('skill bonus, food limits, shop hours, old saves and corrupted hunting states',()=>{
 const old=rules.create();assert.equal(reload(old).hunt,undefined);assert.equal(rules.inventory(old).bag.some(i=>i.id==='sling'),false);
 assert.throws(()=>rules.service({...old,position:'S12'},'hunt',noRoll));assert.throws(()=>rules.service({...old,hero:{...old.hero,food:0}},'hunt',noRoll),/порция/);
 let s={...old,position:'S12',hero:{...old.hero,coins:2}};s=reload(rules.service(s,'sling',noRoll));assert.equal(s.hero.coins,0);assert.equal(s.hero.sling,true);
 assert.equal(rules.services({...s,ticks:12}).find(o=>o.id==='sling').enabled,false);
 for(const change of [s=>s.hunt.roll=21,s=>s.hunt.hp.push(1),s=>s.hunt.hp[0]=99,s=>s.hunt.rolls[0].value=21,s=>s.hunt.loot={gameMeat:5},s=>s.hero.huntingBag={unknown:1},s=>s.position='U06']){const s=start(2);change(s);assert.throws(()=>reload(s));}
 const p={name:'Охотник',sex:'male',race:'human',origin:'abir',class:'scout'};
 let skilled=rules.createCharacter(p);skilled.hero.sling=true;skilled=rules.service(skilled,'hunt',dice(12));
 assert.equal(rules.huntingProfile(skilled).skill,1);assert.equal(rules.huntingProfile(skilled).aim,3);
 skilled=reload(rules.huntAction(skilled,'shoot',dice(4,1)));assert.equal(skilled.hunt.result,'victory');assert.equal(skilled.hero.huntingBag.deerAntlers,1);
});

test('legacy heroes can hunt deer and elephants; partial wolf pack yields hides without meat',()=>{
 for(const row of [12,20]){
  const s=reload(rules.huntAction(start(row,1,{sling:true}),'shoot',dice(6,1)));
  assert.equal(s.hunt.result,'victory');assert.equal(s.hero.huntingBag.gameMeat,row===12?5:6);
  if(row===20){assert.equal(s.hero.huntingBag.elephantHide,1);assert.equal(s.hero.huntingBag.elephantTusks,1);}
 }
 let s=start(5,1,{sling:true});
 s=reload(rules.huntAction(s,'shoot',dice(6,1,...Array.from({length:11},()=>[1,4]).flat())));
 assert.equal(s.hunt.stage,'combat');assert.equal(s.hunt.hp.filter(hp=>!hp).length,1);
 s=reload(rules.huntAction(s,'flee',dice(6,1)));assert.equal(s.hunt.result,'escaped');assert.deepEqual(s.hero.huntingBag,{wolfHide:1});
 const failed=reload(rules.huntAction(start(2),'flee',dice(1,6,1,4)));
 assert.equal(failed.hunt.stage,'combat');assert.equal(failed.hero.hp,16);
 const onBoundary=rules.create();onBoundary.ticks=3;onBoundary.hero.food=1;
 assert.equal(rules.services(onBoundary).find(o=>o.id==='hunt').hungerCost,1);
 const hungry=reload(rules.service(onBoundary,'hunt',dice(1)));assert.equal(hungry.hero.food,0);assert.equal(hungry.hero.hp,15);
 const prices={hedgehogHide:25,boarFangs:7,tigerHide:10,lynxHide:7,wolfHide:4,goatHide:4,deerAntlers:7,squirrelHide:2,anacondaHide:15,bearHide:9,elephantHide:15,elephantTusks:7};
 for(const [id,value] of Object.entries(prices)){
  assert.equal(rules.content.hunting.items[id].value,value);
  for(const position of ['S12','U06']){
   const s=rules.create();s.position=position;s.hero.huntingBag={[id]:1};
   const sold=reload(rules.service(s,`sell-${id}`,noRoll));assert.equal(sold.hero.coins,1+value);assert.equal(sold.hero.huntingBag[id],0);
  }
 }
});


test('HTTP object-key sorting preserves multi-item loot after ranged victory',()=>{
 const s=rules.huntAction(start(20,1,{sling:true}),'shoot',dice(6,1));
 const wire=JSON.parse(JSON.stringify(s,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value));
 assert.deepEqual(rules.validate(wire),s);
});
