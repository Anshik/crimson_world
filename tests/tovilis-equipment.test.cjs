'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const rules=require('../game/rules.js')(require('../assets/maps/geometry/tovilis-v9.json'));
const reload=s=>rules.validate(JSON.parse(JSON.stringify(s)));
const dice=(...values)=>sides=>{const n=values.shift();assert.ok(n>=1&&n<=sides,`Unexpected d${sides}: ${n}`);return n;};
function bought(){let s=rules.create();s.hero.coins=30;
 s.position=require('../assets/maps/geometry/tovilis-v9.json').buildings.find(b=>b.id==='forge').cell;
 return rules.service(rules.service(s,'sword'),'shield');}
function combat(s){s={...s,position:'Q04',previous:null,selection:null,ticks:12};return reload(rules.arrive(rules.begin(rules.choose(s,'Q05'),dice(1,6))));}

test('one equipment calculation supplies combat stats, inventory and slot descriptions',()=>{
 let s=bought(),profile=rules.equipmentProfile(s);
 assert.deepEqual(profile.stats,{strength:3,agility:3,defense:5,attackBonus:4,maxHp:16,manaBonus:0,peaceful:false,closedSocietyWard:false});
 assert.equal(profile.slots.find(x=>x.id==='body').item.id,'armor');
 assert.equal(profile.slots.find(x=>x.id==='head').item.id,'bronzeHelmet');
 assert.equal(profile.slots.find(x=>x.id==='shoulders').item.id,'travelCloak');
 assert.equal(profile.slots.find(x=>x.id==='head').item.effects.defense,undefined);
 s=reload(rules.equip(s,'offHand',null));assert.equal(s.hero.shield,true);assert.equal(s.hero.defense,4);
 assert.ok(rules.inventory(s).bag.some(i=>i.id==='shield'));
 s=reload(rules.equip(s,'body',null));assert.equal(s.hero.defense,3);assert.equal(s.hero.agility,4);
 assert.equal(s.hero.attackBonus,4);
 s=reload(rules.equip(s,'mainHand','shortSword'));assert.equal(s.hero.attackBonus,3);
 s=reload(rules.equip(s,'body','armor'));s=reload(rules.equip(s,'offHand','shield'));
 assert.equal(s.hero.defense,5);assert.equal(s.hero.agility,3);
 const before=JSON.stringify(s);assert.throws(()=>rules.equip(s,'head','sword'),/слот|место/);assert.equal(JSON.stringify(s),before);
 assert.throws(()=>rules.equip(s,'ring','defenseRing'),/нет|принадлежит/i);
});
test('selling carried equipment does not remove unrelated worn bonuses',()=>{
 let s=bought();s=rules.equip(s,'offHand',null);s=rules.equip(s,'mainHand','shortSword');s.position='S12';
 s=reload(rules.service(s,'sell-shield',dice(1)));assert.equal(s.hero.defense,4);assert.equal(s.hero.attackBonus,3);
 s=reload(rules.service(s,'sell-sword',dice(1)));assert.equal(s.hero.attackBonus,3);assert.equal(s.hero.equipment.mainHand,'shortSword');
});
test('battle switch consumes only the hero action; death before initiative cannot change equipment',()=>{
 let s=combat(bought());const n=reload(rules.battle(s,'switch',dice(6,1,1,1),'shortSword'));
 assert.equal(n.hero.attackBonus,3);assert.equal(n.encounter.report.hits.filter(h=>h.attacker==='hero').length,0);
 assert.equal(n.encounter.report.hits.filter(h=>h.attacker==='enemy-1').length,1);assert.equal(n.ticks,12);
 assert.throws(()=>rules.equip(s,'offHand',null),/вне боя|событие/);
 s.hero.hp=1;const lost=reload(rules.battle(s,'switch',dice(1,6,6,1),'shortSword'));
 assert.equal(lost.outcome.kind,'defeat');assert.equal(lost.hero.equipment.mainHand,'sword');assert.equal(lost.encounter.report.switch,null);
 assert.deepEqual(reload(lost),lost);
});
test('a unique artifact has one persistent world identity and cannot be claimed twice or sold in a normal shop',()=>{
 let s=rules.grantArtifact(rules.create(),'therionCloak');
 assert.equal(s.world.uniqueArtifacts.therionCloak,'hero');assert.ok(s.hero.artifacts.includes('therionCloak'));
 assert.throws(()=>rules.grantArtifact(reload(s),'therionCloak'),/единствен|экземпляр/);
 s=reload(rules.equip(s,'shoulders','therionCloak'));assert.equal(s.hero.defense,6);assert.equal(rules.equipmentProfile(s).stats.manaBonus,40);
 assert.ok(rules.inventory(s).bag.some(i=>i.id==='travelCloak'));
 s=reload(rules.equip(s,'shoulders','travelCloak'));assert.equal(s.hero.defense,4);
 s.position='S12';assert.ok(!rules.services(s).some(o=>o.id==='sell-therionCloak'));
 assert.throws(()=>rules.service(s,'sell-therionCloak',()=>1));
 const corrupt=JSON.parse(JSON.stringify(s));corrupt.hero.artifacts.push('therionCloak');assert.throws(()=>rules.validate(corrupt));
 const missing=JSON.parse(JSON.stringify(s));missing.world.uniqueArtifacts={};assert.throws(()=>rules.validate(missing));
});
test('source requirements and nonnumeric artifact effects survive the same slot model',()=>{
 let s=rules.grantArtifact(rules.create(),'skalemnirArmor');assert.throws(()=>rules.equip(s,'body','skalemnirArmor'),/сил/);
 s=rules.grantArtifact(s,'compassionTear');s=reload(rules.equip(s,'neck','compassionTear'));
 s=combat(s);assert.equal(s.encounter.hostile,false);assert.equal(s.encounter.protectedByArtifact,true);
 assert.throws(()=>rules.battle(s,'attack',()=>6,'enemy-1'));
 s=reload(rules.encounterAction(s,'pass'));assert.equal(s.phase,'ready');
 s=reload(rules.equip(s,'neck',null));assert.equal(rules.equipmentProfile(s).stats.peaceful,false);
});
test('v7 migration keeps active weapons, bonuses, ring and saved combat dice unchanged',()=>{
 // Migration fixtures are built from the saved shape, without executing old code.
 let s=bought();s.version=7;delete s.world;delete s.hero.equipment;delete s.hero.artifacts;
 s.hero.weapon='shortSword';s.hero.attackBonus=3;s.hero.finds.defenseRing=2;s.hero.defense=6;
 const m=rules.migrate(s);assert.equal(m.version,9);assert.equal(m.hero.defense,6);assert.equal(m.hero.attackBonus,3);
 assert.equal(m.hero.equipment.mainHand,'shortSword');assert.equal(m.hero.equipment.ring,'defenseRing');
 assert.equal(m.hero.finds.defenseRing,2);assert.deepEqual(reload(m),m);
});

test('all supported loadout combinations keep one copy per slot and one source of every bonus',()=>{
 let base=bought();base=rules.grantArtifact(base,'therionCloak');base=rules.grantArtifact(base,'compassionTear');
 base.hero.finds.defenseRing=2;
 const totals=s=>Object.fromEntries([...rules.inventory(s).bag,...rules.inventory(s).equipped].reduce((m,i)=>m.set(i.id,(m.get(i.id)||0)+i.quantity),new Map()));
 const expected=totals(base);let checked=0;
 for(const weapon of ['shortSword','sword'])for(const body of [null,'armor'])for(const shield of [null,'shield'])for(const ring of [null,'defenseRing'])for(const cloak of [null,'travelCloak','therionCloak'])for(const neck of [null,'compassionTear'])for(const head of [null,'bronzeHelmet']){
  let s=base;for(const [slot,id] of [['mainHand',weapon],['body',body],['offHand',shield],['ring',ring],['shoulders',cloak],['neck',neck],['head',head]])s=rules.equip(s,slot,id);
  s=reload(s);assert.equal(s.hero.strength,3);assert.equal(s.hero.attackBonus,weapon==='sword'?4:3);assert.equal(s.hero.agility,body?3:4);
  assert.equal(s.hero.defense,3+Number(!!body)+Number(!!shield)+Number(!!ring)+(cloak==='therionCloak'?2:0));
  assert.equal(rules.equipmentProfile(s).stats.peaceful,neck==='compassionTear');assert.deepEqual(totals(s),expected);checked++;
 }
 assert.equal(checked,192);
});
test('migrating a saved v7 round preserves initiative, damage and resources exactly',()=>{
 const s=rules.battle(combat(bought()),'switch',dice(6,1,1,1),'shortSword');
 const old=JSON.parse(JSON.stringify(s));old.version=7;delete old.world;delete old.hero.equipment;delete old.hero.artifacts;
 const loaded=reload(rules.migrate(old));
 assert.deepEqual(loaded.encounter,old.encounter);assert.deepEqual(loaded.pending,old.pending);
 for(const key of ['hp','coins','food','potions','strength','agility','attackBonus','defense'])assert.equal(loaded.hero[key],old.hero[key]);
 assert.equal(loaded.hero.equipment.mainHand,'shortSword');assert.equal(loaded.ticks,12);
});
