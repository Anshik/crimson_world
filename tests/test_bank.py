"""Bank invariants through the authoritative HTTP and persistence boundaries."""
import json
import os
from unittest.mock import patch
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import server.app as web
from server.core import Store

PROFILE = {'name':'Вкладчик','sex':'male','race':'dwarf','origin':'dwarf','class':'warrior'}

class BankTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = web.store
        self.store = Store(Path(self.tmp.name)/'bank.sqlite')
        web.store = self.store
        self.uid, _, self.token = self.store.register('depositor', 'long-pass-1', self.store.create_invites()[0][1])
        self.client = web.app.test_client()
        self.client.set_cookie('cw_session', self.token)
        self.csrf = self.store.session(self.token)['csrf']
        self.store.command(self.uid,'character',0,'createCharacter',{'profile':PROFILE})
        state, _ = self.store.state(self.uid)
        state['position'] = 'L03'
        state['hero']['coins'] = 20
        state.pop('bank', None)  # a pre-bank saved game
        with self.store.db() as c:
            c.execute('UPDATE game_states SET state=? WHERE user_id=?',(json.dumps(state),self.uid))
    def tearDown(self):
        web.store = self.old
        self.tmp.cleanup()
    def command(self, action='deposit', amount=7, revision=1, command_id='bank', **extra):
        return self.client.post('/api/commands', json={'method':'bankTransfer','args':{'action':action,'amount':amount,**extra},'revision':revision,'commandId':command_id},headers={'X-CSRF-Token':self.csrf})
    def test_conservation_retry_reload_and_durable_audit(self):
        r = self.command()
        self.assertEqual(r.status_code,200)
        self.assertEqual(r.json,self.command().json)
        s, rev = Store(self.store.path).state(self.uid)
        self.assertEqual((s['hero']['coins'],s['bank']['tovilis']['balance'],s['turn'],s['ticks'],rev),(13,7,0,0,2))
        r = self.command('withdraw',7,2,'withdraw')
        self.assertEqual(r.status_code,200)
        s, _ = self.store.state(self.uid)
        self.assertEqual((s['hero']['coins'],s['bank']['tovilis']['balance']),(20,0))
        self.assertEqual(len(s['bank']['tovilis']['history']),2)
        with self.store.db() as c:
            rows = c.execute("SELECT * FROM player_events WHERE method='bankTransfer'").fetchall()
        self.assertEqual(len(rows),2)
        self.assertEqual(json.loads(rows[-1]['snapshot'])['bank']['tovilis']['balance'],0)
        self.assertIn('bank',json.loads(rows[-1]['changes']))
        self.assertIn('снято',json.loads(rows[-1]['journal'])[0]['text'])
        with self.store.db() as c: c.execute('UPDATE users SET admin=1 WHERE id=?',(self.uid,))
        with patch.dict(os.environ, {'ADMIN_LOGINS':'depositor'}):
            audit=self.client.get(f'/api/admin/players/{self.uid}')
        self.assertEqual(audit.status_code,200)
        self.assertEqual(len([e for e in audit.json['events'] if e['method']=='bankTransfer']),2)
    def test_invalid_amounts_are_atomic(self):
        for amount in [-1,0,1.5,'7',True,None,21,9007199254740992]:
            self.assertEqual(self.command(amount=amount).status_code,400,amount)
        self.assertEqual(self.command('withdraw',1).status_code,400)
        self.assertEqual(self.command('other',1).status_code,400)
        s, rev = self.store.state(self.uid)
        self.assertEqual((s['hero']['coins'],rev),(20,1))
        self.assertNotIn('bank',s)
    def test_old_save_city_and_player_isolation(self):
        other,_,token = self.store.register('another','long-pass-1',self.store.create_invites()[0][1])
        self.assertEqual(self.command(user_id=other,city='another').status_code,200)
        self.assertNotIn('another',self.store.state(self.uid)[0]['bank'])
        other_client = web.app.test_client(); other_client.set_cookie('cw_session',token)
        self.assertEqual(other_client.get('/api/me').json['state']['bank'],{})
        self.assertEqual(other_client.get(f'/api/admin/players/{self.uid}').status_code,403)
        self.assertEqual(self.client.get(f'/api/admin/players/{other}').status_code,403)
    def test_location_and_event_are_server_checked(self):
        for position,phase in [('U07','ready'),('L03','notice'),('L03','combat'),('L03','moving'),('L03','work')]:
            s, _ = self.store.state(self.uid); s['position']=position; s['phase']=phase
            with self.store.db() as c: c.execute('UPDATE game_states SET state=? WHERE user_id=?',(json.dumps(s),self.uid))
            self.assertEqual(self.command().status_code,400)
        self.assertEqual(self.store.state(self.uid)[1],1)
    def test_fresh_duplicate_request_across_workers(self):
        def send(_):
            return Store(self.store.path).command(self.uid,'fresh-shared',1,'bankTransfer',{'action':'deposit','amount':15})
        with ThreadPoolExecutor(max_workers=2) as pool: replies=list(pool.map(send,range(2)))
        self.assertEqual(replies[0],replies[1])
        s, rev = self.store.state(self.uid)
        self.assertEqual((s['hero']['coins'],s['bank']['tovilis']['balance'],rev),(5,15,2))
        self.assertEqual(len(s['bank']['tovilis']['history']),1)

    def test_parallel_tabs_and_same_request_across_store_instances(self):
        def send(i, same=False):
            # Separate SQLite connections and locks, like separate server workers.
            store = Store(self.store.path)
            try: return store.command(self.uid,'shared' if same else f'tab-{i}',1,'bankTransfer',{'action':'deposit','amount':15})
            except ValueError as e: return str(e)
        with ThreadPoolExecutor(max_workers=2) as pool: results=list(pool.map(send,range(2)))
        self.assertEqual(sum(isinstance(x,tuple) for x in results),1)
        s, rev = self.store.state(self.uid)
        self.assertEqual((s['hero']['coins'],s['bank']['tovilis']['balance'],rev),(5,15,2))
        # Repeat exactly the winner, concurrently, without further effects.
        winner=next(i for i,r in enumerate(results) if isinstance(r,tuple))
        def replay(_): return Store(self.store.path).command(self.uid,f'tab-{winner}',1,'bankTransfer',{'action':'deposit','amount':15})
        with ThreadPoolExecutor(max_workers=2) as pool: replies=list(pool.map(replay,range(2)))
        self.assertEqual(replies[0],replies[1]); self.assertEqual(self.store.state(self.uid)[1],2)
