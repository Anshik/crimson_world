#!/usr/bin/env python3
"""Exercise admin UI on a disposable database and isolated headless Chromium profile."""
from pathlib import Path
import json
import os
import sys
import tempfile
import threading
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main():
    from playwright.sync_api import sync_playwright
    from werkzeug.serving import make_server
    with tempfile.TemporaryDirectory(prefix='crimson-admin-qa-') as directory:
        os.environ['CRIMSON_DB'] = str(Path(directory)/'qa.sqlite')
        os.environ['ADMIN_LOGINS'] = 'operator'
        import server.app as web
        from tools.playtest_bots import Policy
        store = web.store
        now = int(time.time())
        ids = []
        for username, name in [('operator','Смотритель'),('ranger','<img src=x onerror=alert(1)>'),('testbot','Бот кузнец')]:
            with patch('server.monitoring.time.time',return_value=now-3*86400):
                uid, _, _ = store.register(username, 'qa-password-123', store.create_invites()[0][1])
            # Keep a valid character name; the malicious login display is seeded separately below.
            with patch('server.monitoring.time.time',return_value=now-3*86400+1):
                store.command(uid,'character',0,'createCharacter',{'profile':{'name':name if username!='ranger' else 'Следопыт','sex':'male','race':'dwarf','origin':'dwarf','class':'warrior'}})
            ids.append(uid)
        policy=Policy(ROOT)
        state, rev = store.state(ids[2])
        for step in range(60):
            method,args=policy.decide(state,{'shifts':0})
            with patch('server.monitoring.time.time', return_value=now-2*86400+step*600):
                state,rev=store.command(ids[2],f'qa-{step}',rev,method,args)
        store.feedback(ids[2],'bug','Проверка обращения','Нужно проверить работу.',{})
        with store.db() as c:
            c.execute('UPDATE users SET admin=1 WHERE id=?',(ids[0],))
            c.execute('UPDATE users SET is_bot=1 WHERE id=?',(ids[2],))
            c.execute('UPDATE users SET username=? WHERE id=?',('<img src=x onerror=alert(1)>',ids[1]))
        server=make_server('127.0.0.1',0,web.app,threaded=True)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        base=f'http://127.0.0.1:{server.server_port}'
        try:
            with sync_playwright() as p:
                browser=p.chromium.launch_persistent_context(str(Path(directory)/'browser'),headless=True,viewport={'width':1440,'height':1000})
                page=browser.new_page();errors=[];page.on('pageerror',lambda exc:errors.append(str(exc)))
                response=page.request.post(base+'/api/auth/login',data={'login':'operator','password':'qa-password-123'})
                assert response.ok
                page.goto(base+'/admin')
                page.locator('#players tr').nth(2).wait_for()
                assert page.locator('#players tr').count()==3
                assert 'Вы вошли как operator' in page.locator('#current-account').inner_text()
                assert page.locator('#players').get_by_text('ВЫ',exact=True).count()==1
                assert page.locator('#players img').count()==0
                page.select_option('#kind','bot')
                assert page.locator('#players tr').count()==1
                page.get_by_role('button',name='Бот кузнец',exact=True).click()
                page.locator('#detail:not([hidden])').wait_for()
                page.locator('#activity svg').wait_for();page.locator('#growth svg').wait_for()
                assert 'undefined' not in page.locator('#inventory').inner_text()
                assert page.locator('#inventory dd').count()>5
                assert page.locator('#events .event').count()>20
                page.select_option('#stat','coins')
                assert 'Изменение' in page.locator('#growth').inner_text()
                page.fill('#log-search','Работа завершена')
                assert page.locator('#events .event').count()>0
                assert all('Работа завершена' in node.inner_text() for node in page.locator('#events .event').all())
                page.fill('#log-search','')
                page.select_option('#feedback select','fixed')
                page.wait_for_function("!document.querySelector('#feedback select').disabled")
                page.locator('#is-bot').uncheck()
                page.wait_for_function("!document.querySelector('#is-bot').disabled")
                assert page.locator('#players button').count()==0
                assert page.locator('#feedback select').input_value()=='fixed'
                assert 'бот да → нет' in page.locator('#audit').text_content()
                page.select_option('#kind','all')
                page.fill('#search','testbot');assert page.locator('#players button').count()==1
                page.fill('#search','')
                page.screenshot(path='/private/tmp/crimson-admin-desktop.png',full_page=True)
                page.set_viewport_size({'width':390,'height':844})
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                page.screenshot(path='/private/tmp/crimson-admin-mobile.png',full_page=True)
                page.fill('#from','2027-01-02');page.fill('#to','2027-01-01');page.click('#apply-period')
                assert page.locator('#error').is_visible()
                # A fresh context has no admin cookie and receives no private data.
                anon=p.request.new_context()
                assert anon.get(base+'/api/admin/players').status==401
                anon.dispose()
                assert not errors, errors
                browser.close()
                print(json.dumps({'result':'OK','checks':['admin access','players','bot filter and update','search','XSS escaping','inventory','activity and stat charts','event search','feedback status','invalid period','390px layout','no JS exceptions'],'screenshots':['/private/tmp/crimson-admin-desktop.png','/private/tmp/crimson-admin-mobile.png']},ensure_ascii=False))
        finally:
            server.shutdown();thread.join(timeout=5)


if __name__=='__main__': main()
