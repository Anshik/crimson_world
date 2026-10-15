#!/usr/bin/env python3
"""Validate navigation data without image or browser dependencies."""
from collections import Counter, deque
from pathlib import Path
import hashlib
import json
import math

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'assets/maps/geometry/tovilis-v9.json'


def cross(a,b,c):
    return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])


def intersects(a,b,c,d):
    return cross(a,b,c)*cross(a,b,d)<0 and cross(c,d,a)*cross(c,d,b)<0


def contains(p, poly):
    inside=False
    for a,b in zip(poly,poly[1:]+poly[:1]):
        if abs(cross(a,b,p))<.01 and min(a[0],b[0])<=p[0]<=max(a[0],b[0]) and min(a[1],b[1])<=p[1]<=max(a[1],b[1]):
            return True
        if (a[1]>p[1]) != (b[1]>p[1]):
            x=a[0]+(p[1]-a[1])*(b[0]-a[0])/(b[1]-a[1])
            if p[0]<x:
                inside=not inside
    return inside


def point_segment_distance(p,a,b):
    dx,dy=b[0]-a[0],b[1]-a[1]
    t=max(0,min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy))) if dx or dy else 0
    return math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy)


def shortest_path(adj,a,b):
    parent={a:None}
    queue=deque([a])
    while queue:
        cur=queue.popleft()
        if cur==b:
            result=[]
            while cur is not None:
                result.insert(0,cur)
                cur=parent[cur]
            return result
        for n in adj[cur]:
            if n not in parent:
                parent[n]=cur
                queue.append(n)
    return []


def validate():
    data=json.loads(DATA.read_text())
    cells={c['id']:c for c in data['cells']}
    assert len(cells)==len(data['cells']), 'Duplicate cell id'
    assert data['source']['sha256']==hashlib.sha256((ROOT/data['source']['path']).read_bytes()).hexdigest(), 'Source image changed'
    accepted=json.loads((ROOT/'assets/maps/working/tovilis-v9.json').read_text())
    assert data['source']['sha256']==accepted['output_sha256'], 'Image differs from accepted v9'
    # PNG IHDR stores dimensions independently of the author's JSON.
    raw=(ROOT/data['source']['path']).read_bytes()
    assert (int.from_bytes(raw[16:20],'big'),int.from_bytes(raw[20:24],'big'))==(data['source']['width'],data['source']['height'])
    width,height=data['source']['width'],data['source']['height']
    for c in cells.values():
        poly=c['polygon']
        assert len(poly)>=3 and len({tuple(p) for p in poly})==len(poly), c['id']+' degenerate polygon'
        assert all(0<=x<=width and 0<=y<=height for x,y in poly), c['id']+' outside image'
        assert contains(c['position'],poly), c['id']+' walking anchor outside cell'
        area=abs(sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(poly,poly[1:]+poly[:1])))/2
        assert area>10, c['id']+' zero area'
        sides=list(zip(poly,poly[1:]+poly[:1]))
        for i,(a,b) in enumerate(sides):
            for cc,d in sides[i+1:]:
                assert not intersects(a,b,cc,d), c['id']+' self-intersection'
        assert c['event'] in (None,'encounter','notice')
        assert c['event']=={'В':'encounter','И':'notice'}.get(c['mark']), c['id']+' guessed event'
    adjacency={cid:[] for cid in cells}
    unique=set()
    for e in data['edges']:
        a,b=e['from'],e['to']
        assert a in cells and b in cells and a!=b, 'Invalid edge'
        key=tuple(sorted((a,b)))
        assert key not in unique, 'Duplicate edge '+str(key)
        unique.add(key)
        assert e['cost']==1 and e['bidirectional'] is True
        adjacency[a].append(b);adjacency[b].append(a)
        # A nearby centre is insufficient: connected cells must touch at
        # their boundaries (2 pixels accommodates hand-traced pen thickness).
        pa,pb=cells[a]['polygon'],cells[b]['polygon']
        distance=min(point_segment_distance(p,x,y) for left,right in [(pa,pb),(pb,pa)] for p in left for x,y in zip(right,right[1:]+right[:1]))
        assert distance<=2, f'Edge {a}–{b} jumps a gap of {distance:.1f}px'
    reachable={data['startCell']}
    queue=deque(reachable)
    while queue:
        for n in adjacency[queue.popleft()]:
            if n not in reachable:
                reachable.add(n);queue.append(n)
    assert reachable==set(cells), 'Disconnected cells: '+str(set(cells)-reachable)
    for cid,neighbours in adjacency.items():
        expected='junction' if len(neighbours)>2 else 'dead_end' if len(neighbours)==1 else 'path'
        assert cells[cid]['kind']==expected, cid+' wrong junction status'
    for route in data['routes']:
        for a,b in zip(route['cells'],route['cells'][1:]):
            assert b in adjacency[a], 'Broken route '+route['id']
    for b in data['buildings']:
        assert b['cell'] in reachable, 'Unreachable building '+b['id']
        assert 0<=b['door'][0]<=width and 0<=b['door'][1]<=height
    assert len({b['id'] for b in data['buildings']})==len(data['buildings'])
    for item in data['reviewItems']:
        assert set(item['cells'])<=set(cells), 'Invalid review reference'
    for exit_ in data['closedExits']:
        assert len(adjacency[exit_['cell']])==1, 'Exit is not a capped end'
    embedded=(ROOT/'docs/tovilis-map-data.js').read_text().split('window.TOVILIS_MAP = ',1)[1].rstrip().removesuffix(';')
    assert json.loads(embedded)==data, 'Offline viewer data is stale'
    buildings={b['id']:b['cell'] for b in data['buildings']}
    clear_cells={cid for cid,c in cells.items() if c['confidence']=='visible'}
    clear_adj={cid:[n for n in neighbours if n in clear_cells] for cid,neighbours in adjacency.items() if cid in clear_cells}
    # The delivery scenario and its essential services must remain accessible
    # without inferred boundaries. The optional second tavern uses the visible
    # street through the cropped R09 corner; keep that uncertainty explicit.
    essential={'orders','port','shop','far-shop','forge','tavern','city-entry'}
    assert essential<=set(buildings), 'Missing essential location'
    optional_uncertain=[]
    for b in data['buildings']:
        if b['services']:
            path=shortest_path(clear_adj,data['startCell'],b['cell'])
            if b['id'] in essential:
                assert path, 'MVP depends on uncertain geometry: '+b['id']
            elif not path:
                inferred=[cid for cid in shortest_path(adjacency,data['startCell'],b['cell']) if cid not in clear_cells]
                allowed={'near-tavern':{'R09'},'mill':{'A02','A03','A04','A11','A16'}}
                assert b['id'] in allowed and inferred and set(inferred)<=allowed[b['id']], 'Unreviewed optional access: '+b['id']
                optional_uncertain.append({'building':b['id'],'cells':inferred})
    steps={}
    for name,a,b in [('start-mill',data['startCell'],buildings['mill']),('mill-shop',buildings['mill'],buildings['shop']),('shop-port',buildings['shop'],buildings['port']),('forge-tavern',buildings['forge'],buildings['tavern'])]:
        path=shortest_path(adjacency,a,b)
        assert path
        steps[name]=len(path)-1
    result={'cells':len(cells),'edges':len(unique),'routes':len(data['routes']),
            'junctions':sum(c['kind']=='junction' for c in cells.values()),
            'entrances':len(buildings),'events':dict(Counter(c['event'] for c in cells.values() if c['event'])),
            'routeSteps':steps,'mvpReachableWithoutUncertainCells':True,
            'optionalAccessThroughUncertainCells':optional_uncertain,'sourceUnchanged':True}
    print(json.dumps(result,ensure_ascii=False,indent=2))
    return result


if __name__=='__main__':
    validate()
