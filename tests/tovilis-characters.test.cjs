'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../game/rules.js')(require('../assets/maps/geometry/tovilis-v9.json'));

test('character profiles expose source races, sex, origin and class', () => {
  const s = rules.createCharacter({name: 'Лира', sex: 'female', race: 'elf', origin: 'forestElf', class: 'scout'});
  assert.equal(s.version, 9);
  assert.deepEqual(s.hero.character.labels, {sex: 'Женщина', race: 'Эльф', origin: 'Лесной эльф', class: 'Разведчик'});
  assert.equal(s.hero.character.base.agility, 4);
  assert.equal(s.hero.character.base.aim, 4);
  assert.equal(s.hero.maxHp, 9);
  assert.equal(s.hero.equipment.mainHand, 'shortSword');
  assert.doesNotThrow(() => rules.validate(s));
});

test('source race bonuses and class health table are applied once', () => {
  const dwarf = rules.createCharacter({name: 'Борин', sex: 'male', race: 'dwarf', origin: 'dwarf', class: 'warrior'});
  assert.equal(dwarf.hero.strength, 5);
  assert.equal(dwarf.hero.maxHp, 19);
  const human = rules.createCharacter({name: 'Нора', sex: 'female', race: 'human', origin: 'tovilis', class: 'warrior'});
  assert.equal(human.hero.character.base.agility, 4);
  assert.equal(human.hero.maxHp, 16);
});

test('legacy create and v8 saves retain the historic city dwarf profile', () => {
  const legacy = rules.create();
  assert.equal(legacy.hero.character.legacy, true);
  assert.equal(legacy.hero.maxHp, 16);
  const old = structuredClone(legacy); old.version = 8; delete old.hero.character;
  const migrated = rules.migrate(old);
  assert.equal(migrated.version, 9);
  assert.equal(migrated.hero.character.legacy, true);
  assert.equal(migrated.hero.maxHp, 16);
  assert.doesNotThrow(() => rules.validate(migrated));
});

test('invalid combinations and identity changes are rejected', () => {
  assert.throws(() => rules.createCharacter({name: 'X', sex: 'male', race: 'human', origin: 'forestElf', class: 'warrior'}), /происхождение/i);
  const s = rules.createCharacter({name: 'X', sex: 'male', race: 'dwarf', origin: 'dwarf', class: 'warrior'});
  const corrupt = structuredClone(s); corrupt.hero.character.race = 'elf';
  assert.throws(() => rules.validate(corrupt), /анкета|происхождение|снаряжением/i);
});
