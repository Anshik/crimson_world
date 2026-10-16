#!/usr/bin/env python3
"""Author the Tovilis v9 navigation layer in native image coordinates.

Cross-sections follow the blue pen divisions. They are manual observations,
not a regular grid or an automatic inference from colour. Run from any cwd.
"""
from pathlib import Path
import hashlib
import json

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'assets/maps/geometry'
cells, edges, routes = [], [], []


def cell(key, points, *, mark=None, event=None, confidence='visible', note=None):
    record = {'id': key, 'polygon': points,
              'position': [round(sum(p[i] for p in points) / len(points), 2) for i in (0, 1)],
              'surface': 'street', 'walkable': True, 'confidence': confidence,
              'event': event, 'mark': mark}
    if note:
        record['note'] = note
    cells.append(record)
    return key


def connect(a, b):
    if not any({e['from'], e['to']} == {a, b} for e in edges):
        edges.append({'from': a, 'to': b, 'bidirectional': True, 'cost': 1})


def route(key, name, ids):
    routes.append({'id': key, 'name': name, 'cells': ids})
    for a, b in zip(ids, ids[1:]):
        connect(a, b)
    return ids


def strip(prefix, sections, marks=None, uncertain=None, start=1):
    ids = []
    for i, (a, b) in enumerate(zip(sections, sections[1:]), 1):
        mark = (marks or {}).get(i)
        event = {'В': 'encounter', 'И': 'notice'}.get(mark)
        ids.append(cell(f'{prefix}{i+start-1:02}', [a[0], b[0], b[1], a[1]],
                        mark=mark, event=event,
                        confidence='partly_occluded' if i in (uncertain or []) else 'visible'))
    return ids


# Western quay; the second cell is the branch behind the tree.
quay = strip('Q', [
    [[218,478],[199,498]], [[269,478],[248,498]],
    [[300,477],[284,497]], [[321,477],[308,497]],
    [[344,477],[337,496]], [[376,476],[378,495]],
    [[414,475],[424,494]], [[452,475],[468,492]],
    [[481,474],[494,491]], [[505,473],[527,490]],
    [[545,471],[568,488]], [[590,469],[610,486]],
    [[640,470],[674,483]], [[680,467],[728,482]],
], {1:'↔', 2:'стрелки', 5:'В', 10:'И', 12:'стрелка'})
port_j = cell('J01', [[680,467],[710,462],[770,479],[728,482]], mark='стрелки')
route('quay', 'Набережная у мельницы', quay + [port_j])
port = strip('P', [
    [[680,467],[710,462]], [[653,458],[688,453]], [[614,448],[644,444]],
], {1:'стрелка',2:'стрелка / ?'})
route('pier', 'Подход к причалу', [port_j] + port)

neck = cell('N01', [[728,482],[770,479],[821,489],[776,496]])
upper_j = cell('J02', [[776,496],[821,489],[871,504],[819,510]], mark='стрелка')
route('port-street', 'От порта к развилке', [port_j, neck, upper_j])

# Two sides of the block with the small distant shop.
upper = strip('U', [
    [[821,489],[871,504]], [[881,482],[925,497]],
    [[927,477],[978,491]], [[972,476],[1024,487]],
])
upper_bend = cell('U04', [[972,476],[1028,470],[1068,479],[1024,487]], mark='стрелки')
upper_after = strip('U', [
    [[1068,479],[1024,487]], [[1127,488],[1078,496]],
    [[1177,499],[1114,509]],
], {2:'стрелка'}, start=5)
east_j = cell('J03', [[1114,509],[1177,499],[1243,515],[1183,526]], mark='стрелки')
route('upper-street', 'Верхняя улица у стогов', [upper_j] + upper + [upper_bend] + upper_after + [east_j])
distant_dead_end = cell('U07', [[1177,499],[1213,487],[1274,502],[1243,515]], mark='стрелка / ?')
route('east-spur', 'Короткий конец у дальней таверны', [east_j, distant_dead_end])

mid_j = cell('J04', [[890,533],[949,526],[1008,544],[949,552]], mark='↔')
link = strip('D', [
    [[819,510],[871,504]], [[860,524],[913,515]], [[890,533],[949,526]],
], {2:'стрелка'})
route('diagonal-link', 'Соединение верхней и средней улиц', [upper_j] + link + [mid_j])

middle = strip('M', [
    [[949,526],[1008,544]],
    [[1002,517],[1070,535]],
    [[1075,507],[1127,524]],
    [[1114,509],[1183,526]],
], {1:'И'})
route('middle-street', 'Улица над колодцем', [mid_j] + middle + [east_j])

far_tavern = strip('T', [
    [[1243,515],[1183,526]], [[1303,527],[1257,542]],
    [[1358,535],[1321,554]], [[1420,544],[1364,559]],
], {3:'↔'})
route('far-tavern', 'Подход к дальней таверне', [east_j] + far_tavern)

# Road down the west side of the well; bends with degree two are not junctions.
well_corner = cell('W01', [[692,560],[733,554],[777,579],[737,584]])
well_upper = strip('W', [
    [[733,554],[777,579]], [[794,546],[840,571]],
    [[840,541],[897,560]],
], {1:'В',2:'неясный знак'}, start=2)
well_last = cell('W04', [[840,541],[890,533],[949,552],[897,560]])
route('well-top', 'От колодца к средней развилке', [well_corner] + well_upper + [well_last, mid_j])
well_down = strip('B', [
    [[737,584],[777,579]], [[766,604],[815,595]],
    [[797,625],[853,615]], [[818,644],[882,637]],
], {2:'←',3:'→'})
well_bottom = cell('B04', [[818,644],[882,637],[932,665],[861,673]])
route('well-side', 'Поворот вокруг колодца', [well_corner] + well_down + [well_bottom])
forge_top = strip('F', [
    [[861,673],[818,644]], [[786,675],[751,645]],
    [[741,679],[710,651]], [[710,681],[681,655]],
    [[675,685],[643,661]],
], {2:'И'})
forge_bend = cell('F05', [[675,685],[710,681],[731,703],[697,707]])
forge_down = strip('G', [
    [[697,707],[731,703]], [[716,729],[752,724]],
    [[730,755],[772,749]],
])
market_j = cell('J05', [[730,755],[772,749],[814,789],[762,793]], mark='стрелки / ?')
route('forge-approach', 'Верхний подход к кузнице', [well_bottom] + forge_top + [forge_bend] + forge_down + [market_j])

# Western slope: three boundaries are partly hidden by the tree.
tree = strip('A', [
    [[248,498],[284,497]], [[235,516],[272,516]],
    [[216,542],[256,542]], [[199,561],[242,561]],
    [[181,580],[227,581]], [[159,603],[209,604]],
    [[132,633],[189,635]], [[113,656],[171,659]],
    [[94,678],[153,681]], [[70,707],[132,707]],
], {4:'И',6:'← / ?',8:'неясная надпись'}, uncertain=[2,3,4])
west_corner = cell('A11', [[70,707],[132,707],[112,738],[99,723]],
                   confidence='partly_occluded', note='Левый угол скрыт передней крышей; проход прослеживается по правой границе.')
tree_cross = strip('A', [
    [[132,707],[112,738]], [[170,708],[148,738]],
    [[203,708],[187,738]], [[236,708],[223,738]],
    [[265,707],[253,738]],
], start=12)
west_passage = cell('A16', [[112,738],[253,738],[242,783],[131,783]],
                    confidence='interpretation',
                    note='Широкий участок без внутренних делений; для прототипа считается одной клеткой. Левая граница закрыта крышей.')
west_j = cell('J06', [[184,784],[242,783],[230,816],[178,816]], mark='стрелки')
route('tree-lane', 'Переулок за деревом', [quay[1]] + tree + [west_corner] + tree_cross + [west_passage, west_j])

# Market street with the central shop door above it.
unknown_house = cell('H01', [[131,783],[184,784],[178,816],[117,813]], mark='стрелка',
                     confidence='partly_occluded', note='Край клетки закрыт крышей и вывеской О.')
route('west-house', 'Подход к Банку Товилиса', [west_j, unknown_house])
market_left = strip('S', [
    [[242,783],[230,816]], [[278,782],[266,815]],
    [[307,781],[299,815]], [[338,780],[333,814]],
    [[359,780],[357,814]], [[385,779],[386,813]],
    [[409,779],[414,812]], [[442,778],[449,811]],
], {3:'И'})
pool_j = cell('J07', [[442,778],[483,776],[493,810],[449,811]], mark='↓')
market_right = strip('S', [
    [[483,776],[493,810]], [[510,775],[521,808]],
    [[536,773],[548,806]], [[562,772],[575,804]],
    [[591,770],[608,802]], [[616,768],[638,800]],
    [[651,766],[676,799]], [[690,762],[720,797]],
    [[730,755],[762,793]],
], {3:'П',5:'↑ / ?'}, start=8)
route('market-street', 'Улица перед центральной лавкой', [west_j] + market_left + [pool_j] + market_right + [market_j])

# Pool circuit.
pool_west = strip('L', [
    [[178,816],[230,816]], [[166,844],[218,844]],
    [[153,872],[209,873]], [[140,900],[198,901]],
    [[124,938],[181,938]], [[109,974],[169,976]],
    [[90,1022],[151,1022]],
], {4:'← / ?'})
pool_sw = cell('L07', [[90,1022],[151,1022],[139,1064],[66,1064]], mark='Ж.К. / ?')
pool_bottom = strip('L', [
    [[151,1022],[139,1064]], [[210,1022],[201,1064]],
    [[252,1022],[248,1064]], [[294,1022],[287,1064]],
    [[338,1022],[338,1064]], [[388,1022],[386,1064]],
    [[436,1022],[438,1064]], [[482,1020],[494,1064]],
], start=8)
south_j = cell('J08', [[482,1020],[548,1018],[558,1063],[494,1064]], mark='? / →')
pool_east = strip('E', [
    [[449,811],[493,810]], [[453,839],[500,837]],
    [[458,867],[506,864]], [[463,899],[514,896]],
    [[469,935],[523,931]], [[476,979],[537,977]],
    [[482,1020],[548,1018]],
], {3:'←',5:'И'})
route('pool-west', 'Западный и южный край бассейна', [west_j] + pool_west + [pool_sw] + pool_bottom + [south_j])
route('pool-east', 'Восточный край бассейна', [pool_j] + pool_east + [south_j])
south_end = cell('E07', [[494,1064],[558,1063],[562,1086],[500,1086]],
                 confidence='partly_occluded',
                 note='Часть клетки за нижним краем изображения неизвестна. Выход за карту закрыт.')
route('south-exit', 'Обрезанная улица у нижнего края', [south_j, south_end])

# Long street along the forge and the near tavern.
near_down = strip('R', [
    [[762,793],[814,789]], [[790,815],[838,808]],
    [[820,848],[874,837]], [[846,875],[905,864]],
    [[882,911],[940,896]], [[913,943],[976,925]],
    [[942,973],[1007,955]], [[974,1006],[1042,984]],
    [[1026,1060],[1091,1041]],
], {4:'И'})
near_corner = cell('R09', [[1026,1060],[1091,1041],[1121,1074],[1078,1086],[1051,1086]],
                   confidence='partly_occluded', note='Нижний угол клетки обрезан рамкой; видимые соседние клетки соединены без выхода за карту.')
near_front = strip('R', [
    [[1091,1041],[1121,1074]], [[1146,1028],[1182,1057]],
    [[1196,1015],[1230,1044]], [[1239,1002],[1274,1030]],
    [[1279,989],[1316,1017]], [[1322,976],[1359,1004]],
    [[1363,964],[1394,988]], [[1420,949],[1448,970]],
], {3:'И',7:'↑'}, start=10)
near_exit = cell('R17', [[1448,970],[1394,988],[1448,1043]],
                 confidence='partly_occluded',
                 note='Улица продолжается за правый край; внешняя связь не создана.')
route('near-tavern', 'Улица вдоль кузницы и ближней таверны', [market_j] + near_down + [near_corner] + near_front + [near_exit])

by_id = {c['id']:c for c in cells}
assert len(by_id) == len(cells), 'duplicate cell ids'
# Keep the walking anchor of the broad western passage on its visible right
# edge, away from the roof that hides the opposite boundary.
by_id['A16']['position'] = [242,760]
for c in cells:
    neighbours = [e['to'] if e['from']==c['id'] else e['from'] for e in edges if c['id'] in (e['from'],e['to'])]
    c['kind'] = 'junction' if len(neighbours)>2 else 'dead_end' if len(neighbours)==1 else 'path'

buildings = [
    {'id':'orders','name':'Городской Заказ','cell':'Q01','door':[204,475],'sign':'З',
     'sourceObjects':['S01'],'services':['quest'],'status':'confirmed_place',
     'note':'Владелец уточнил: здание с З — только Заказ, не мельница.'},
    {'id':'mill','name':'Ветряная мельница','cell':'A06','door':[17,567],'sign':None,
     'sourceObjects':['T02'],'services':['work','family'],'status':'owner_confirmed_binding',
     'note':'Владелец показал дверь в обрезанной слева башне ветряка. Услуги доступны с A06 через открытый двор со стороны переулка; отдельные клетки во дворе не дорисованы.'},
    {'id':'port','name':'Причал · порт','cell':'P02','door':[665,428],'sign':None,
     'sourceObjects':['T04','T05'],'services':['work','delivery'],'status':'mvp_binding',
     'note':'Взаимодействие с портом назначено конечной клетке короткого подхода; отдельные клетки на настиле не дорисованы.'},
    {'id':'waterfront-house','name':'Прибрежный дом','cell':'J01','door':[758,474],'sign':None,
     'sourceObjects':['T06'],'services':[],'status':'unassigned'},
    {'id':'shop','name':'Центральная лавка','cell':'S12','door':[604,739],'sign':'Л',
     'sourceObjects':['T09','S02'],'services':['shop'],'status':'mvp_binding',
     'note':'Эта Л выбрана лавкой первой партии; игровое назначение — адаптация.'},
    {'id':'far-shop','name':'Травы у ворот','cell':'U06','door':[1177,491],'sign':'Л',
     'sourceObjects':['T08','S03'],'services':['potions'],'status':'confirmed_place',
     'note':'Владелец подтвердил вторую лавку. Специализация на зельях и цены — адаптация.'},
    {'id':'city-entry','name':'Вход в Товилис','cell':'U07','door':[1246,501],'sign':None,
     'sourceObjects':['S03','S04'],'services':['arrival'],'status':'owner_confirmed_binding',
     'note':'Владелец указал вход справа между лавкой и трактиром. Использован существующий конец подхода U07; внешние клетки не добавлены.'},
    {'id':'tavern','name':'Солёный якорь · дальняя таверна','cell':'T03','door':[1381,526],'sign':'Т',
     'sourceObjects':['T08','S04'],'services':['food','ale','dice','rest','wait','defeat_return'],'status':'confirmed_place'},
    {'id':'forge','name':'Кузница','cell':'J05','door':[803,748],'sign':'К',
     'sourceObjects':['T13','S06'],'services':['equipment'],'status':'confirmed_place',
     'note':'Вход назначен клетке перед воротами К. Плитка двора — часть рисунка здания, в уличный граф не включена.'},
    {'id':'near-tavern','name':'Золотой фонарь · ближняя таверна','cell':'R16','door':[1384,947],'sign':'Т',
     'sourceObjects':['T14','S05'],'services':['food','ale','dice','rest','wait'],'status':'confirmed_place',
     'note':'15 октября 2026 года владелец подтвердил вторую таверну: обе работают круглосуточно.'},
    {'id':'west-house','name':'Банк Товилиса','cell':'L03','door':[110,906],'sign':'О',
     'sourceObjects':['T16','S07'],'services':['bank'],'status':'confirmed_place',
     'note':'16 октября 2026 года владелец подтвердил банк. Существующий вход L03 сохранён.'},
]

reviews = [
    {'id':'tree-occlusion','title':'Клетки за деревом','cells':['A02','A03','A04'],
     'note':'Часть границ закрыта листвой. Контуры продолжены между видимыми концами; число клеток требует проверки владельцем.'},
    {'id':'west-wide-cell','title':'Широкий участок у левой крыши','cells':['A11','A16','H01'],
     'note':'У A16 нет видимых внутренних перегородок. В рабочей разметке это одна клетка, а не добавленная сетка.'},
    {'id':'port-binding','title':'Точка взаимодействия с портом','cells':['P02'],
     'note':'Привязка к причалу нужна для заказа первой партии; она не восстанавливает неизвестные исторические правила входа.'},
    {'id':'unknown-signs','title':'Знаки без заданной механики','cells':['S10','H01','U07','L07'],
     'note':'П, Ж.К., вопросы и стрелки сохранены как пометки. Они не задают односторонние связи или дополнительные события.'},
    {'id':'cropped-edges','title':'Обрезанные края карты','cells':['R09','E07','R17'],
     'note':'Нижний угол R09 частично обрезан. E07 и R17 завершают видимые улицы: внешние клетки и переходы не добавлены.'},
]
source_path = 'assets/maps/working/tovilis-v9.png'
data = {
    'schemaVersion': 1, 'id':'tovilis-v9', 'revision':2, 'createdOn':'2026-10-13',
    'status':'working_annotation',
    'source':{'path':source_path,'width':1448,'height':1086,
              'sha256':hashlib.sha256((ROOT/source_path).read_bytes()).hexdigest()},
    'coordinates':{'origin':'top-left','units':'source-image-pixels',
                   'positionMeaning':'feet position / street cell centre'},
    'policy':{'oneEdgeOneStep':True,'junctionStopsMovement':True,
              'eventsOnFinalCellOnly':True,'arrowsAffectMovement':False,
              'outsideMapTravel':False,
              'unknownSignsHaveEffects':False},
    'startCell':'U07', 'startNote':'Владелец указал вход справа между лавкой и трактиром. J08 остаётся прежней контрольной точкой у бассейна.',
    'cells':cells,'edges':edges,'routes':routes,'buildings':buildings,
    'closedExits':[{'cell':'E07','side':'bottom'},{'cell':'R17','side':'right'}],
    'reviewItems':reviews,
}

DEST.mkdir(parents=True,exist_ok=True)
encoded=json.dumps(data,ensure_ascii=False,indent=2)+'\n'
(DEST/'tovilis-v9.json').write_text(encoded)
(ROOT/'docs/tovilis-map-data.js').write_text('// Generated by tools/build_tovilis_map.py; edit the authoring source.\nwindow.TOVILIS_MAP = '+encoded.rstrip()+';\n')
print(f'{len(cells)} cells, {len(edges)} edges, {len(routes)} routes, {len(buildings)} entrances')
