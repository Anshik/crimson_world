'use strict';
(function (root) {
  const directions = ['south', 'southeast', 'east', 'northeast', 'north', 'northwest', 'west', 'southwest'];
  const cropData = {
    'human-male': [[115,9,208,503],[109,8,199,491],[115,8,136,504],[89,8,191,504],[113,0,208,474],[103,0,193,481],[116,0,132,482],[85,0,204,483]],
    'human-female': [[126,8,175,487],[98,8,194,487],[127,9,118,486],[103,10,166,482],[113,8,188,481],[98,8,178,479],[121,8,121,485],[86,7,194,485]],
    'elf-male': [[161,9,187,490],[125,9,190,490],[135,9,134,490],[88,8,176,490],[122,6,201,489],[108,8,177,491],[84,8,156,490],[54,9,180,490]],
    'elf-female': [[106,10,195,493],[85,9,184,496],[127,9,128,497],[116,9,174,492],[106,11,192,490],[107,12,171,490],[136,11,134,494],[118,11,167,494]],
    'dwarf-female': [[25,12,324,482],[64,12,279,485],[88,12,204,488],[64,13,298,483],[59,11,289,477],[50,11,285,480],[61,11,230,482],[9,11,299,482]]
  };
  function makeAtlas(key) {
    const image = `../assets/characters/${key}-directions-v1.png`;
    const crops = cropData[key];
    const frames = Object.fromEntries(directions.map((name, i) => {
      const col = i % 4, row = Math.floor(i / 4), crop = crops[i];
      return [name, {viewBox: [col * 384, row * 512, 384, 512], crop, feet: [col * 384 + crop[0] + crop[2] / 2, row * 512 + crop[1] + crop[3] - 5], feetMargin: 10}];
    }));
    return {image, width: 1536, height: 1024, cell: {width: 384, height: 512}, feetMargin: 10, frames};
  }
  const atlases = Object.fromEntries(Object.keys(cropData).map(key => [key, makeAtlas(key)]));
  atlases['dwarf-male'] = root.TOVILIS_DWARF;
  function getTovilisAtlas(hero) {
    const c = hero?.character;
    if (!c || c.legacy) return root.TOVILIS_DWARF;
    return atlases[`${c.race}-${c.sex}`] || atlases['dwarf-female'];
  }
  root.TOVILIS_CHARACTER_ATLASES = atlases;
  root.getTovilisAtlas = getTovilisAtlas;
})(typeof window === 'undefined' ? globalThis : window);
