"""Hunting through authoritative commands: entropy, durability and idempotency."""
import json
from pathlib import Path
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
import server.app as web
from server.core import Store

PROFILE={'name':'Охотник','sex':'male','race':'human','origin':'abir','class':'scout'}
class HuntingTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.old=web.store
        self.store=Store(Path(self.tmp.name)/'hunt.sqlite');web.store=self.store
        self.uid,_,token=self.store.register('hunter','password-123',self.store.create_invites()[0][1])
        self.store.command(self.uid,'character',0,'createCharacter',{'profile':PROFILE})
        self.client=web.app.test_client();self.client.set_cookie('cw_session',token)
        self.csrf=self.store.session(token)['csrf']
    def tearDown(self):
        web.store=self.old;self.tmp.cleanup()
    def command(self,method,args,rev,cid):
        return self.client.post('/api/commands',json={'method':method,'args':args,'revision':rev,'commandId':cid},headers={'X-CSRF-Token':self.csrf})
    def test_full_path_server_ignores_forged_loot_and_retries(self):
        with patch('server.core.secrets.randbits',return_value=0):
            r=self.command('service',{'action':'hunt','roll':20,'loot':{'elephantTusks':100}},1,'hunt')
        self.assertEqual(r.status_code,200,r.json)
        self.assertEqual(r.json,self.command('service',{'action':'hunt','roll':20,'loot':{'elephantTusks':100}},1,'hunt').json)
        s,rev=Store(self.store.path).state(self.uid);self.assertEqual(s['hunt']['roll'],1)
        self.assertEqual(self.command('acknowledge',{},rev,'too-early').status_code,400)
        # First melee damage roll succeeds; the animal does not attack.
        with patch('server.core.secrets.randbits',return_value=0):
            r=self.command('huntAction',{'action':'melee'},rev,'kill')
        self.assertEqual(r.status_code,200,r.json)
        self.assertEqual(self.command('huntAction',{'action':'melee'},rev,'kill').json,r.json)
        s,rev=Store(self.store.path).state(self.uid)
        self.assertEqual(s['hero']['huntingBag'],{'gameMeat':1,'hedgehogHide':1})
        self.assertEqual(self.command('huntAction',{'action':'melee'},rev,'kill-again').status_code,400)
        self.assertEqual(self.command('acknowledge',{},rev,'return').status_code,200)
        s,rev=self.store.state(self.uid);self.assertEqual(s['position'],'U07')
        # Real movement into the neighbouring shop, no test teleport for the sale.
        with patch('server.core.secrets.randbits',return_value=0):
            r=self.command('begin',{'next':'J03'},rev,'gate-move')
        self.assertEqual(r.status_code,200,r.json)
        s,rev=self.store.state(self.uid)
        r=self.command('arrive',{},rev,'gate-arrive');self.assertEqual(r.status_code,200,r.json)
        s,rev=self.store.state(self.uid)
        with patch('server.core.secrets.randbits',return_value=0):
            self.assertEqual(self.command('begin',{'next':'U06','stopBuilding':'far-shop'},rev,'shop-move').status_code,200)
        s,rev=self.store.state(self.uid);self.assertEqual(self.command('arrive',{},rev,'shop-arrive').status_code,200)
        s,rev=self.store.state(self.uid);self.assertEqual(s['position'],'U06');self.assertEqual(s['phase'],'ready')
        coins=s['hero']['coins']
        def sell(): return self.store.command(self.uid,'sale',rev,'service',{'action':'sell-hedgehogHide'})
        with ThreadPoolExecutor(max_workers=4) as pool:
            results=list(pool.map(lambda _:sell(),range(4)))
        self.assertTrue(all(result==results[0] for result in results))
        s,newrev=Store(self.store.path).state(self.uid)
        self.assertEqual(s['hero']['coins'],coins+25);self.assertEqual(s['hero']['huntingBag']['hedgehogHide'],0)
        self.assertEqual(self.command('service',{'action':'sell-hedgehogHide'},newrev,'sale-again').status_code,400)
    def test_unfinished_combat_survives_engine_restart_and_other_player_moves(self):
        with patch('server.core.secrets.randbits',return_value=1):
            s,rev=self.store.command(self.uid,'hunt',1,'service',{'action':'hunt'})
            s,rev=self.store.command(self.uid,'round',rev,'huntAction',{'action':'melee'})
        self.assertEqual(s['hunt']['stage'],'combat')
        restored=Store(self.store.path);self.assertEqual(restored.state(self.uid),(s,rev))
        uid,_,_=self.store.register('walker','password-123',self.store.create_invites()[0][1])
        other,orev=self.store.command(uid,'character',0,'createCharacter',{'profile':PROFILE})
        with patch('server.core.secrets.randbits',return_value=0):
            other,orev=self.store.command(uid,'walk',orev,'begin',{'next':'J03'})
        self.assertEqual(other['phase'],'moving');self.assertEqual(restored.state(self.uid),(s,rev))
        out,rrev=restored.command(self.uid,'surrender',rev,'huntAction',{'action':'surrender'})
        self.assertEqual(out['hunt']['result'],'defeat');self.assertEqual(out['position'],'U07')
        self.assertEqual(self.command('huntAction',{'action':'shoot','target':99},rrev,'invalid').status_code,400)
