'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = {};
vm.runInNewContext(fs.readFileSync('game/dwarf-frames.js', 'utf8'), {window: root});
vm.runInNewContext(fs.readFileSync('game/character-frames.js', 'utf8'), {window: root});

test('all six race-sex atlases have valid cells and local alpha crop metadata', () => {
  const heroes = [
    ['human','male'], ['human','female'], ['elf','male'], ['elf','female'], ['dwarf','female'], ['dwarf','male']
  ];
  for (const [race, sex] of heroes) {
    const atlas = root.getTovilisAtlas({character:{race, sex, legacy:false}});
    assert.ok(atlas?.image);
    const imagePath = path.resolve('game', atlas.image);
    assert.ok(fs.existsSync(imagePath), imagePath);
    assert.equal(atlas.width, 1536); assert.equal(atlas.height, 1024);
    for (const frame of Object.values(atlas.frames)) {
      const [x, y, w, h] = frame.viewBox;
      assert.ok(x >= 0 && y >= 0 && x + w <= atlas.width && y + h <= atlas.height);
      if (frame.crop) {
        const [cx, cy, cw, ch] = frame.crop;
        assert.ok(cx >= 0 && cy >= 0 && cx + cw <= 384 && cy + ch <= 512);
        assert.ok(frame.feet[0] >= x && frame.feet[0] <= x + w && frame.feet[1] >= y && frame.feet[1] <= y + h);
      }
    }
  }
});
