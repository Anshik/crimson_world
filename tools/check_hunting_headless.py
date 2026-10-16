#!/usr/bin/env python3
"""Hunting UI/API QA in an isolated headless Chromium profile and temporary DB."""
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))

def main():
    from playwright.sync_api import sync_playwright
    from werkzeug.serving import make_server
    with tempfile.TemporaryDirectory(prefix='crimson-hunting-qa-') as directory:
        os.environ['CRIMSON_DB']=str(Path(directory)/'hunting.sqlite')
        import server.app as web
        store=web.store
        server=make_server('127.0.0.1',0,web.app,threaded=True)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        base=f'http://127.0.0.1:{server.server_port}'
        output=Path('/private/tmp/crimson-hunting-qa');output.mkdir(exist_ok=True)
        try:
            with sync_playwright() as p:
                browser=p.chromium.launch_persistent_context(str(Path(directory)/'browser'),headless=True,viewport={'width':1440,'height':1000},reduced_motion='reduce')
                for width in [1440,390]:
                    username=f'hunter{width}'
                    uid,_,_=store.register(username,'qa-password-123',store.create_invites()[0][1])
                    store.command(uid,'character',0,'createCharacter',{'profile':{'name':'Охотник','sex':'male','race':'human','origin':'abir','class':'scout'}})
                    page=browser.new_page();page.set_viewport_size({'width':width,'height':900})
                    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
                    assert page.request.post(base+'/api/auth/login',data={'login':username,'password':'qa-password-123'}).ok
                    def wait(expression):
                        try: page.wait_for_function(f'window.tovilisGame && !TovilisOnline.busy && ({expression})',timeout=10000)
                        except Exception:
                            print('FAILED',expression,'SERVER',store.state(uid),'CLIENT',page.evaluate('window.tovilisGame?.state'),'TEXT',page.locator('#context').inner_text(),flush=True)
                            raise
                    def click(action): page.locator(f'[data-action="{action}"]').click()
                    def geometry(selector):
                        element=page.locator(selector);element.scroll_into_view_if_needed();box=element.bounding_box()
                        assert box and box['x']>=0 and box['x']+box['width']<=width,(selector,box)
                    page.goto(base+'/');wait('tovilisGame.state.position === "U07"')
                    page.locator('#visit-place').click();geometry('[data-action=hunt]')
                    with patch('server.core.secrets.randbits',return_value=0):
                        click('hunt');wait('tovilisGame.state.phase === "hunting"')
                    assert 'Ежик Миресьева' in page.locator('#context').inner_text()
                    saved=store.state(uid);page.reload();wait('tovilisGame.state.hunt?.stage === "choice"');assert store.state(uid)==saved
                    assert page.locator('[data-action=hunt-shoot]').is_disabled()
                    geometry('[data-action=hunt-melee]');geometry('[data-action=hunt-leave]')
                    # Lose the committed loot response; a retry and concurrent click award once.
                    requests=[]
                    def lose_response(route):
                        requests.append(route.request.post_data_json)
                        if len(requests)==1:
                            response=route.fetch();assert response.ok;route.abort('failed')
                        else: route.continue_()
                    page.route('**/api/commands',lose_response)
                    with patch('server.core.secrets.randbits',return_value=0):
                        page.evaluate('document.querySelector("[data-action=hunt-melee]").click();document.querySelector("[data-action=hunt-melee]").click()')
                        wait('tovilisGame.state.hunt?.stage === "result"')
                    assert len(requests)==2 and requests[0]==requests[1],requests
                    page.unroute('**/api/commands',lose_response)
                    assert store.state(uid)[0]['hero']['huntingBag']=={'gameMeat':1,'hedgehogHide':1}
                    assert page.locator('[data-loot=gameMeat]').count()==1
                    assert page.locator('[data-loot=hedgehogHide]').count()==1
                    assert page.locator('[data-loot=hedgehogHide] svg image').get_attribute('href').endswith('hunting-v1.png')
                    geometry('[data-action=hunt-done]');page.screenshot(path=str(output/f'hunting-loot-{width}.png'))
                    page.reload();wait('tovilisGame.state.hunt?.stage === "result"');click('hunt-done');wait('tovilisGame.state.phase === "ready"')
                    # Walk U07 -> J03 -> U06 through UI directions and server commands.
                    if page.locator('#scene-dialog').evaluate('(e)=>e.open'): page.locator('#scene-close').click()
                    for next_cell,end in [('J03','J03'),('U06','U06')]:
                        page.locator(f'[data-direction="{next_cell}"]').click()
                        with patch('server.core.secrets.randbits',return_value=0):
                            page.locator('#roll').click();page.locator('#roll-continue').click();wait(f'tovilisGame.state.position === "{end}" && tovilisGame.state.phase === "ready"')
                        if end=='J03' and page.locator('#scene-dialog').evaluate('(e)=>e.open'): page.locator('#scene-close').click()
                    if not page.locator('#scene-dialog').evaluate('(e)=>e.open'): page.locator('#visit-place').click()
                    sale=page.locator('[data-action=sell-hedgehogHide]');assert '+25' in sale.inner_text()
                    assert 'без пробы интереса' in page.locator('#context').inner_text()
                    geometry('[data-action=sell-hedgehogHide]');page.screenshot(path=str(output/f'hunting-sale-{width}.png'))
                    before=store.state(uid)[0]['hero']['coins'];click('sell-hedgehogHide');wait(f'tovilisGame.state.hero.coins === {before+25}')
                    assert store.state(uid)[0]['hero']['huntingBag']['hedgehogHide']==0
                    click('sling');wait('tovilisGame.state.hero.sling === true')
                    page.reload();wait('tovilisGame.state.hero.sling === true')
                    # Seed only a return position/resource fixture; encounters and outcomes use UI + server.
                    fixture,_=store.state(uid);fixture['position']='U07';fixture['previous']=None;fixture['selection']=None;fixture['hero']['food']=6
                    with store.db() as c: c.execute('UPDATE game_states SET state=? WHERE user_id=?',(json.dumps(fixture),uid))
                    page.reload();wait('tovilisGame.state.position === "U07"');page.locator('#visit-place').click()
                    with patch('server.core.secrets.randbits',return_value=11):
                        click('hunt');wait('tovilisGame.state.hunt?.roll === 12')
                    assert page.locator('[data-action=hunt-melee]').is_disabled()
                    geometry('[data-action=hunt-shoot]')
                    with patch('server.core.secrets.randbits',return_value=5):
                        click('hunt-shoot');wait('tovilisGame.state.hunt?.result === "victory"')
                    assert store.state(uid)[0]['hero']['huntingBag']['deerAntlers']==1
                    click('hunt-done');wait('tovilisGame.state.phase === "ready"')
                    if not page.locator('#scene-dialog').evaluate('(e)=>e.open'): page.locator('#visit-place').click()
                    with patch('server.core.secrets.randbits',return_value=1):
                        click('hunt');wait('tovilisGame.state.hunt?.roll === 2')
                        click('hunt-melee');wait('tovilisGame.state.hunt?.stage === "combat"')
                    saved=store.state(uid);page.reload();wait('tovilisGame.state.hunt?.stage === "combat"');assert store.state(uid)==saved
                    with patch('server.core.secrets.randbits',side_effect=[5,0]+[0]*126):
                        click('hunt-flee');wait('tovilisGame.state.hunt?.result === "escaped"')
                    click('hunt-done');wait('tovilisGame.state.phase === "ready"')
                    if not page.locator('#scene-dialog').evaluate('(e)=>e.open'): page.locator('#visit-place').click()
                    with patch('server.core.secrets.randbits',return_value=1):
                        click('hunt');wait('tovilisGame.state.hunt?.stage === "choice"')
                    click('hunt-surrender');wait('tovilisGame.state.hunt?.result === "defeat"')
                    click('hunt-done');wait('tovilisGame.state.phase === "ready" && tovilisGame.state.position === "U07"')
                    assert not errors,errors
                    page.close()
                browser.close()
            print(f'PASS: hunting encounter/reload, loot retry/double click/reload, actual city movement, sale preview/sale, sling purchase/ranged deer, melee restriction, combat reload, flee and defeat; headless desktop 1440 and narrow 390. Screenshots: {output}')
        finally: server.shutdown()
if __name__=='__main__':main()
