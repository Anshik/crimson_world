'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const index = JSON.parse(fs.readFileSync('docs/rules/notices-index.json', 'utf8'));
test('notice index preserves every source field and the twelve supported city cards', () => {
  assert.equal(index.entryCount, 460);
  assert.equal(index.entries.length, 460);
  assert.equal(new Set(index.entries.map(e => `${e.sourceAnchor}:${e.sourceField}`)).size, 460);
  assert.equal(index.entries.filter(e => e.applicableCity).length, 146);
  assert.deepEqual(new Set(index.entries.filter(e => e.supportImplemented12.length).map(e => e.supportImplemented12[0])), new Set(['fortune','find','fall','mood','actors','friend','chase','elf','wasp','cat','water','rescuer']));
  assert.ok(index.entries.every(e => typeof e.fullText === 'string' && Array.isArray(e.conditionsRaw) && Array.isArray(e.unsupportedSystemsBacklog)));
});
