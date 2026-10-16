"""Deterministic UI scenarios for the playable city. Only isolated Safari storage is touched."""
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid


def check_game(request, prefix, js, click, snapshot, root):
    key = 'crimsonworld.tovilis.game.v9'
    v8_key = 'crimsonworld.tovilis.game.v8'
    v7_key = 'crimsonworld.tovilis.game.v7'
    v6_key = 'crimsonworld.tovilis.game.v6'
    route_key = key + '.route'
    v5_key = 'crimsonworld.tovilis.game.v5'
    v4_key = 'crimsonworld.tovilis.game.v4'
    previous_key = 'crimsonworld.tovilis.game.v3'
    second_key = 'crimsonworld.tovilis.game.v2'
    old_key = 'crimsonworld.tovilis.walk.v1'
    request('POST', prefix+'/window/rect', {'width': 1320, 'height': 920})
    request('POST', prefix+'/url', {'url': (root/'game/index.html').as_uri()})
    assert js('return !!window.tovilisGame;'), 'Game did not initialise'
    originals = {k: js(f'return localStorage.getItem({json.dumps(k)});') for k in [key, route_key, v8_key, v8_key + '.route', v7_key, v7_key + '.route', v6_key, v6_key + '.route', v5_key, v4_key, previous_key, second_key, old_key]}

    raw_click, raw_snapshot = click, snapshot

    def wait_roll():
        for _ in range(150):
            if not js('return document.getElementById("roll-dialog").open;'):
                return
            if js('return !document.getElementById("roll-continue").disabled;'):
                js('document.getElementById("roll-continue").click();')
            time.sleep(.03)
        raise AssertionError('Dice presentation did not finish')

    def click(selector):
        if selector == '#acknowledge' and js('return tovilisGame.state.phase === "notice" && tovilisGame.state.notice?.stage === "choice";'):
            action = js('return createTovilisRules(TOVILIS_MAP).noticeCard(tovilisGame.state).actions[0][0];')
            dice(1, 1)
            click(f'[data-action="notice-{action}"]')
        if selector != '#roll-continue':
            wait_roll()
        if '--ui-dom-click' in sys.argv:
            js(f'document.querySelector({json.dumps(selector)}).click();')
        else:
            raw_click(selector)

    def snapshot(name):
        wait_roll()
        raw_snapshot(name)

    def state():
        return js('return tovilisGame.state;')

    def healthy():
        assert js('return document.getElementById("save-error").hidden;'), js('return document.getElementById("save-error-text").textContent + " " + document.getElementById("save-error-details").textContent;')

    def settled():
        wait_roll()
        for _ in range(70):
            healthy()
            current = state()
            if current['phase'] != 'moving':
                return current
            time.sleep(.06)
        raise AssertionError('Animation did not finish')

    def refresh():
        request('POST', prefix+'/refresh', {})
        healthy()

    def fixture(position='J08', ticks=0, hero=None, extra=None):
        owns_sword = json.dumps(bool((hero or {}).get('sword')))
        explicit_weapon = json.dumps('weapon' in (hero or {}))
        js(f'const s=createTovilisRules(TOVILIS_MAP).create(); s.position={json.dumps(position)}; s.ticks={ticks}; Object.assign(s.hero,{json.dumps(hero or {})});if({owns_sword} && !{explicit_weapon})s.hero.weapon="sword";createTovilisEquipment(TOVILIS_CONTENT).migrateHero(s.hero); Object.assign(s,{json.dumps(extra or {})}); localStorage.setItem({json.dumps(key)}, JSON.stringify(s)); localStorage.removeItem({json.dumps(route_key)});')
        refresh()
        assert state()['position'] == position

    def dice(*values):
        fractions = [(v[0]-.5)/v[1] if isinstance(v, tuple) else (v-.5)/6 for v in values]
        js(f'window.__dice={json.dumps(fractions)}; Math.random=()=>{{if(!__dice.length) throw Error("Unexpected die"); return __dice.shift();}};')

    def close_place():
        if state()['phase'] == 'ready' and js('return document.getElementById("scene-dialog").open;'):
            click('#scene-close')

    def open_place():
        if state()['phase'] == 'ready' and not js('return document.getElementById("scene-dialog").open;'):
            click('#visit-place')

    def move(next_cell, *values):
        close_place()
        if state()['selection'] is None or state()['selection']['next'] != next_cell:
            click(f'[data-direction="{next_cell}"]')
        values = list(values)
        landing = js(f'const s=tovilisGame.state,r=createTovilisRules(TOVILIS_MAP),p=r.plan(s.position,s.selection.next,{values[0]},s.selection.stopBuilding,s.hero.slowMoves?1:0);return TOVILIS_MAP.cells.find(c=>c.id===p.path.at(-1)).event;')
        if landing == 'notice' and len(values) > 1 and not isinstance(values[1], tuple):
            values[1] = (values[1], 12)
        dice(*values)
        click('#roll')
        return settled()

    def service(name):
        open_place()
        click(f'[data-action="{name}"]')
        healthy()
        if name.startswith('work-'):
            assert state()['phase'] == 'work'
            service('perform-work')
            assert state()['phase'] == 'work-result'
            click('#acknowledge')
            healthy()

    def layout_checks(widths, route=None):
        for width in widths:
            request('POST', prefix+'/window/rect', {'width': width, 'height': 900})
            for junction in ['Q02','J01','J02','J03','J04','J05','J06','J07','J08']:
                fixture(junction)
                close_place()
                if route:
                    js(f'localStorage.setItem({json.dumps(route_key)}, {json.dumps(route)});')
                    refresh()
                geometry = js('const rect=r=>({left:r.left,right:r.right,top:r.top,bottom:r.bottom});const bs=Array.from(document.querySelectorAll(".direction"),b=>rect(b.getBoundingClientRect())),d=rect(document.querySelector(".movement-dock").getBoundingClientRect()),sp=document.getElementById("hero-sprite"),foot=TOVILIS_MAP.cells.find(c=>c.id===tovilisGame.state.position).position,m=document.getElementById("game-map").getScreenCTM(),a=new DOMPoint(foot[0]+Number(sp.getAttribute("x")),foot[1]+Number(sp.getAttribute("y"))).matrixTransform(m),b=new DOMPoint(foot[0]+Number(sp.getAttribute("x"))+Number(sp.getAttribute("width")),foot[1]+Number(sp.getAttribute("y"))+Number(sp.getAttribute("height"))).matrixTransform(m),hero={left:a.x,top:a.y,right:b.x,bottom:b.y};const hit=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;return {buttons:bs,dock:d,hero,width:innerWidth,height:innerHeight,ok:!hit(hero,d)&&bs.every(a=>a.left>=0&&a.right<=innerWidth&&a.top>=0&&a.bottom<=innerHeight&&!hit(a,d)&&!hit(a,hero))&&bs.every((a,i)=>bs.slice(i+1).every(b=>!hit(a,b)))};')
                if not geometry['ok']:
                    snapshot('city-layout-failure')
                    raise AssertionError((width, junction, geometry))
            snapshot('city-mobile-junction-'+str(width))
        print('Direction targets fit and do not overlap at all nine junctions:', widths, flush=True)

    try:
        if '--hero-sheet' in sys.argv:
            assert js('return getComputedStyle(document.querySelector(".reveal-cell")).display === "none" && getComputedStyle(document.querySelector(".reveal-link")).display === "none";')
            js('document.getElementById("menu-button")?.click();'); click('#show-grid'); assert js('return document.querySelector("#grid-layer").classList.contains("grid-visible") || document.querySelector("#game-map").classList.contains("grid-visible");'); click('#show-grid'); click('#menu-dialog .close')
            for width in [1320, 390, 320]:
                request('POST', prefix+'/window/rect', {'width': width, 'height': 900})
                fixture('J05', hero={'coins': 20, 'experience': 37, 'sword': True, 'shield': True, 'attackBonus': 4, 'defense': 5})
                close_place(); js('document.getElementById("portrait").scrollIntoView({block:"center"});'); click('#portrait')
                assert js('return document.getElementById("hero-dialog").open && document.querySelectorAll("[data-equipment-slot]").length === 7 && !document.querySelector("#hero-dialog select");')
                assert js('return document.getElementById("hero-health-value").textContent.includes("/") && document.getElementById("hero-experience").textContent === "37" && document.querySelectorAll(".hero-stat").length === 4;')
                js('document.getElementById("hero-scroll").scrollTop=0;'); snapshot('hero-sheet-overview-'+str(width))
                click('[data-stat="agility"]'); assert js('return document.getElementById("hero-stat-detail").textContent.length > 0;'), js('return document.getElementById("hero-stat-detail").textContent;')
                click('[data-hero-tab="equipment"]'); js('document.getElementById("hero-scroll").scrollTop=0;'); snapshot('hero-sheet-equipment-'+str(width)); click('[data-equipment-slot="body"]')
                gear_probe=js('return {text:document.querySelector("#gear-detail").textContent,remove:!!document.querySelector("[data-equip-slot=body][data-equip-item=\\"\\"]")};'); print('gear probe',gear_probe,flush=True)
                assert gear_probe['remove'], gear_probe
                assert js('return [...document.querySelectorAll("#gear-detail dl.item-facts > div")].every(row=>{const a=row.querySelector("dt").getBoundingClientRect(),b=row.querySelector("dd").getBoundingClientRect();return !(a.left<b.right&&b.left<a.right&&a.top<b.bottom&&b.top<a.bottom);});')
                before=state()['hero']; click('[data-equip-slot="body"][data-equip-item=""]'); healthy(); after=state()['hero']
                assert after['agility'] == before['agility'] + 1 and after['defense'] == before['defense'] - 1, (before, after)
                assert js('return !!document.querySelector("#hero-bag + .inventory-grid .bag-equip-link");')
                js('document.querySelector("#hero-bag + .inventory-grid .bag-equip-link").scrollIntoView({block:"center"});document.querySelector("#hero-bag + .inventory-grid .bag-equip-link").click();'); assert js('return document.querySelector("[data-hero-tab=equipment]").getAttribute("aria-selected") === "true";')
                click('[data-equipment-slot="mainHand"]'); click('[data-equip-slot="mainHand"][data-equip-item="shortSword"]'); healthy()
                assert state()['hero'].get('equipment',{}).get('mainHand') == 'shortSword'
                click('[data-hero-tab="bag"]'); js('document.getElementById("hero-scroll").scrollTop=0;'); snapshot('hero-sheet-bag-'+str(width)); assert js('return document.querySelector("#hero-bag + .inventory-grid") && document.querySelector("#hero-bag + .inventory-grid").textContent.includes("Стальной меч");')
                js('document.getElementById("hero-scroll").scrollTop=9999;')
                assert js('return document.querySelectorAll("[data-hero-tab]").length >= 3 && document.querySelector("#hero-scroll").scrollHeight >= document.querySelector("#hero-scroll").clientHeight;')
                click('#hero-dialog .close'); open_place(); assert js('return document.querySelectorAll(".item-offer-info").length > 0 && document.querySelectorAll(".item-offer-info dl.item-facts").length > 0 && document.querySelector(".item-offer-info").textContent.includes("Требования");'); snapshot('shop-item-facts-'+str(width)); click('#scene-close')
                bounds=js('return {width:innerWidth,scroll:document.documentElement.scrollWidth,body:document.querySelector("#hero-scroll").scrollWidth};')
                assert bounds['scroll'] <= bounds['width'] and bounds['body'] <= bounds['width'], bounds
            print('Safari: hero sheet stats/HP, seven equipment slots, chooser equip/unequip, bag link, tabs and 1320/390/320 bounds OK', flush=True)
            return
        if '--sale-ui' in sys.argv:
            request('POST', prefix+'/window/rect', {'width': 1320, 'height': 920})
            fixture('S12', hero={'coins': 20, 'sword': True, 'shield': True, 'finds': {'almaMedallion': 1}, 'attackBonus': 4, 'defense': 5})
            assert js('''const c=document.getElementById("context").textContent;
              return !!document.querySelector("[data-action=sell-sword]") &&
                !!document.querySelector("[data-action=sell-almaMedallion]") &&
                c.includes("без пробы интереса") && c.includes("50/50") && c.includes("Медный медальон Альмы");''')
            snapshot('shop-sale-labels-1320')
            print('Safari: sale cards show no-interest rule for ordinary goods and 50/50 sword rule; screenshot OK', flush=True)
            return
        if '--hud-notice' in sys.argv:
            widths = [1320, 1024, 800, 390, 320]
            for width in widths:
                request('POST', prefix+'/window/rect', {'width': width, 'height': 920 if width > 500 else 844})
                fixture('Q09', hero={'experience': 37})
                js('''if (!document.querySelector('.topbar .online-actions')) {
                  document.querySelector('.topbar .top-actions')?.classList.add('online-actions');
                }''')
                hud = js('''const top=document.querySelector('.topbar'), r=e=>{const b=e.getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom};};
                  const nodes=[...document.querySelectorAll('.topbar .brand,.topbar #portrait,.topbar .resources,.topbar .online-actions')];
                  const boxes=nodes.map(r); const hit=(a,b)=>a.left<b.right-1&&a.right>b.left+1&&a.top<b.bottom-1&&a.bottom>b.top+1;
                  return {xp:document.getElementById('experience').textContent,scroll:document.documentElement.scrollWidth,width:innerWidth,boxes,ok:boxes.every((a,i)=>boxes.slice(i+1).every(b=>!hit(a,b))),top:r(top)};''')
                assert hud['xp'] == '37' and hud['scroll'] <= hud['width'] and hud['ok'], hud
                if width == 1320: snapshot('hud-1320')
                current = move('Q10', 1, (4, 12))
                assert current['phase'] == 'notice' and current['pending']['eventRoll'] == 4
                dice(6, 3)
                click('[data-action="notice-reflect"]')
                for _ in range(150):
                    if js('return document.getElementById("roll-result").textContent !== "Кубик катится…" && !document.getElementById("roll-continue").disabled;'):
                        break
                    time.sleep(.03)
                notice_probe = js('''const d=document.getElementById('roll-dialog'),r=document.getElementById('roll-result'),c=document.getElementById('roll-continue');
                  return {open:d.open,text:r.textContent,detail:document.getElementById('roll-detail').textContent,font:getComputedStyle(r).fontSize,disabled:c.disabled,width:c.getBoundingClientRect().width};''')
                print('hud notice probe', notice_probe, flush=True)
                assert notice_probe['open'] and 'Мрачные мысли' in notice_probe['text'] and 'Выпало' not in notice_probe['text'] and float(notice_probe['font'].replace('px','')) >= 22 and not notice_probe['disabled'] and notice_probe['width'] > 0, notice_probe
                if width == 1320: raw_snapshot('hud-notice-1320')
                if width == 390: raw_snapshot('hud-notice-390')
                js('document.getElementById("roll-continue").click();')
                click('#acknowledge')
                assert state()['phase'] == 'ready' and state()['hero']['experience'] == 27
                refresh()
                assert state()['hero']['experience'] == 27 and js('return document.getElementById("experience").textContent === "27";')
            print('Headless: HUD XP 37→27, city mood consequence text/22px dice result, continue action, reload persistence, and 1320/1024/800/390/320 header bounds OK', flush=True)
            return
        if '--ui-equipment' in sys.argv:
            def choose_gear(slot, value):
                click(f'[data-equipment-slot="{slot}"]')
                selector=f'[data-equip-slot="{slot}"][data-equip-item={json.dumps(value)}]'
                js(f'document.querySelector({json.dumps(selector)})?.scrollIntoView({{block:"center"}});document.querySelector({json.dumps(selector)})?.click();')
                healthy()
                assert js('return document.getElementById("hero-dialog").open;')
            for width in [1320, 390]:
                request('POST', prefix+'/window/rect', {'width': width, 'height': 920})
                fixture('J05', hero={'coins': 20, 'sword': True, 'shield': True, 'attackBonus': 4, 'defense': 5})
                close_place()
                click('#portrait')
                assert js('return document.getElementById("hero-dialog").open && document.querySelectorAll("[data-equipment-slot]").length === 7 && !document.querySelector("#hero-dialog select");')
                click('[data-hero-tab="equipment"]')
                choose_gear('offHand', '')
                assert state()['hero']['defense'] == 4 and state()['hero']['shield']
                choose_gear('body', '')
                assert state()['hero']['defense'] == 3 and state()['hero']['agility'] == 4
                choose_gear('mainHand', 'shortSword')
                assert state()['hero']['attackBonus'] == 3 and state()['hero']['sword']
                assert js('''return [...document.querySelectorAll("#gear-detail dl.item-facts > div")].every(row=>{
                  const a=row.querySelector("dt").getBoundingClientRect(),b=row.querySelector("dd").getBoundingClientRect();
                  return !(a.left<b.right&&b.left<a.right&&a.top<b.bottom&&b.top<a.bottom);
                });''')
                choose_gear('body', 'armor')
                choose_gear('offHand', 'shield')
                assert state()['hero']['defense'] == 5 and state()['hero']['agility'] == 3
                js('document.querySelector(".hero-paperdoll").scrollIntoView({block:"start"});')
                snapshot('city-equipment-v8-'+str(width))
                click('#hero-dialog .close')
                before = state()
                refresh()
                assert state() == before
                bounds = js('return {width:innerWidth,scroll:document.documentElement.scrollWidth};')
                assert bounds['scroll'] <= bounds['width'], bounds
            fixture('Q04', 12, hero={'sword': True, 'attackBonus': 4, 'shield': True, 'defense': 5})
            assert move('Q05', 1, 6)['phase'] == 'encounter'
            dice(6, 1, 1, (5, 5))
            click('[data-action="switch-weapon"]')
            wait_roll()
            assert state()['hero']['equipment']['mainHand'] == 'shortSword' and state()['hero']['attackBonus'] == 3
            assert not any(h.get('attacker') == 'hero' for h in state()['encounter']['report']['hits'])
            refresh()
            assert state()['hero']['equipment']['mainHand'] == 'shortSword'
            fixture('Q04', 12)
            js(f'let s=tovilisGame.state,r=createTovilisRules(TOVILIS_MAP);s=r.grantArtifact(s,"compassionTear");s=r.equip(s,"neck","compassionTear");localStorage.setItem({json.dumps(key)},JSON.stringify(s));')
            refresh()
            assert move('Q05', 1, 6)['encounter']['protectedByArtifact']
            assert not js('return !!document.querySelector("[data-action=provoke], [data-action=attack]");')
            click('[data-action="pass"]')
            assert state()['phase'] == 'ready'
            fixture('J05', hero={'coins': 17, 'sword': True, 'shield': True, 'attackBonus': 4, 'defense': 5})
            js(f'const old=JSON.parse(localStorage.getItem({json.dumps(key)}));old.version=7;delete old.world;delete old.hero.equipment;delete old.hero.artifacts;localStorage.setItem({json.dumps(v7_key)},JSON.stringify(old));localStorage.setItem({json.dumps(v7_key + ".route")},"port");localStorage.removeItem({json.dumps(key)});localStorage.removeItem({json.dumps(route_key)});')
            refresh()
            assert state()['version'] == 9 and state()['hero']['coins'] == 17 and state()['hero']['equipment']['mainHand'] == 'sword'
            assert state()['hero']['defense'] == 5
            assert js(f'return localStorage.getItem({json.dumps(route_key)}) === "port";')
            print('Safari: equipment slots/stats and free changes 1320/390, combat switch/reload, artifact peace and v7 migration OK', flush=True)
            return
        if '--ui-city-events' in sys.argv:
            for width in [1320, 390]:
                request('POST', prefix+'/window/rect', {'width': width, 'height': 920})
                fixture('S12', hero={'coins': 0, 'sword': True, 'attackBonus': 4, 'shield': True, 'defense': 5})
                dice(6)
                click('[data-action="sell-sword"]')
                wait_roll()
                assert state()['hero']['sword'] and state()['hero']['coins'] == 0
                assert state()['lastTrade']['roll'] == 6
                assert js('return document.querySelector("[data-action=sell-sword]").disabled;')
                refresh()
                assert state()['lastTrade']['roll'] == 6
                assert js('return document.querySelector("[data-action=sell-sword]").disabled;')
                snapshot('city-sale-refused-'+str(width))
                dice(1)
                click('[data-action="sell-shield"]')
                wait_roll()
                assert not state()['hero']['shield'] and state()['hero']['coins'] == 2 and state()['hero']['defense'] == 4
                assert state()['hero']['sword']
                fixture('Q09')
                assert move('Q10', 1, 2)['notice']['id'] == 'find'
                dice(2)
                click('[data-action="notice-search"]')
                wait_roll()
                assert state()['notice']['stage'] == 'result' and state()['hero']['finds']['defenseRing'] == 1
                assert state()['hero']['defense'] == 5
                saved = state()
                refresh()
                assert state() == saved
                assert js('return document.getElementById("context").textContent.includes("Кольцо защиты");')
                snapshot('city-notice-ring-'+str(width))
                click('#acknowledge')
                assert state()['ticks'] == 1
                click('#portrait')
                assert js('return document.getElementById("hero-dialog").open && tovilisGame.state.hero.defense === 5 && !!document.querySelector("[data-slot=ring]");')
                js('document.querySelector("[data-slot=ring]").scrollIntoView({block:"center"});')
                snapshot('city-ring-sheet-before-'+str(width))
                click('[data-slot="ring"]')
                assert js('return document.querySelector("[data-slot=ring]").classList.contains("active");')
                snapshot('city-ring-sheet-'+str(width))
                click('#hero-dialog .close')
                bounds = js('return {width: innerWidth, scroll: document.documentElement.scrollWidth};')
                assert bounds['scroll'] <= bounds['width'], bounds
            request('POST', prefix+'/window/rect', {'width': 1320, 'height': 920})
            for index in range(1, 13):
                fixture('Q09', hero={'hp': 10, 'coins': 1})
                current = move('Q10', 1, (index, 12))
                assert current['phase'] == 'notice' and current['pending']['eventRoll'] == index
                action = js('return createTovilisRules(TOVILIS_MAP).noticeCard(tovilisGame.state).actions[0][0];')
                dice(6, 3)
                click(f'[data-action="notice-{action}"]')
                wait_roll()
                healthy()
                assert state()['notice']['stage'] == 'result'
                saved = state()
                refresh()
                assert state() == saved
                click('#acknowledge')
                assert state()['phase'] == 'ready'
                if index == 6:
                    assert state()['hero']['slowMoves'] == 2 and state()['ticks'] == 4
            fixture('S12', hero={'sword': True, 'attackBonus': 4, 'coins': 17})
            js(f'const old=JSON.parse(localStorage.getItem({json.dumps(key)}));old.version=6;delete old.notice;delete old.shopInterest;delete old.lastTrade;for(const k of ["finds","experience","reputation","slowMoves","lore"])delete old.hero[k];localStorage.setItem({json.dumps(v6_key)},JSON.stringify(old));localStorage.setItem({json.dumps(v6_key + ".route")},"port");localStorage.removeItem({json.dumps(key)});localStorage.removeItem({json.dumps(route_key)});')
            refresh()
            assert state()['version'] == 9 and state()['hero']['coins'] == 17 and state()['hero']['sword']
            assert js(f'return localStorage.getItem({json.dumps(route_key)}) === "port";')
            print('Safari: saved shop refusals, neutral-price sales, all 12 city cards, ring slot, results/reload and v6 migration; desktop/mobile OK', flush=True)
            return
        if '--ui-gear' in sys.argv:
            for width in [1320, 390]:
                request('POST', prefix+'/window/rect', {'width': width, 'height': 900})
                fixture('J05', hero={'coins': 20, 'sword': True, 'shield': True, 'attackBonus': 4, 'defense': 5})
                close_place()
                click('#portrait')
                assert js('return document.getElementById("hero-dialog").open && document.querySelectorAll(".gear-slot").length === 7;')
                assert js('return document.querySelector("[data-equipment-slot=mainHand]").textContent.includes("Стальной меч") && document.getElementById("hero-stat-breakdown").textContent.includes("Атака");')
                assert js('return !!document.querySelector("#hero-bag + .inventory-grid [data-item=shortSword]");')
                click('[data-equipment-slot=body]')
                assert js('return document.querySelector("[data-equipment-slot=body]").classList.contains("active") && document.querySelector("#gear-detail").textContent.includes("Требования");')
                if width == 390:
                    assert js('return getComputedStyle(document.getElementById("gear-detail")).display !== "none" && document.getElementById("gear-detail").textContent.includes("Защита +1");')
                snapshot('city-gear-'+str(width))
                click('#hero-dialog .close')
            request('POST', prefix+'/window/rect', {'width': 1320, 'height': 920})
            fixture('Q04', 12, hero={'sword': True, 'attackBonus': 4, 'shield': True, 'defense': 5})
            assert move('Q05', 1, 6)['phase'] == 'encounter'
            assert js('return !!document.querySelector("[data-action=switch-weapon]");')
            dice(6, 1, 1, (5, 5))
            click('[data-action=switch-weapon]')
            wait_roll()
            current=state()
            assert current['phase'] == 'combat' and current['encounter']['round'] == 1
            assert current['hero']['weapon'] == 'shortSword' and current['hero']['attackBonus'] == 3 and current['ticks'] == 12
            assert current['encounter']['report']['switch']['to'] == 'shortSword'
            assert js('return document.getElementById("context").textContent.includes("Действие героя потрачено");')
            refresh()
            assert state()['hero']['weapon'] == 'shortSword'
            print('Safari: full-body equipment slots and tooltips at 1320/390, saved combat weapon switch: OK', flush=True)
            return
        if '--ui-feedback' in sys.argv:
            fixture('Q04'); close_place(); js('document.querySelector(".event-marker")?.dispatchEvent(new MouseEvent("click",{bubbles:true}));'); assert js('return document.getElementById("status").textContent.includes("городская встреча");'); click('[data-direction="Q05"]'); assert js('return document.getElementById("status").textContent === "";')
            js('document.querySelector(".event-marker")?.dispatchEvent(new MouseEvent("click",{bubbles:true}));document.getElementById("status").textContent="Новое сообщение";'); time.sleep(4.6); assert js('return document.getElementById("status").textContent === "Новое сообщение";')
            fixture('U07')
            close_place()
            js(f'localStorage.setItem({json.dumps(route_key)}, "far-shop");')
            refresh()
            close_place()
            assert state()['selection']['next'] == 'J03'
            assert not js('return document.getElementById("roll").disabled;')
            dice(1)
            js('document.getElementById("roll").click()')
            for _ in range(80):
                if js('return !document.getElementById("roll-continue").disabled;'):
                    break
                time.sleep(.03)
            assert js('return document.getElementById("roll-dialog").open && document.getElementById("roll-result").textContent === "Путь свободен";')
            js('document.getElementById("roll-title").click();')
            assert not js('return document.getElementById("roll-dialog").open;')
            arrived = settled()
            assert arrived['position'] == 'J03' and arrived['selection']['next'] == 'U06'
            refresh()
            assert state()['selection']['stopBuilding'] == 'far-shop'
            assert not js('return document.getElementById("roll").disabled;')
            dice(1)
            click('#roll')
            for _ in range(80):
                if js('return !document.getElementById("roll-continue").disabled;'):
                    break
                time.sleep(.03)
            request('POST', prefix+'/actions', {'actions': [{'type': 'pointer', 'id': 'feedback-mouse', 'parameters': {'pointerType': 'mouse'}, 'actions': [
                {'type': 'pointerMove', 'duration': 0, 'x': 10, 'y': 450}, {'type': 'pointerDown', 'button': 0}, {'type': 'pointerUp', 'button': 0}]}]})
            assert not js('return document.getElementById("roll-dialog").open;')
            assert settled()['position'] == 'U06'
            assert js('return document.getElementById("context").textContent.includes("Травы у ворот");')
            assert not js('return document.getElementById("context").textContent.includes("сгора");')
            fixture('J03')
            assert not js('return !!document.querySelector("[data-action=potion]");')
            fixture('U06', hero={'coins': 0, 'potions': 1})
            assert js('return !!document.querySelector("[data-action=sell-potion]");')
            click('[data-action=sell-potion]')
            assert state()['hero']['coins'] == 1 and state()['hero']['potions'] == 0
            fixture('Q09', hero={'hp': 10})
            assert move('Q10', 1, 3)['phase'] == 'notice'
            assert js('return document.getElementById("context").textContent.includes("−2 жизненные силы");')
            click('#acknowledge')
            assert state()['hero']['hp'] == 8
            fixture('Q04')
            assert move('Q05', 1, 6)['phase'] == 'encounter'
            assert js('return document.getElementById("context").textContent.includes("12/12 ЖС") && !!document.querySelector("[data-action=provoke]");')
            click('[data-action=provoke]')
            assert state()['phase'] == 'combat' and state()['encounter']['hostile']
            refresh()
            assert state()['phase'] == 'combat' and js('return !!document.querySelector("[data-action=attack]");')
            print('Safari: dice dismissal, junction route, shop entrance and sale, notice, daytime robber: OK', flush=True)
            return
        if '--ui-reload' in sys.argv:
            fixture('Q01')
            close_place()
            click('[data-direction="Q02"]')
            dice(6)
            assert js('document.getElementById("roll").click();return tovilisGame.state.phase;') == 'moving'
            refresh()
            assert settled()['position'] == 'Q02'
            assert not js('return document.getElementById("scene-dialog").open;')
            print('Reloading a move from a building returns to the map, without reopening the former building: OK', flush=True)
            return
        if '--ui-layout' in sys.argv or '--ui-route-layout' in sys.argv:
            layout_checks([1320,620,390], 'orders' if '--ui-route-layout' in sys.argv else None)
            return
        if '--ui-ux' in sys.argv:
            fixture('J08')
            close_place()
            click('[data-direction="E06"]')
            assert state()['selection']['next'] == 'E06' and state()['phase'] == 'ready'
            assert js('return document.querySelector("[data-direction=E06]").getAttribute("aria-label").includes("ещё раз");')
            click('[data-direction="E06"]')
            assert state()['phase'] == 'moving'
            for _ in range(100):
                if js('return !document.getElementById("roll-continue").disabled;'):
                    break
                time.sleep(.03)
            else:
                raise AssertionError('Dice result did not become visible')
            time.sleep(1.5)
            assert js('return document.getElementById("roll-dialog").open && document.getElementById("roll-result").textContent !== "Кубик катится…";')
            click('#roll-continue')
            settled()
            fixture('J08')
            close_place()
            click('#quest-button')
            click('[data-action="guide-goal"]')
            assert js(f'return localStorage.getItem({json.dumps(route_key)});') == 'orders'
            assert js('return !!document.querySelector(".direction.recommended") && !document.getElementById("route-guide").hidden;')
            refresh()
            assert js('return !!document.querySelector(".direction.recommended") && document.getElementById("route-guide-text").textContent.includes("Заказ");')
            click('#clear-route')
            assert js(f'return localStorage.getItem({json.dumps(route_key)});') is None
            fixture('J05', 12, extra={'quest': 'active'})
            close_place()
            click('#quest-button')
            assert js('return document.getElementById("context").textContent.includes("дневная работа закрыта");')
            fixture('J05', 12, extra={'quest': 'active', 'workLedger': {'day': 1, 'count': 2}})
            close_place()
            click('#quest-button')
            assert js('return document.getElementById("context").textContent.includes("две смены уже выполнены");')
            request('POST', prefix+'/window/rect', {'width': 390, 'height': 769})
            fixture('T03', hero={'hp': 8, 'coins': 5})
            assert js('const d=document.getElementById("scene-dialog"), rest=document.querySelector("[data-action=rest]"), food=document.querySelector(".food-disclosure"); return d.open && rest && rest.getBoundingClientRect().top < innerHeight && food && !food.open;')
            assert js('const d=document.getElementById("scene-dialog"); d.scrollTop=d.scrollHeight; return document.getElementById("scene-close").getBoundingClientRect().top < innerHeight;')
            js(f'localStorage.setItem({json.dumps(key)}, "{{bad json");')
            request('POST', prefix+'/refresh', {})
            assert js('return !document.getElementById("save-error").hidden && !document.getElementById("export-save").disabled;')
            click('#reset-from-error')
            click('#confirm-reset')
            healthy()
            assert state()['position'] == 'U07'
            fixture('P02', extra={'quest': 'complete', 'phase': 'won'})
            assert js('return document.getElementById("scene-dialog").open;')
            click('#context .context-actions button:last-child')
            click('#confirm-reset')
            assert state()['position'] == 'U07' and state()['quest'] == 'none'
            assert js('return document.getElementById("scene-dialog").open && document.getElementById("context").textContent.includes("Первое поручение");')
            print('Double-click direction, persistent dice result, route, quest, mobile tavern, save recovery: OK', flush=True)
            return
        fixture()
        click('#menu-button')
        click('#new-game')
        click('#confirm-reset')
        assert state()['position'] == 'U07' and state()['ticks'] == 0
        assert js('return !document.querySelector("[data-action=view-first-order]").disabled;')
        snapshot('city-start')
        close_place()
        snapshot('city-map-controls')
        fixture()
        assert js('return document.getElementById("roll").disabled;')
        assert js('return document.querySelectorAll(".reveal-cell").length >= 15;')
        assert js('return getComputedStyle(document.querySelector(".reveal-cell")).display !== "none";')
        click('[data-direction="E06"]')
        assert js('return document.getElementById("hero-sprite").dataset.facing;') == state()['facing']
        dice(6)
        pending = js('document.getElementById("roll").click(); return {live:tovilisGame.state,saved:JSON.parse(localStorage.getItem("crimsonworld.tovilis.game.v9"))};')
        assert pending['live']['phase'] == 'moving' and pending['live'] == pending['saved'], pending
        refresh()
        result = settled()
        assert (result['position'], result['ticks']) == ('E01', 1)
        assert result['selection']['next'] == 'J07'
        assert not js('return document.getElementById("roll").disabled;')
        dice(6)
        click('#roll')
        result = settled()
        assert result['position'] == 'J07' and result['lastMove']['unused'] == 5
        assert result['selection'] is None
        print('Movement, reload, automatic street continuation and junction choice: OK', flush=True)

        fixture('A03')
        click('#find-hero')
        before_facing = js('return document.getElementById("hero-sprite").getAttribute("viewBox");')
        click('[data-direction="A04"]')
        one = js('return document.getElementById("hero-sprite").getAttribute("viewBox");')
        click('[data-direction="A02"]')
        two = js('return document.getElementById("hero-sprite").getAttribute("viewBox");')
        assert one != two
        snapshot('city-west-revealed')
        print('Directional sprite and revealed west cells: OK', flush=True)

        fixture('Q02', 12)
        assert move('Q03', 3, 6)['phase'] == 'encounter'
        assert state()['position'] == 'Q05' and state()['encounter']['kind'] == 'robber'
        assert js('return document.getElementById("roll").disabled && !document.querySelector("[data-action=pass]");')
        assert not js('return !!document.getElementById("stop-target");')
        service('surrender')
        click('#confirm-surrender')
        click('#acknowledge')
        fixture('Q02')
        assert move('Q03', 6)['position'] == 'Q08'
        assert state()['phase'] == 'ready'
        print('Random encounter landing is mandatory; passing a V cell does not trigger it: OK', flush=True)

        fixture('Q09', 5)
        assert move('Q10', 1, 3)['phase'] == 'notice'
        before = state()
        refresh()
        assert state() == before
        assert js('const d=document.getElementById("scene-dialog"),r=d.getBoundingClientRect();return d.open && Math.abs((r.left+r.right)/2-innerWidth/2)<3 && getComputedStyle(document.querySelector("#context p")).fontSize === "18px";')
        snapshot('city-notice-centre')
        js('document.getElementById("scene-dialog").dispatchEvent(new Event("cancel",{cancelable:true}));')
        assert state() == before and js('return document.getElementById("scene-dialog").open;')
        click('[data-action="notice-continue"]')
        js('const b=document.getElementById("acknowledge"); b.click(); b.click();')
        assert (state()['hero']['coins'], state()['hero']['hp'], state()['hero']['food'], state()['ticks']) == (1, 14, 3, 6)
        assert '−1 порция еды' in js('return document.getElementById("status").textContent;')
        print('Centred notice, one-time confirmation and visible meal expense: OK', flush=True)

        fixture('Q04', 12, {'coins': 5})
        assert move('Q05', 1, 5, 6)['phase'] == 'encounter'
        assert len(state()['encounter']['enemies']) == 2
        snapshot('city-encounter')
        click('[data-enemy="enemy-2"]')
        dice(6, 1, 1, 6, (1, 2), 2, (4, 4))
        service('attack')
        first_round = state()
        assert first_round['phase'] == 'combat'
        assert first_round['encounter']['enemies'][1]['hp'] == 0
        assert first_round['ticks'] == 12
        refresh()
        assert state() == first_round
        snapshot('city-combat')
        dice(6, 1, 6, (1, 2))
        service('attack')
        assert state()['outcome']['kind'] == 'victory'
        assert state()['hero']['coins'] == 9
        before = state()
        refresh()
        assert state() == before
        js('const b=document.getElementById("acknowledge"); b.click(); b.click();')
        assert state()['hero']['coins'] == 9 and state()['ticks'] == 13
        print('Two-enemy fight, chosen target, save/reload and one-time victory reward: OK', flush=True)

        fixture('Q04', 12, {'coins': 3})
        move('Q05', 1, 6)
        service('pay')
        assert state()['hero']['coins'] == 0
        click('#acknowledge')
        assert state()['phase'] == 'ready'
        fixture('Q04', 12, {'hp': 6})
        move('Q05', 1, 5, 1)
        dice(6, 1, 6, (1, 4))
        service('battle-potion')
        assert state()['hero']['potions'] == 0 and state()['hero']['hp'] == 5
        dice(3)
        service('flee')
        assert state()['position'] == 'Q04'
        click('#acknowledge')
        assert state()['phase'] == 'ready'
        fixture('Q04', 12, {'hp': 1, 'coins': 5, 'net': True}, {'quest': 'active'})
        move('Q05', 1, 6)
        dice(1, 6, 6, (1, 4))
        service('attack')
        assert state()['outcome']['kind'] == 'defeat'
        assert (state()['position'], state()['hero']['hp'], state()['hero']['coins'], state()['hero']['net']) == ('T03', 8, 2, True)
        snapshot('city-defeat')
        click('#acknowledge')
        assert js('return !!document.querySelector("[data-action=rest]");')
        print('Ransom, potion, escape and defeat with protected net: OK', flush=True)

        fixture('Q04', 0, {'coins': 5})
        move('Q05', 1, 1)
        service('encounter-buy')
        assert state()['hero']['potions'] == 2 and state()['hero']['coins'] == 2
        click('#acknowledge')
        fixture('Q04', 0)
        move('Q05', 1, 5, 6)
        assert not js('return !!document.querySelector("[data-action=attack]");')
        service('pass')
        assert state()['phase'] == 'ready'
        print('Merchant and peaceful daytime bandits: OK', flush=True)

        fixture('Q01', 0)
        service('quest')
        fixture('A06', 0, extra={'quest': 'active'})
        service('hire')
        service('family')
        assert js('return document.getElementById("family-dialog").open;')
        snapshot('city-miller-family')
        click('#family-dialog [data-close].primary')
        dice(6)
        service('work-mill')
        dice(4)
        service('work-mill')
        assert state()['hero']['coins'] == 6 and state()['ticks'] == 6
        saved_mill = state()
        refresh()
        assert state() == saved_mill
        snapshot('city-mill')
        assert js('return document.querySelector("[data-action=work-mill]").disabled;')
        before = state()
        js('document.querySelector("[data-action=work-mill]").click();')
        assert state() == before
        close_place()
        click('#places-button')
        click('[data-place="shop"]')
        assert js('return document.querySelector("#context h2").textContent;') == 'Снасти и припасы'
        service('guide-place')
        assert state()['selection'] is not None
        open_place()
        assert js('return document.querySelector("#context h2").textContent;') == 'Ветряная мельница'
        print('Quest, daughters, employment and paid shifts: OK', flush=True)
        fixture('A06', 4, extra={'millJob': True})
        before = state()
        click('[data-action=work-mill]')
        assert state()['hero']['coins'] == before['hero']['coins'] and state()['ticks'] == 4
        refresh()
        assert state()['phase'] == 'work'
        service('cancel-work')
        assert state()['hero']['coins'] == before['hero']['coins'] and state()['ticks'] == 4
        click('[data-action=work-mill]')
        dice(5)
        js('const b=document.querySelector("[data-action=perform-work]"); b.click(); b.click();')
        healthy()
        assert state()['phase'] == 'work-result' and state()['hero']['coins'] == 4 and state()['ticks'] == 7
        assert state()['hero']['food'] == 3 and state()['job']['foodUsed'] == 1
        snapshot('city-work-receipt')
        saved = state()
        refresh()
        assert state() == saved
        js('const b=document.getElementById("acknowledge"); b.click(); b.click();')
        assert state()['hero']['coins'] == 4 and state()['workLedger']['count'] == 1
        print('Work preview, cancellation, cap, saved result and one-time pay: OK', flush=True)


        fixture('S12', 12, {'coins': 20})
        assert js('return document.querySelector("[data-action=net]").disabled;')
        snapshot('city-closed-shop')
        fixture('S12', 14, {'coins': 20, 'food': 1, 'hp': 5})
        label = js('return document.querySelector("[data-action=wait-opening]").textContent;')
        assert '4 х.' in label and 'еда: −1' in label, label
        snapshot('city-wait-opening')
        js('const b=document.querySelector("[data-action=wait-opening]"); b.click(); b.click();')
        healthy()
        assert state()['ticks'] == 18 and state()['turn'] == 0 and state()['position'] == 'S12'
        assert state()['hero']['food'] == 0 and state()['hero']['hp'] == 5
        assert not js('return document.querySelector("[data-action=net]").disabled;')
        saved_wait = state()
        refresh()
        assert state() == saved_wait
        fixture('J05', 17, {'coins': 20, 'food': 0, 'hp': 2})
        assert 'голод: −1 ЖС' in js('return document.querySelector("[data-action=wait-opening]").textContent;')
        service('wait-opening')
        assert state()['hero']['hp'] == 1 and state()['ticks'] == 18
        print('Wait at the door: exact food/hunger preview, no healing, no repeated time cost: OK', flush=True)
        fixture('J05', 12, {'coins': 20})
        assert js('return document.querySelector("[data-action=sword]").disabled;')
        fixture('T03', 17, {'coins': 2, 'hp': 5, 'food': 1})
        service('morning')
        assert state()['ticks'] == 18 and state()['hero']['hp'] == 5 and state()['hero']['food'] == 0
        service('rest')
        assert state()['hero']['hp'] == 12 and state()['ticks'] == 24
        fixture('S12', 0, {'coins': 6}, {'quest': 'active'})
        service('net')
        assert state()['hero']['net']
        saved_shop = state()
        refresh()
        assert state() == saved_shop
        fixture('P02', 12, {'coins': 1, 'net': True}, {'quest': 'active'})
        service('deliver')
        assert state()['phase'] == 'won' and state()['hero']['coins'] == 11 and not state()['hero']['net']
        snapshot('city-victory')
        refresh()
        assert state()['hero']['coins'] == 11
        assert js('return !document.getElementById("scene-close").hidden;')
        click('#scene-close')
        assert state()['phase'] == 'ready' and state()['quest'] == 'complete'
        assert not js('return document.getElementById("scene-dialog").open;')
        click('#quest-button')
        assert js('return document.getElementById("context").textContent.includes("Заказ выполнен") && !document.querySelector("[data-action=guide-goal]");')
        close_place()
        print('Night hours, food, wait, rest, net purchase and night delivery: OK', flush=True)
        # Land normally, without selecting a building stop: both taverns open immediately.
        for origin, direction, target, name, pack, ale_cost, ale_heal, max_stake in [('T02','T03','T03','«Солёный якорь» · дальняя таверна',3,1,1,2),('R15','R16','R16','«Золотой фонарь» · ближняя таверна',2,2,2,3)]:
            fixture(origin, 12, {'coins':10,'hp':8})
            assert move(direction, 1)['position'] == target
            assert state()['ticks'] == 13 and state()['turn'] == 1
            assert js('return document.getElementById("scene-dialog").open;')
            assert js('return document.querySelector("#context h2").textContent;') == name.split(' · ')[0]
            assert js('return document.getElementById("coins").textContent;') == '10'
            assert js('return document.querySelector("[data-action=food]").disabled;') is False
            js('const q=document.getElementById("food-quantity");q.value="3";q.dispatchEvent(new Event("input",{bubbles:true}));')
            assert 'Останется монет: 7' in js('return document.getElementById("food-total").textContent;')
            before = state()
            service('food')
            assert state()['hero']['coins'] == 7 and state()['hero']['food'] == 4 + 3 * pack
            assert state()['ticks'] == before['ticks'] and state()['turn'] == before['turn']
            assert js('return document.getElementById("coins").textContent;') == '7'
            snapshot('tavern-'+target)
            service('ale')
            assert state()['hero']['coins'] == 7 - ale_cost and state()['hero']['hp'] == 8 + ale_heal and state()['ticks'] == 14
            dice(2)
            service('find-dice')
            assert state()['tavernGame']['stage'] == 'empty' and state()['ticks'] == 15
            saved = state(); refresh(); assert state() == saved
            click('#acknowledge')
            dice(6)
            service('find-dice')
            assert state()['tavernGame']['stage'] == 'found'
            saved = state(); refresh(); assert state() == saved
            js(f'document.getElementById("dice-stake").value={max_stake};')
            dice(6, 1)
            js('const b=document.querySelector("[data-action=play-dice]");b.click();b.click();')
            healthy()
            assert state()['tavernGame']['stage'] == 'result' and state()['hero']['coins'] == 8
            assert state()['ticks'] == 17
            saved = state(); refresh(); assert state() == saved
            snapshot('tavern-dice-'+target)
            js('const b=document.getElementById("acknowledge");b.click();b.click();')
            assert state()['hero']['coins'] == 8 and state()['ticks'] == 17
        fixture('R16', 17, {'coins':0})
        assert js('return document.querySelector("[data-action=food]").disabled;')
        dice(4)
        service('find-dice')
        assert js('return document.querySelector("[data-action=play-dice]").disabled;')
        click('#acknowledge')
        print('Both taverns: automatic entry, bulk food without time cost, visible wallet, ale and saved dice games: OK', flush=True)


        fixture()
        before = state()
        js('window.__setItem=Storage.prototype.setItem; Storage.prototype.setItem=function(){throw Error("Test full");};')
        click('[data-direction="E06"]')
        assert state() == before
        assert not js('return document.getElementById("save-error").hidden;')
        js('Storage.prototype.setItem=window.__setItem;')
        click('#retry-save')
        healthy()
        js(f'const s=createTovilisRules(TOVILIS_MAP).create(); s.version=1; s.hero.hp=7; s.hero.name="Грим"; s.position="J08"; localStorage.setItem({json.dumps(old_key)},JSON.stringify(s)); localStorage.removeItem({json.dumps(key)});localStorage.removeItem({json.dumps(v5_key)});localStorage.removeItem({json.dumps(v4_key)}); localStorage.removeItem({json.dumps(previous_key)}); localStorage.removeItem({json.dumps(second_key)});')
        refresh()
        assert state()['position'] == 'J08'
        assert state()['hero']['name'] == 'Грим' and state()['hero']['hp'] == 7
        assert js(f'return JSON.parse(localStorage.getItem({json.dumps(old_key)})).version;') == 1
        js(f'const s=createTovilisRules(TOVILIS_MAP).create(); s.version=2;s.position="J08";s.hero.coins=17;delete s.workLedger;delete s.job;delete s.tavernGame;localStorage.setItem({json.dumps(second_key)},JSON.stringify(s));localStorage.removeItem({json.dumps(key)});localStorage.removeItem({json.dumps(v5_key)});localStorage.removeItem({json.dumps(v4_key)});localStorage.removeItem({json.dumps(previous_key)});')
        refresh()
        assert state()['version'] == 9 and state()['hero']['coins'] == 17 and state()['position'] == 'J08'
        assert js(f'return JSON.parse(localStorage.getItem({json.dumps(second_key)})).version;') == 2
        js(f'const s=createTovilisRules(TOVILIS_MAP).create();s.version=3;s.position="R16";s.hero.coins=13;s.workLedger.count=1;delete s.tavernGame;localStorage.setItem({json.dumps(previous_key)},JSON.stringify(s));localStorage.removeItem({json.dumps(key)});localStorage.removeItem({json.dumps(v5_key)});localStorage.removeItem({json.dumps(v4_key)});')
        refresh()
        assert state()['version'] == 9 and state()['position'] == 'R16' and state()['hero']['coins'] == 13
        assert state()['workLedger']['count'] == 1
        assert js(f'return JSON.parse(localStorage.getItem({json.dumps(previous_key)})).version;') == 3
        print('Storage failure and migration of previous game without changing original: OK', flush=True)

        fixture()
        click('#zoom-in')
        assert js('return tovilisGame.view[2] < 1448;')
        close_place()
        click('#whole-map')
        rect = js('const r=document.getElementById("game-map").getBoundingClientRect(); return {x:Math.round(r.x+r.width*.4),y:Math.round(r.y+r.height*.3)};')
        initial = js('return tovilisGame.view;')
        if '--ui-dom-click' not in sys.argv:
            request('POST', prefix+'/actions', {'actions': [{'type': 'pointer', 'id': 'game-mouse', 'parameters': {'pointerType': 'mouse'}, 'actions': [
                {'type': 'pointerMove', 'duration': 0, 'x': rect['x'], 'y': rect['y']}, {'type': 'pointerDown', 'button': 0},
                {'type': 'pointerMove', 'duration': 250, 'x': rect['x']+55, 'y': rect['y']+25}, {'type': 'pointerUp', 'button': 0}]}]})
            assert js('return tovilisGame.view;') != initial
        for width in [620, 390]:
            request('POST', prefix+'/window/rect', {'width': width, 'height': 900})
            fixture()
            bounds = js('const r=document.getElementById("roll").getBoundingClientRect(); return {width:innerWidth,scroll:document.documentElement.scrollWidth,bottom:r.bottom,height:innerHeight};')
            assert bounds['scroll'] <= bounds['width'] and bounds['bottom'] <= bounds['height'], bounds
            snapshot('city-narrow-'+str(width))
            move('E06', 2, 2)
            click('#acknowledge')
            assert state()['ticks'] == 1
        layout_checks([390])
        fixture('S08')
        close_place()
        click('[data-direction="S09"]')
        click('#stop-building')
        bounds = js('const r=document.getElementById("building-target").getBoundingClientRect(); return {left:r.left,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight};')
        assert 0 <= bounds['left'] < bounds['right'] <= bounds['width'] and bounds['bottom'] <= bounds['height'], bounds
        snapshot('city-narrow-building-stop')
        fixture('S12', 14, {'coins': 5, 'food': 1})
        bounds = js('const r=document.querySelector("[data-action=wait-opening]").getBoundingClientRect(); return {top:r.top,bottom:r.bottom,height:innerHeight};')
        assert 0 <= bounds['top'] < bounds['bottom'] <= bounds['height'], bounds
        snapshot('city-narrow-wait')
        service('wait-opening')
        service('net')
        assert state()['hero']['net'] and state()['ticks'] == 18
        fixture('R16', 12, {'coins':8})
        assert js('const r=document.getElementById("coins").getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;')
        snapshot('tavern-mobile')
        fixture('Q04', 12)
        move('Q05', 1, 5, 6)
        snapshot('city-narrow-combat')
        bounds = js('const r=document.querySelector("[data-action=attack]").getBoundingClientRect(); return {top:r.top,bottom:r.bottom,height:innerHeight};')
        assert 0 <= bounds['top'] < bounds['bottom'] <= bounds['height'], bounds
        assert js('return Number(document.getElementById("night-tint").getAttribute("opacity")) > .3;')
        service('surrender')
        click('#confirm-surrender')
        assert state()['outcome']['kind'] == 'defeat'
        print(('Zoom, always-visible roll, narrow-screen notice and combat: OK (pointer drag not checked by DOM-click mode)' if '--ui-dom-click' in sys.argv else 'Pan/zoom, always-visible roll, narrow-screen notice and combat: OK'), flush=True)

        # Play the entire order on the real graph through browser buttons.
        request('POST', prefix+'/window/rect', {'width': 1320, 'height': 920})
        click('#acknowledge')
        close_place()
        click('#menu-button')
        click('#new-game')
        click('#confirm-reset')

        def complete_event():
            phase = state()['phase']
            if phase in ('notice', 'outcome'):
                click('#acknowledge')
            elif phase == 'encounter':
                service('pass')  # These deterministic route checks meet the soldier.

        def travel(target):
            for _ in range(80):
                if state()['position'] == target:
                    return
                option = js(f'const r=createTovilisRules(TOVILIS_MAP),s=tovilisGame.state,p=r.shortestPath(s.position,{json.dumps(target)}),o=r.directions(s.position).find(d=>d.next===p[1]); return {{next:p[1],target:o.building?.cell==={json.dumps(target)},building:o.building?.id}};')
                close_place()
                if state()['selection'] is None or state()['selection']['next'] != option['next']:
                    click(f'[data-direction="{option["next"]}"]')
                if option['target']:
                    click('#stop-building')
                dice(6, 4)
                click('#roll')
                settled()
                complete_event()
            raise AssertionError('Browser route did not arrive')

        def day_at_current_place():
            if state()['ticks'] % 18 >= 12:
                service('wait-opening')

        assert state()['position'] == 'U07'
        travel('Q01')
        service('quest')
        travel('A06')
        day_at_current_place()
        service('hire')
        dice(6)
        service('work-mill')
        day_at_current_place()
        dice(4)
        service('work-mill')
        travel('S12')
        day_at_current_place()
        service('net')
        travel('P02')
        service('deliver')
        assert state()['phase'] == 'won'
        snapshot('city-complete-playthrough')
        won_turn = state()['turn']
        click('#acknowledge')
        assert state()['phase'] == 'ready' and state()['quest'] == 'complete' and not js('return document.getElementById("scene-dialog").open;')
        next_cell = js('return createTovilisRules(TOVILIS_MAP).directions(tovilisGame.state.position)[0].next;')
        click(f'[data-direction="{next_cell}"]')
        dice(1, 4)
        click(f'[data-direction="{next_cell}"]')
        settled()
        complete_event()
        assert state()['turn'] == won_turn + 1
        print('Complete browser playthrough:', {k: state()[k] for k in ['phase', 'turn', 'ticks', 'quest']}, flush=True)
    finally:
        for k, original in originals.items():
            if original is None:
                js(f'localStorage.removeItem({json.dumps(k)});')
            else:
                js(f'localStorage.setItem({json.dumps(k)}, {json.dumps(original)});')

class _ApiClient:
    """Disposable HTTP fixture client; browser verification remains WebDriver."""
    def __init__(self, base): self.base, self.cookies = base.rstrip('/'), {}
    def call(self, path, method='GET', payload=None):
        data = None if payload is None else json.dumps(payload).encode()
        headers = {'Content-Type':'application/json'}
        if self.cookies: headers['Cookie'] = '; '.join(f'{k}={v}' for k,v in self.cookies.items())
        if 'cw_csrf' in self.cookies: headers['X-CSRF-Token'] = self.cookies['cw_csrf']
        req = urllib.request.Request(self.base+path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                for value in response.headers.get_all('Set-Cookie') or []:
                    first = value.split(';',1)[0]
                    if '=' in first:
                        name, token = first.split('=',1)
                        if name in ('cw_session','cw_csrf'): self.cookies[name] = token
                return json.loads(response.read() or b'{}')
        except urllib.error.HTTPError as error:
            raise AssertionError(error.read().decode(errors='replace')) from error


def check_online(request, prefix, js, click, snapshot, root):
    """Real Safari online smoke: UI creates Alice, then logs into prepared Bob."""
    base = os.environ.get('TOVILIS_ONLINE_URL','http://127.0.0.1:8000')
    if not base.startswith(('http://127.0.0.1:', 'http://localhost:')): raise AssertionError('online Safari QA only permits localhost')
    qa_db = os.environ.get('TOVILIS_QA_DB')
    if not qa_db: raise AssertionError('set TOVILIS_QA_DB to an isolated QA SQLite database')
    from server.core import Store
    invites = Store(qa_db).create_invites(count=3, days=1, label='safari-online-qa')
    suffix, password = uuid.uuid4().hex[:10], 'LocalQA-password-123'
    alice_login, bob_login = f'alice-{suffix}', f'bob-{suffix}'
    bob = _ApiClient(base)
    bob.call('/api/auth/register','POST',{'username':bob_login,'password':password,'inviteCode':invites[1][1]})
    bob_user = bob.call('/api/me').get('user',{})
    bob_state = bob.call('/api/commands','POST',{'commandId':str(uuid.uuid4()),'method':'createCharacter','args':{'profile':{'name':'Боб QA','sex':'male','race':'elf','origin':'highElf','class':'warrior'}},'revision':0})
    bob.call('/api/world/presence')
    bob_id = bob_user.get('id'); assert bob_id, bob_user
    request('POST',prefix+'/window/rect',{'width':1320,'height':920}); request('POST',prefix+'/url',{'url':base+'/#invite='+invites[0][1]})
    def wait(expression,label):
        for _ in range(160):
            if js('return '+expression): return
            time.sleep(.05)
        raise AssertionError(label)
    def fill(selector,value):
        found=request('POST',prefix+'/element',{'using':'css selector','value':selector}); eid=found['element-6066-11e4-a52e-4f735466cecf']
        request('POST',prefix+'/element/'+eid+'/clear',{}); request('POST',prefix+'/element/'+eid+'/value',{'text':value})
    def logout_ui(label):
        js('document.getElementById("menu-button")?.click();'); wait('!!document.querySelector("#online-menu-logout")','menu logout button did not appear'); click('#online-menu-logout')
        wait('!!document.querySelector("#online-login-form")',label)
    wait('!!document.querySelector("#online-panel")','auth panel did not appear')
    wait('!!document.querySelector("#online-register-form")','invite did not open registration')
    assert js('return document.querySelector("#online-invite").value === '+json.dumps(invites[0][1])), js('return document.querySelector("#online-invite").value')
    fill('#online-invite','bad-code'); fill('#online-username',alice_login); fill('#online-password',password); click('#online-register-form button.primary')
    wait('document.querySelector("#online-error")?.textContent.length > 0','invalid invite was not rejected')
    assert js('return document.querySelector("#online-username").value === '+json.dumps(alice_login)+' && document.querySelector("#online-invite").value === "bad-code"')
    # Re-open the invitation link so the successful path exercises the real
    # fragment prefill instead of a test helper silently replacing it.
    request('POST',prefix+'/url',{'url':'about:blank'})
    request('POST',prefix+'/url',{'url':base+'/#invite='+invites[0][1]})
    wait('!!document.querySelector("#online-register-form")','registration form did not reopen from invite link')
    prefill = js('return {value:document.querySelector("#online-invite")?.value,hash:location.hash,href:location.href};')
    print('Invite reopen:', prefill, flush=True)
    assert prefill['value'] == invites[0][1] and prefill['hash'] == ''
    fill('#online-username',alice_login); fill('#online-password',password); click('#online-register-form button.primary')
    wait('!!document.querySelector("#character-form")','character creator did not appear')
    fill('#character-name','Алиса QA')
    js('for(const [id,value] of [["character-sex","female"],["character-race","human"],["character-origin","north"]]){const e=document.getElementById(id);e.value=value;e.dispatchEvent(new Event("change",{bubbles:true}));}')
    wait('!!document.querySelector("#character-form button.primary") && !document.querySelector("#character-form button.primary").disabled','character form did not become submittable')
    click('#character-form button.primary'); wait('document.body.classList.contains("online-ready")','Alice game did not load')
    click('.online-actions button:first-child'); wait('!!document.querySelector("#online-chat-form")','community panel did not open')
    fill('#online-chat-input','Safari WebDriver chat'); click('#online-chat-form button'); wait('document.querySelector("#online-chat")?.textContent.includes("Safari WebDriver chat")','chat did not render')
    click('.online-panel .close'); click('.online-actions button:nth-child(2)'); wait('!!document.querySelector("#feedback-form")','feedback panel did not open')
    assert js('return !!document.querySelector("#feedback-description") && !document.querySelector("#feedback-title") && !document.querySelector("#feedback-kind") && !document.querySelector("#feedback-expected") && !document.querySelector("#feedback-actual")')
    fill('#feedback-description','Удобное сообщение Safari QA\nВторая строка для проверки заголовка.'); click('#feedback-form button.primary'); wait('document.querySelector(".feedback-success")?.textContent.includes("сохранено")','feedback was not saved')
    assert js('return document.querySelector("#feedback-description").value === "" && document.querySelector("#feedback-list")?.textContent.includes("Удобное сообщение Safari QA")')
    click('.online-panel .close')
    print('Trade fixture:', js('return {recipient:document.querySelector("#trade-recipient")?.value,options:[...document.querySelectorAll("#trade-recipient option")].map(x=>x.value),phase:window.TovilisOnline?.state?.game?.phase,position:window.TovilisOnline?.state?.game?.position};'), bob_state.get('state',{}).get('phase'), bob_state.get('state',{}).get('position'), flush=True)
    js('const s=document.querySelector("#trade-recipient");s.value='+json.dumps(str(bob_id))+';s.dispatchEvent(new Event("change",{bubbles:true}));'); click('#trade-form button'); wait('document.querySelector("#online-offers")?.textContent.includes("Передают")','trade offer was not shown')
    click('.online-panel .close'); logout_ui('logout did not return to login')
    fill('#online-login',bob_login); fill('#online-password',password); click('#online-login-form button.primary'); wait('document.body.classList.contains("online-ready")','Bob login failed')
    click('.online-actions button:first-child'); wait('!!document.querySelector("#online-offers")','community did not reopen')
    assert js('return document.querySelector("#online-offers")?.textContent.includes("Передают: 1 монет")')
    request('POST',prefix+'/window/rect',{'width':390,'height':844})
    bounds=js('const b=document.querySelector(".online-panel");return {width:innerWidth,scroll:document.documentElement.scrollWidth,panel:b?.getBoundingClientRect().width};')
    assert bounds['scroll']<=bounds['width'], bounds; snapshot('online-community-390')
    click('.trade-offer button'); time.sleep(.2)
    offers=bob.call('/api/trades/offers').get('offers',[]); assert any(item.get('status')=='accepted' for item in offers), offers
    reset_code = Store(qa_db).issue_reset(bob_login); assert reset_code
    click('.online-panel .close'); logout_ui('Bob logout failed')
    click('#online-recover'); fill('#forgot-login',bob_login); click('#forgot-form button.primary'); wait('!!document.querySelector("#reset-form")','recovery form did not open')
    fill('#reset-token',reset_code); fill('#reset-password','LocalQA-password-456'); fill('#reset-password-repeat','LocalQA-password-456'); click('#reset-form button.primary'); wait('!!document.querySelector("#online-login-form")','recovery did not return to login')
    fill('#online-login',bob_login); fill('#online-password','LocalQA-password-456'); click('#online-login-form button.primary'); wait('document.body.classList.contains("online-ready")','login with recovered password failed')
    logout_ui('post-recovery logout failed')
    click('#online-register'); fill('#online-username','repeat-'+suffix); fill('#online-password',password); fill('#online-invite',invites[0][1]); click('#online-register-form button.primary')
    wait('document.querySelector("#online-error")?.textContent.length > 0','used invite was not rejected')
    assert js('return document.querySelector("#online-username").value === '+json.dumps('repeat-'+suffix)+' && document.querySelector("#online-invite").value === '+json.dumps(invites[0][1]))
    fill('#online-username','url-'+suffix); fill('#online-invite','https://example.test/#invite='+invites[2][1]); click('#online-register-form button.primary')
    wait('!!document.querySelector("#character-form")','full invite URL was not accepted')
    print('Safari WebDriver: invite prefill/submit, invalid and reused invite errors, full invite URL, login, character creator, chat, transfer preview/accept, recovery, mobile logout and 390px overflow check OK',flush=True)


def check_find_art(request, prefix, js, click, snapshot, root):
    """Check all six identified finds and an old pending result in real Safari."""
    key = 'crimsonworld.tovilis.game.v9'
    request('POST', prefix+'/url', {'url': (root/'game/index.html').as_uri()})
    original = js('return localStorage.getItem('+json.dumps(key)+');')

    def fixture(roll):
        # Build the event through the rules, including its saved dice. No new
        # schema field is needed for a result created before illustrations.
        return js('''const r=createTovilisRules(TOVILIS_MAP),s=r.create();
          s.position='Q09';s.hero.finds={glass:2,chrysoberyl:3};
          const values=[1,r.content.cityNotices.findIndex(n=>n.id==='find')+1];
          let n=r.arrive(r.begin(r.choose(s,'Q10'),()=>values.shift()));
          if ('''+str(roll)+''') n=r.noticeAction(n,'search',()=>'''+str(roll)+''');
          r.validate(n);localStorage.setItem('''+json.dumps(key)+''',JSON.stringify(n));
          return n;''')

    def refresh():
        request('POST', prefix+'/refresh', {})
        for _ in range(100):
            if js('return !!window.tovilisGame && document.getElementById("scene-dialog").open;'):
                break
            time.sleep(.05)
        assert js('return document.getElementById("save-error").hidden;')

    ids = ['glass','defenseRing','caneKnob','platinumRing','almaMedallion','chrysoberyl']
    try:
        for width in (1320,390):
            request('POST',prefix+'/window/rect',{'width':width,'height':920 if width==1320 else 844})
            fixture(0); refresh()
            assert js('return !document.querySelector(".found-item-art");'), 'Find was revealed before the search'
            for roll, ident in enumerate(ids,1):
                saved=fixture(roll); refresh()
                observed=js('''const a=document.querySelector('.found-item-art'),b=a?.getBoundingClientRect(),p=document.getElementById('scene-dialog').getBoundingClientRect();
                  return {id:a?.dataset.itemId,label:a?.getAttribute('aria-label'),image:a?.querySelector('image')?.getAttribute('href'),viewBox:a?.getAttribute('viewBox'),width:b?.width,height:b?.height,
                    inside:!!b&&b.left>=p.left&&b.right<=p.right,overflow:document.documentElement.scrollWidth>innerWidth};''')
                assert observed['id']==ident, observed
                assert observed['image']=='../assets/illustrations/finds-v2.png', observed
                assert observed['viewBox']==f'{(roll-1)%3*512} {(roll-1)//3*512} 512 512', observed
                assert saved['notice']['text'].split('. ')[0].removeprefix('Найдено: ') in observed['label'], observed
                assert abs(observed['width']-observed['height'])<1 and observed['inside'] and not observed['overflow'], observed
                assert js('return tovilisGame.state.notice.stage === "result";')
                if ident=='almaMedallion': snapshot('identified-alma-'+str(width))
                click('#acknowledge')
                assert js('return tovilisGame.state.notice === null && !document.querySelector(".found-item-art");')
        print('Safari: six identified find illustrations, hidden before search, existing saved results, correct atlas crops, square art and 1320/390 bounds OK',flush=True)
    finally:
        if original is None: js('localStorage.removeItem('+json.dumps(key)+');')
        else: js('localStorage.setItem('+json.dumps(key)+','+json.dumps(original)+');')

def check_online_feedback(request, prefix, js, click, snapshot, root):
    """Focused isolated online UI check for the one-field feedback flow."""
    from server.core import Store
    qa_db=os.environ['TOVILIS_QA_DB']; base=os.environ.get('TOVILIS_ONLINE_URL','http://127.0.0.1:18782').rstrip('/')
    suffix=str(int(time.time()))[-6:]; login='feedbackqa_'+suffix; password='Feedback-QA-20261016!'; invite=Store(qa_db).create_invites(1,1,'online-feedback-qa')[0][1]
    def wait(expr,label):
        for _ in range(180):
            if js('return '+expr): return
            time.sleep(.1)
        raise AssertionError(label)
    def fill(selector,value):
        found=request('POST',prefix+'/element',{'using':'css selector','value':selector}); eid=found['element-6066-11e4-a52e-4f735466cecf']; request('POST',prefix+'/element/'+eid+'/clear',{}); request('POST',prefix+'/element/'+eid+'/value',{'text':value})
    request('POST',prefix+'/window/rect',{'width':1320,'height':920}); request('POST',prefix+'/url',{'url':base+'/#invite='+invite}); wait('!!document.querySelector("#online-register-form")','registration form')
    assert js('return document.querySelector("#online-invite").value === '+json.dumps(invite)+' && location.hash === ""')
    fill('#online-username',login); fill('#online-password',password); click('#online-register-form button.primary'); wait('!!document.querySelector("#character-form")','character form')
    fill('#character-name','Feedback QA'); click('#character-form button.primary'); wait('document.body.classList.contains("online-ready")','online game')
    js('document.querySelector(".online-actions button:nth-child(2)")?.click();'); wait('!!document.querySelector("#feedback-form")','feedback form')
    assert js('return !!document.querySelector("#feedback-description") && !document.querySelector("#feedback-title") && !document.querySelector("#feedback-kind") && !document.querySelector("#feedback-expected") && !document.querySelector("#feedback-actual")')
    fill('#feedback-description','Safari feedback QA\nПроверка генерации заголовка.'); js('document.querySelector("#feedback-form button.primary").click();'); time.sleep(1); feedback_probe=js('return {success:document.querySelector(".feedback-success")?.textContent,error:document.querySelector("#feedback-error")?.textContent,list:document.querySelector("#feedback-list")?.textContent};'); print('feedback probe',feedback_probe,flush=True); assert 'сохранено' in (feedback_probe['success'] or ''), feedback_probe
    assert js('return document.querySelector("#feedback-description").value === "" && document.querySelector("#feedback-list")?.textContent.includes("Safari feedback QA")')
    click('.online-panel .close'); js('document.getElementById("menu-button")?.click();'); wait('!!document.querySelector("#online-menu-logout")','menu logout'); js('document.getElementById("online-menu-logout")?.click();'); wait('!!document.querySelector("#online-login-form")','logout')
    print('Safari: isolated one-field feedback, generated title, saved history and menu logout OK',flush=True)
