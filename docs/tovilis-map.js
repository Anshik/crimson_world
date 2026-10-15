'use strict';
(() => {
  const data = window.TOVILIS_MAP;
  const $ = id => document.getElementById(id);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = $('map');
  const cells = new Map(data.cells.map(c => [c.id, c]));
  const adjacency = new Map(data.cells.map(c => [c.id, []]));
  for (const e of data.edges) {
    adjacency.get(e.from).push(e.to);
    if (e.bidirectional) adjacency.get(e.to).push(e.from);
  }
  let selected = data.startCell, start = null, end = null, path = [];
  let view = [0,425,1448,661], showArtOnly = false, dragged = false;
  const kinds = {junction:'Перекрёсток',path:'Улица',dead_end:'Конец пути'};
  const events = {encounter:'Встреча · В',notice:'Извещение · И'};
  function element(tag, attrs, parent, text) {
    const el = document.createElementNS(ns, tag);
    for (const [k,v] of Object.entries(attrs)) el.setAttribute(k,v);
    if (text != null) el.textContent = text;
    parent.appendChild(el);
    return el;
  }
  const points = c => c.polygon.map(p => p.join(',')).join(' ');
  function shortestPath(a,b) {
    if (!a || !b || !cells.has(a) || !cells.has(b)) return [];
    const parent = new Map([[a,null]]), queue = [a];
    for (let i=0; i<queue.length; i++) {
      const id = queue[i];
      if (id===b) {
        const result = [];
        for (let cur=b; cur!==null; cur=parent.get(cur)) result.unshift(cur);
        return result;
      }
      for (const n of adjacency.get(id)) if (!parent.has(n)) {
        parent.set(n,id); queue.push(n);
      }
    }
    return [];
  }
  for (const c of data.cells) {
    const polygon = element('polygon', {points:points(c),class:'cell'+(c.confidence==='visible'?'':' uncertain'),
      'data-cell':c.id,tabindex:0,role:'button','aria-label':`${c.id}, ${kinds[c.kind]}${c.event?', '+events[c.event]:''}`}, $('cells-layer'));
    element('title',{},polygon,`${c.id} · ${kinds[c.kind]}${c.mark?' · '+c.mark:''}`);
    polygon.addEventListener('click',()=>{if(!dragged) select(c.id);});
    polygon.addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();select(c.id);}});
    element('text',{x:c.position[0],y:c.position[1],class:'cell-label'},$('labels-layer'),c.id);
    if (c.kind==='junction') element('circle',{cx:c.position[0],cy:c.position[1],r:4.2,class:'junction-dot'},$('edges-layer'));
  }
  for (const e of data.edges) {
    const a=cells.get(e.from).position,b=cells.get(e.to).position;
    element('line',{x1:a[0],y1:a[1],x2:b[0],y2:b[1],class:'edge'},$('edges-layer'));
  }
  data.buildings.forEach((b,i)=>{
    const c=cells.get(b.cell), passive=!b.services.length;
    const group=element('g',{class:'entry'+(passive?' passive':''),tabindex:0,role:'button','aria-label':b.name+' · '+b.cell},$('entrances-layer'));
    element('title',{},group,b.name+(b.note?' · '+b.note:''));
    element('line',{x1:c.position[0],y1:c.position[1],x2:b.door[0],y2:b.door[1],class:'entry-line'},group);
    element('circle',{cx:b.door[0],cy:b.door[1],r:5,class:'entry-dot'},group);
    element('text',{x:b.door[0]+8,y:b.door[1]-8,class:'entry-label'},group,b.sign|| (b.id==='port'?'Порт':''));
    group.addEventListener('click',()=>{if(!dragged)select(b.cell);});
    group.addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();select(b.cell);}});
    const button=document.createElement('button');button.className='building'+(passive?' passive':'');
    const name=document.createElement('span');name.textContent=b.name;
    const id=document.createElement('small');id.textContent=b.cell+(passive?' · без действий':'');
    button.append(name,id);button.onclick=()=>select(b.cell);$('building-list').appendChild(button);
  });
  for(const exit of data.closedExits) {
    const [x,y]=cells.get(exit.cell).position;
    element('text',{x:Math.min(x,1390),y:Math.min(y+16,1080),class:'exit-label'},$('exits-layer'),'Выход закрыт');
  }
  for(const item of data.reviewItems) {
    const box=document.createElement('div');box.className='review-item';
    const button=document.createElement('button');button.textContent=item.title;button.onclick=()=>select(item.cells[0]);
    const p=document.createElement('p');p.textContent=item.note;box.append(button,p);$('review-list').appendChild(box);
  }
  $('review-count').textContent=data.reviewItems.length;
  const junctions=data.cells.filter(c=>c.kind==='junction').length;
  $('stats').textContent=`${data.cells.length} клеток · ${junctions} перекрёстков · ${data.buildings.length} входов`;

  function select(id) {
    selected=id;const c=cells.get(id);
    $('cell-title').textContent='Клетка '+id;$('cell-kind').textContent=kinds[c.kind];
    $('cell-info').replaceChildren();
    const dl=document.createElement('dl');dl.className='kv';
    const rows=[['Событие',events[c.event]||'Нет'],['Знак',c.mark||'Пустая клетка'],
      ['Позиция',c.position.join(', ')],['Видимость',c.confidence==='visible'?'Видимые границы':c.confidence==='partly_occluded'?'Часть границы не видна':'Рабочая трактовка']];
    const buildings=data.buildings.filter(b=>b.cell===id);
    if(buildings.length) rows.push(['Место',buildings.map(b=>b.name).join('; ')]);
    if(id===data.startCell) rows.push(['Старт','Начальная позиция первой партии']);
    for(const [key,value] of rows){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=key;dd.textContent=value;dl.append(dt,dd);}
    $('cell-info').append(dl);
    for(const note of [c.note,...buildings.map(b=>b.note)].filter(Boolean)){const p=document.createElement('p');p.className='note';p.textContent=note;$('cell-info').append(p);}
    $('neighbours').replaceChildren();
    for(const n of adjacency.get(id)){const button=document.createElement('button');button.textContent='→ '+n;button.title='Соседняя клетка '+n;button.onclick=()=>select(n);$('neighbours').append(button);}
    $('selection-layer').replaceChildren();element('polygon',{points:points(c),class:'selection-outline'},$('selection-layer'));
  }
  function updatePath() {
    path=shortestPath(start,end);$('route-start').textContent=start||'Начало';$('route-end').textContent=end||'Конец';
    $('path-layer').replaceChildren();
    if(path.length){
      const coords=path.map(id=>cells.get(id).position.join(',')).join(' ');
      element('polyline',{points:coords,class:'path-halo'},$('path-layer'));
      element('polyline',{points:coords,class:'path-line'},$('path-layer'));
      for(const id of [start,end]){const [x,y]=cells.get(id).position;element('circle',{cx:x,cy:y,r:5.5,class:'route-marker'},$('path-layer'));}
      const stops=path.slice(1).filter(id=>cells.get(id).kind==='junction').length;
      const uncertain=path.filter(id=>cells.get(id).confidence!=='visible');
      $('route-info').textContent=`Шагов: ${path.length-1}. Перекрёстков по пути: ${stops}.`+(uncertain.length?` Участки для сверки: ${uncertain.join(', ')}.`:'');
    } else $('route-info').textContent=start&&end?'Нет разрешённого пути.':'Выберите начало и конец на карте или готовый пример.';
  }
  $('set-start').onclick=()=>{start=selected;$('route-preset').value='';updatePath();};
  $('set-end').onclick=()=>{end=selected;$('route-preset').value='';updatePath();};
  $('clear-path').onclick=()=>{start=end=null;$('route-preset').value='';updatePath();};
  const place=id=>data.buildings.find(b=>b.id===id).cell;
  $('route-preset').onchange=e=>{
    const pairs={'start-mill':[data.startCell,place('mill')],'mill-shop':[place('mill'),place('shop')],
      'shop-port':[place('shop'),place('port')],'forge-tavern':[place('forge'),place('tavern')]};
    const pair=pairs[e.target.value];if(pair){[start,end]=pair;select(start);updatePath();}
  };
  function layers(){
    for(const name of ['cells','edges','labels','entrances']) $(name+'-layer').style.display=!showArtOnly&&$('show-'+name).checked?'':'none';
    for(const name of ['path','selection','exits']) $(name+'-layer').style.display=showArtOnly?'none':'';
  }
  for(const name of ['cells','edges','labels','entrances']) $('show-'+name).onchange=layers;
  $('art-only').onclick=()=>{showArtOnly=!showArtOnly;$('art-only').setAttribute('aria-pressed',showArtOnly);layers();};
  function updateView(){svg.setAttribute('viewBox',view.join(' '));$('zoom-readout').textContent=Math.round(1448/view[2]*100)+'%';}
  function zoom(factor,anchor){
    const width=Math.max(300,Math.min(2100,view[2]*factor));factor=width/view[2];
    const p=anchor||[view[0]+view[2]/2,view[1]+view[3]/2];
    view=[p[0]+(view[0]-p[0])*factor,p[1]+(view[1]-p[1])*factor,width,view[3]*factor];updateView();
  }
  function coordinate(e){const p=new DOMPoint(e.clientX,e.clientY).matrixTransform(svg.getScreenCTM().inverse());return[p.x,p.y];}
  $('zoom-in').onclick=()=>zoom(.8);$('zoom-out').onclick=()=>zoom(1.25);
  $('streets-view').onclick=()=>{view=[0,425,1448,661];updateView();};
  $('whole-view').onclick=()=>{view=[0,0,1448,1086];updateView();};
  svg.addEventListener('wheel',e=>{e.preventDefault();zoom(e.deltaY>0?1.12:1/1.12,coordinate(e));},{passive:false});
  let drag=null;
  svg.addEventListener('pointerdown',e=>{if(e.button!==0)return;dragged=false;drag={id:e.pointerId,at:coordinate(e),client:[e.clientX,e.clientY],view:[...view]};});
  svg.addEventListener('pointermove',e=>{
    if(!drag||drag.id!==e.pointerId)return;
    if(Math.hypot(e.clientX-drag.client[0],e.clientY-drag.client[1])<4&&!dragged)return;
    dragged=true;svg.classList.add('dragging');svg.setPointerCapture(e.pointerId);
    const p=coordinate(e);view[0]+=drag.at[0]-p[0];view[1]+=drag.at[1]-p[1];updateView();
  });
  const finishDrag=()=>{drag=null;svg.classList.remove('dragging');};
  svg.addEventListener('pointerup',finishDrag);svg.addEventListener('pointercancel',finishDrag);
  // Read-only hooks for checking the same graph used by the viewer.
  window.tovilisMapView={shortestPath,select,get selected(){return selected;},get path(){return [...path];}};
  select(selected);layers();updateView();
})();
