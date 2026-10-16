#!/usr/bin/env python3
"""Bank UI and API checks in a disposable headless Chromium profile/database."""
import json
import os
from pathlib import Path
import sys
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

def main():
    from playwright.sync_api import sync_playwright
    from werkzeug.serving import make_server
    with tempfile.TemporaryDirectory(prefix='crimson-bank-qa-') as directory:
        os.environ['CRIMSON_DB'] = str(Path(directory)/'bank.sqlite')
        import server.app as web
        store = web.store
        uid,_,_ = store.register('banktester','qa-password-123',store.create_invites()[0][1])
        s,rev=store.command(uid,'character',0,'createCharacter',{'profile':{'name':'Вкладчик','sex':'male','race':'dwarf','origin':'dwarf','class':'warrior'}})
        s['position']='L03';s['hero']['coins']=20;s.pop('bank',None)
        with store.db() as c: c.execute('UPDATE game_states SET state=? WHERE user_id=?',(json.dumps(s),uid))
        server=make_server('127.0.0.1',0,web.app,threaded=True)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        base=f'http://127.0.0.1:{server.server_port}'
        output=Path('/private/tmp/crimson-bank-qa');output.mkdir(exist_ok=True)
        try:
            with sync_playwright() as p:
                browser=p.chromium.launch_persistent_context(str(Path(directory)/'browser'),headless=True,viewport={'width':1440,'height':1000})
                page=browser.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
                assert page.request.post(base+'/api/auth/login',data={'login':'banktester','password':'qa-password-123'}).ok
                for width in [1440,390]:
                    page.set_viewport_size({'width':width,'height':900})
                    page.goto(base+'/');page.wait_for_function('window.tovilisGame?.state.position === "L03"')
                    page.locator('#visit-place').click()
                    assert page.locator('#scene-title').inner_text()=='Банк Товилиса'
                    for value in ['-1','1.5','100']:
                        page.locator('#bank-amount').fill(value)
                        assert page.locator('[data-action=bank-deposit]').is_disabled()
                    before=page.evaluate('tovilisGame.state.hero.coins')
                    page.locator('#bank-amount').fill('7')
                    assert f'наличные {before-7}' in page.locator('#bank-preview').inner_text()
                    # Lose the first response after the server commits; the client retries.
                    requests=[]
                    def lose_response(route):
                        requests.append(route.request.post_data_json)
                        if len(requests)==1:
                            response=route.fetch()
                            assert response.ok
                            route.abort('failed')
                        else:
                            route.continue_()
                    page.route('**/api/commands',lose_response)
                    # Two clicks while one request is in flight must execute once.
                    page.evaluate('document.querySelector("[data-action=bank-deposit]").click(); document.querySelector("[data-action=bank-deposit]").click()')
                    page.wait_for_function(f'tovilisGame.state.hero.coins === {before-7} && !TovilisOnline.busy')
                    assert page.evaluate('tovilisGame.state.bank.tovilis.balance')==7
                    assert len(requests)==2 and requests[0]==requests[1],requests
                    page.unroute('**/api/commands',lose_response)
                    page.reload();page.wait_for_function('window.tovilisGame?.state.bank?.tovilis.balance === 7')
                    page.locator('#visit-place').click()
                    assert page.locator('.bank-history li').count()>=1
                    page.locator('#bank-direction').select_option('withdraw');page.locator('[data-action=bank-all]').click()
                    assert page.locator('#bank-amount').input_value()=='7'
                    assert f'наличные {before}' in page.locator('#bank-preview').inner_text()
                    # Check actual control geometry and save a reviewable screenshot.
                    for selector in ['#bank-amount','[data-action=bank-all]','[data-action=bank-deposit]','[data-action=bank-withdraw]']:
                        control=page.locator(selector);control.scroll_into_view_if_needed()
                        box=control.bounding_box();assert box and box['x']>=0 and box['x']+box['width']<=width,(selector,box)
                    page.screenshot(path=str(output/f'bank-{width}.png'))
                    page.locator('[data-action=bank-withdraw]').click()
                    page.wait_for_function(f'tovilisGame.state.hero.coins === {before} && !TovilisOnline.busy')
                    assert page.evaluate('tovilisGame.state.bank.tovilis.balance')==0
                    page.locator('#bank-direction').select_option('deposit');page.locator('[data-action=bank-all]').click()
                    assert page.locator('#bank-amount').input_value()==str(before)
                assert not errors,errors
                assert len(store.state(uid)[0]['bank']['tovilis']['history'])==4
                browser.close()
            print(f'PASS: online bank, retries/double click, reload, previews, All, invalid input; desktop 1440 and narrow 390. Screenshots: {output}')
        finally: server.shutdown()

if __name__=='__main__': main()
