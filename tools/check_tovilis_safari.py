#!/usr/bin/env python3
"""Check the local annotation viewer through an already running safaridriver.

Start `/usr/bin/safaridriver --port 8766` first. This opens an isolated Safari
automation session; no external site or normal user tab is accessed.
"""
from pathlib import Path
import base64
import json
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
OUT = Path('/private/tmp/tovilis-markup')
OUT.mkdir(exist_ok=True)
BASE = 'http://127.0.0.1:8766'

if '--allow-visible-safari' not in sys.argv:
    raise SystemExit('Visible Safari runner disabled. Use tools/check_tovilis_browser.py; pass --allow-visible-safari only for an explicitly approved visible run.')


def request(method, path, payload=None):
    body = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(BASE+path, data=body, method=method,
                                 headers={'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req,timeout=25) as response:
            result=json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(error.read().decode()) from error
    value=result.get('value')
    if isinstance(value,dict) and value.get('error'):
        raise RuntimeError(value)
    return value


session=request('POST','/session',{'capabilities':{'alwaysMatch':{'browserName':'safari'}}})
sid=session['sessionId']
prefix='/session/'+sid
print('Safari', session['capabilities'].get('browserVersion'),flush=True)


def js(script):
    return request('POST',prefix+'/execute/sync',{'script':script,'args':[]})

def async_js(script):
    return request('POST',prefix+'/execute/async',{'script':script,'args':[]})


def click(selector):
    found=request('POST',prefix+'/element',{'using':'css selector','value':selector})
    eid=found['element-6066-11e4-a52e-4f735466cecf']
    request('POST',prefix+'/element/'+eid+'/click',{})


def snapshot(name):
    # Safari's screenshot endpoint may capture the previous composited frame.
    # Await image decoding and give its compositor time to display that frame.
    request('POST',prefix+'/execute/async',{'script':'const done=arguments[arguments.length-1]; Promise.all(Array.from(document.images, i=>i.decode().catch(()=>{}))).then(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>done(true))));','args':[]})
    time.sleep(.3)
    encoded=request('GET',prefix+'/screenshot')
    (OUT/(name+'.png')).write_bytes(base64.b64decode(encoded))


try:
    if '--find-art' in sys.argv:
        from safari_game_checks import check_find_art
        check_find_art(request, prefix, js, click, snapshot, ROOT)
        sys.exit(0)
    if '--hero-sheet' in sys.argv:
        from safari_game_checks import check_game
        check_game(request, prefix, js, click, snapshot, ROOT)
        sys.exit(0)
    if '--sale-ui' in sys.argv:
        from safari_game_checks import check_game
        check_game(request, prefix, js, click, snapshot, ROOT)
        sys.exit(0)
    if '--online-feedback' in sys.argv:
        from safari_game_checks import check_online_feedback
        check_online_feedback(request, prefix, js, click, snapshot, ROOT)
        sys.exit(0)
    if '--public' in sys.argv:
        import os
        base=os.environ.get('TOVILIS_PUBLIC_URL','https://crimsonworld.139-100-236-83.sslip.io').rstrip('/')
        request('POST',prefix+'/window/rect',{'width':1320,'height':920})
        request('POST',prefix+'/url',{'url':base+'/'})
        for _ in range(100):
            if js('return !!document.querySelector("#online-login-form");'): break
            time.sleep(.1)
        assert js('return location.protocol === "https:" && !!document.querySelector("#online-login-form");'), 'Public HTTPS login did not load'
        config = async_js('const done=arguments[arguments.length-1];fetch("/api/auth/config",{credentials:"include"}).then(r=>r.json()).then(done).catch(e=>done({error:String(e)}));')
        assert config.get('registrationMode') == 'invite' and config.get('adminRecovery') is True and not any(key in config for key in ('emailRequired','confirmEmail')), config
        assert js('return !document.querySelector("input[type=email]") && !!document.querySelector("#online-login") && !!document.querySelector("#online-register");')
        assert js('return document.body.classList.contains("online-mode") && !document.body.classList.contains("online-ready") && getComputedStyle(document.getElementById("hero-layer")).visibility === "hidden";'), 'Uninitialised sprite atlas visible behind login'
        click('#online-register')
        assert js('return !!document.querySelector("#online-register-form") && !!document.querySelector("#online-username") && !!document.querySelector("#online-invite") && !document.querySelector("input[type=email]");')
        # Read-only regression check: a public invite fragment must prefill
        # exactly and be removed from the address bar without submitting.
        readonly_code = 'SafariReadonly_20261016'
        request('POST',prefix+'/url',{'url':'about:blank'})
        request('POST',prefix+'/url',{'url':base+'/#invite='+readonly_code})
        for _ in range(100):
            if js('return !!document.querySelector("#online-register-form") && document.querySelector("#online-invite")?.value === '+repr(readonly_code)+';'): break
            time.sleep(.1)
        public_prefill = js('return {value:document.querySelector("#online-invite")?.value,hash:location.hash};')
        print('Public invite read-only:', public_prefill, flush=True)
        assert public_prefill['value'] == readonly_code and public_prefill['hash'] == '', 'Public invite prefill regression'
        assert js('return !!window.TOVILIS_MAP && !!window.TOVILIS_CHARACTERS && Object.keys(window.TOVILIS_CHARACTER_ATLASES || {}).length === 6;')
        assert js('return !performance.getEntriesByType("resource").some(r => r.responseStatus >= 400);'), js('return performance.getEntriesByType("resource").filter(r=>r.responseStatus>=400).map(r=>r.name);')
        snapshot('public-https-login-1320')
        request('POST',prefix+'/window/rect',{'width':390,'height':844})
        assert js('return document.documentElement.scrollWidth <= innerWidth;')
        snapshot('public-https-login-390')
        print('Safari: public HTTPS login, invitation registration form, admin recovery config, no email fields, six race/sex atlases, resource loading and mobile bounds OK; no production accounts created',flush=True)
        sys.exit(0)
    if '--game' in sys.argv:
        from safari_game_checks import check_game
        check_game(request, prefix, js, click, snapshot, ROOT)
        sys.exit(0)
    if '--online' in sys.argv:
        from safari_game_checks import check_online
        check_online(request, prefix, js, click, snapshot, ROOT)
        sys.exit(0)
    request('POST',prefix+'/window/rect',{'width':1320,'height':920})
    request('POST',prefix+'/url',{'url':(ROOT/'docs/tovilis-map.html').as_uri()})
    print('Page:',js('return document.title;'),flush=True)
    assert js('return !!window.tovilisMapView && document.querySelectorAll(".cell").length === window.TOVILIS_MAP.cells.length;')
    click('[data-cell="J06"]')
    assert js('return window.tovilisMapView.selected === "J06";')
    click('#set-start')
    click('[data-cell="Q01"]')
    click('#set-end')
    assert js('return window.tovilisMapView.path[0] === "J06" && window.tovilisMapView.path.at(-1) === "Q01";')
    click('#clear-path')
    initial=js('return document.getElementById("map").getAttribute("viewBox");')
    click('#zoom-in')
    assert js('return Number(document.getElementById("map").getAttribute("viewBox").split(" ")[2]) < 1448;')
    click('#streets-view')
    assert js('return document.getElementById("map").getAttribute("viewBox");')==initial
    rect=js('const r=document.getElementById("map").getBoundingClientRect(); return {x:Math.round(r.x+r.width*.4),y:Math.round(r.y+r.height*.4)};')
    request('POST',prefix+'/actions',{'actions':[{'type':'pointer','id':'map-mouse','parameters':{'pointerType':'mouse'},'actions':[
        {'type':'pointerMove','duration':0,'x':rect['x'],'y':rect['y']},
        {'type':'pointerDown','button':0},
        {'type':'pointerMove','duration':250,'x':rect['x']+60,'y':rect['y']+30},
        {'type':'pointerUp','button':0}]}]})
    assert js('return document.getElementById("map").getAttribute("viewBox");')!=initial
    click('#streets-view')
    click('#show-labels')
    snapshot('safari-overview')
    for preset in ['start-mill','mill-shop','shop-port','forge-tavern']:
        info=js(f'const s=document.getElementById("route-preset"); s.value={json.dumps(preset)}; s.dispatchEvent(new Event("change")); return {{text:document.getElementById("route-info").textContent,path:window.tovilisMapView.path}};')
        assert info['path'], preset
        print(preset, info['text'],flush=True)
    click('#clear-path')
    click('#show-edges')
    click('#show-entrances')
    for name,box in [('north',[600,438,848,158]),('west',[62,476,550,610]),('center',[635,530,360,310]),('southeast',[735,760,713,326])]:
        js('document.getElementById("map").setAttribute("viewBox",'+json.dumps(' '.join(map(str,box)))+');')
        snapshot('safari-'+name)
    click('#streets-view')
    click('#show-edges')
    click('#show-entrances')
    click('#show-labels')
    click('#art-only')
    assert js('return getComputedStyle(document.getElementById("cells-layer")).display === "none";')
    click('#art-only')
    assert js('return getComputedStyle(document.getElementById("cells-layer")).display !== "none";')
    snapshot('safari-final')
    request('POST',prefix+'/window/rect',{'width':620,'height':900})
    dimensions=js('return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,layout:getComputedStyle(document.querySelector("main")).display};')
    assert dimensions['scrollWidth']<=dimensions['width'], dimensions
    assert dimensions['layout']=='flex', dimensions
    snapshot('safari-narrow')
    print('Narrow layout:',dimensions,flush=True)
    print('Screenshots:',OUT,flush=True)
finally:
    request('DELETE',prefix)
