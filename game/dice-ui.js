'use strict';
// Presentation only: every displayed value is already committed by the rules.
window.createTovilisDice = () => {
  const dialog = document.getElementById('roll-dialog'), cubes = document.getElementById('roll-cubes');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const faces = {1:[5],2:[1,9],3:[1,5,9],4:[1,3,7,9],5:[1,3,5,7,9],6:[1,3,4,6,7,9]};
  const orientations = ['rotateX(0deg) rotateY(0deg)','rotateX(0deg) rotateY(-90deg)','rotateX(-90deg) rotateY(0deg)','rotateX(90deg) rotateY(0deg)','rotateX(0deg) rotateY(90deg)','rotateX(0deg) rotateY(180deg)'];
  let end = null, audio = null, serial = 0;
  const sound = document.getElementById('dice-sound');
  try { sound.checked = localStorage.getItem('crimsonworld.tovilis.dice-sound') !== 'off'; } catch (_) { sound.checked = false; }
  sound.onchange = () => {try {localStorage.setItem('crimsonworld.tovilis.dice-sound',sound.checked?'on':'off');}catch (_) {}};
  function clatter() {
    if (!sound.checked) return;
    try {
      audio ||= new (window.AudioContext || window.webkitAudioContext)();
      audio.resume().catch(()=>{});
      // Deterministic noise, completely separate from gameplay Math.random.
      const buffer = audio.createBuffer(1, Math.floor(audio.sampleRate*.045), audio.sampleRate), samples = buffer.getChannelData(0);
      let seed = 719;
      for(let i=0;i<samples.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;samples[i]=(seed/4294967296*2-1)*Math.exp(-i/(audio.sampleRate*.009));}
      for(const [delay,volume] of [[0,.035],[.16,.023],[.37,.018]]) {
        const source=audio.createBufferSource(),gain=audio.createGain(),filter=audio.createBiquadFilter();source.buffer=buffer;filter.type='lowpass';filter.frequency.value=1500;gain.gain.value=volume;
        source.connect(filter);filter.connect(gain);gain.connect(audio.destination);source.start(audio.currentTime+delay);
      }
    } catch (_) { /* Sound failure never changes a saved roll. */ }
  }
  function cancel() {serial++;if(end)end(false);}
  async function show({title, rolls, result, detail=''}) {
    cancel();const token=serial;cubes.replaceChildren();
    document.getElementById('roll-title').textContent=title;
    document.getElementById('roll-result').textContent='Кубик катится…';
    document.getElementById('roll-detail').textContent='';
    const animations=[];
    for(const roll of rolls) {
      const figure=document.createElement('div');figure.className='rolled-die';
      const label=document.createElement('span');label.className='die-label';label.textContent=roll.label || 'd6';figure.append(label);
      const stage=document.createElement('div');stage.className='die-stage';const cube=document.createElement('div');cube.className='die-cube';stage.append(cube);figure.append(stage);
      for(let value=1;value<=6;value++) {
        const face=document.createElement('div');face.className=`die-side die-side-${value}`;face.setAttribute('aria-hidden','true');
        for(let point=1;point<=9;point++){const pip=document.createElement('i');pip.className=faces[value].includes(point)?'die-pip':'die-pip empty';face.append(pip);}cube.append(face);
      }
      const number=document.createElement('strong');number.className='die-number';number.textContent='';figure.append(number);cubes.append(figure);
      cube.style.transform=orientations[roll.value-1];
      const reveal=()=>{number.textContent=roll.value;figure.setAttribute('aria-label',`${roll.label || 'd6'}: ${roll.value}`);};
      if(reduced.matches)reveal();
      else {const animation=cube.animate([{transform:'rotateX(-28deg) rotateY(32deg) translateY(-12px)'},{transform:'rotateX(340deg) rotateY(390deg) translateY(-4px)',offset:.7},{transform:orientations[roll.value-1]}],{duration:570,easing:'cubic-bezier(.22,.65,.24,1)'});animations.push(animation.finished.then(reveal).catch(()=>{}));}
    }
    const continueButton=document.getElementById('roll-continue');continueButton.disabled=true;
    dialog.showModal();clatter();
    return new Promise(resolve=>{
      end=continued=>{end=null;dialog.close();resolve(continued);};
      continueButton.onclick=()=>end?.(true);
      Promise.all(animations).then(()=>{if(!end||token!==serial)return;document.getElementById('roll-result').textContent=result;document.getElementById('roll-detail').textContent=detail;continueButton.disabled=false;continueButton.focus({preventScroll:true});});
    });
  }
  dialog.addEventListener('cancel',event=>{event.preventDefault();end?.(true);});
  document.addEventListener('click',event=>{
    if(dialog.open && end && !document.getElementById('roll-continue').disabled && event.target.id !== 'roll-continue') end(true);
  },true);
  return {show,cancel,get busy(){return Boolean(end);}};
};
