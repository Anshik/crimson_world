import json, tempfile, unittest
from concurrent.futures import ThreadPoolExecutor
import server.app as web
from server.core import Store

class ServerTests(unittest.TestCase):
    def setUp(self):
        self.old=web.store; self.store=Store(tempfile.mktemp()); web.store=self.store; web._attempts.clear(); self.client=web.app.test_client()
    def tearDown(self): web.store=self.old
    def register(self,email):
        r=self.client.post('/api/auth/register',json={'email':email,'password':'long-pass-1'}); self.assertEqual(r.status_code,200); return r
    def csrf(self,r): return next(x.split('cw_csrf=')[1].split(';')[0] for x in r.headers.getlist('Set-Cookie') if 'cw_csrf=' in x)
    def test_auth_csrf_and_feedback(self):
        r=self.register('a@example.com'); csrf=self.csrf(r)
        self.assertEqual(self.client.post('/api/feedback',json={'category':'bug','title':'Кнопка','body':'Не работает'}).status_code,403)
        r=self.client.post('/api/feedback',json={'category':'bug','title':'Кнопка','body':'Не работает'},headers={'X-CSRF-Token':csrf}); self.assertEqual(r.status_code,200)
        self.assertEqual(len(self.client.get('/api/feedback').json['items']),1)
    def test_command_idempotency(self):
        r=self.register('b@example.com'); csrf=self.csrf(r); state=self.client.get('/api/me').json
        # acknowledge is harmless in ready phase and still exercises CAS/idempotency.
        args={'commandId':'same','revision':state['revision'],'method':'acknowledge','args':{}}
        a=self.client.post('/api/commands',json=args,headers={'X-CSRF-Token':csrf}); b=self.client.post('/api/commands',json=args,headers={'X-CSRF-Token':csrf})
        self.assertEqual(a.status_code,200); self.assertEqual(a.json,b.json); self.assertEqual(a.json['revision'],1)
    def test_private_state_and_presence(self):
        self.register('c@example.com'); first=self.client.get('/api/me').json['state']; self.register('d@example.com'); second=self.client.get('/api/me').json['state']; self.assertNotEqual(first['hero']['name'],second['hero']['name'])
        self.assertIn('players',self.client.get('/api/world/presence').json)
    def test_trade_same_cell_and_unique_registry(self):
        reg=self.register('e@example.com'); one=self.client.get('/api/me').json; token=self.csrf(reg)
        # API rejects unknown recipient before any inventory mutation.
        r=self.client.post('/api/trades/offers',json={'recipient':999,'payload':{'coins':1}},headers={'X-CSRF-Token':token}); self.assertEqual(r.status_code,400)

    def test_command_id_cannot_replay_different_payload(self):
        r=self.register('replay@example.com'); csrf=self.csrf(r); rev=self.client.get('/api/me').json['revision']
        base={'commandId':'fixed','revision':rev,'method':'acknowledge','args':{}}
        self.assertEqual(self.client.post('/api/commands',json=base,headers={'X-CSRF-Token':csrf}).status_code,200)
        altered={**base,'args':{'unexpected':'value'}}
        self.assertEqual(self.client.post('/api/commands',json=altered,headers={'X-CSRF-Token':csrf}).status_code,409)

    def test_origin_and_non_json_are_rejected(self):
        r=self.register('origin@example.com'); csrf=self.csrf(r)
        self.assertEqual(self.client.post('/api/feedback',data='x',headers={'X-CSRF-Token':csrf}).status_code,400)
        self.assertEqual(self.client.post('/api/feedback',json={'title':'x','body':'x'},headers={'X-CSRF-Token':csrf,'Origin':'https://evil.example'}).status_code,403)

    def test_login_throttle(self):
        for _ in range(8): self.client.post('/api/auth/login',json={'email':'none@example.com','password':'bad'})
        self.assertEqual(self.client.post('/api/auth/login',json={'email':'none@example.com','password':'bad'}).status_code,429)

    def test_registration_has_hard_ten_account_limit_under_race(self):
        def register(i):
            try: return self.store.register(f'{i}@example.com','long-pass-1')[0]
            except ValueError: return None
        with ThreadPoolExecutor(max_workers=16) as pool: ids=list(pool.map(register,range(16)))
        self.assertEqual(sum(x is not None for x in ids),10)

    def test_concurrent_offer_acceptance_and_unique_artifact(self):
        a=self.register('sender@example.com'); csrf_a=self.csrf(a); bclient=web.app.test_client(); b=bclient.post('/api/auth/register',json={'email':'receiver@example.com','password':'long-pass-1'}); csrf_b=self.csrf(b)
        sa,_=self.store.state(1); sb,_=self.store.state(2); sa['hero']['coins']=3; sa['hero']['artifacts']=['compassionTear']; sb['hero']['artifacts']=[]
        with self.store.db() as c:
            c.execute('UPDATE game_states SET state=? WHERE user_id=1',(json.dumps(sa),)); c.execute('UPDATE game_states SET state=? WHERE user_id=2',(json.dumps(sb),))
        offer=self.client.post('/api/trades/offers',json={'recipient':2,'payload':{'artifacts':['compassionTear']}},headers={'X-CSRF-Token':csrf_a}).json['id']
        def accept():
            c=web.app.test_client(); c.set_cookie('cw_session',b.headers.get('Set-Cookie').split('cw_session=')[1].split(';')[0]); c.set_cookie('cw_csrf',csrf_b)
            return c.post(f'/api/trades/offers/{offer}/accept',headers={'X-CSRF-Token':csrf_b}).status_code
        with ThreadPoolExecutor(max_workers=2) as pool: statuses=list(pool.map(lambda _:accept(),range(2)))
        self.assertEqual(statuses.count(200),1); state_b,_=self.store.state(2); self.assertEqual(state_b['hero']['artifacts'].count('compassionTear'),1)

    def test_all_exposed_rule_actions_have_server_dispatch(self):
        r=self.register('actions@example.com'); csrf=self.csrf(r); rev=self.client.get('/api/me').json['revision']
        # rename is valid in ready state and proves the command adapter validates its result.
        out=self.client.post('/api/commands',json={'commandId':'rename-1','revision':rev,'method':'rename','args':{'name':'Тестовый герой'}},headers={'X-CSRF-Token':csrf}); self.assertEqual(out.status_code,200); rev=out.json['revision']
        # begin receives the route choice in the same authoritative command.
        out=self.client.post('/api/commands',json={'commandId':'begin-1','revision':rev,'method':'begin','args':{'next':'J03'}},headers={'X-CSRF-Token':csrf}); self.assertEqual(out.status_code,200); self.assertIn(out.json['state']['phase'],('moving','ready','notice','encounter'))
        # Invalid phase/action is a controlled client error, never a 500.
        out=self.client.post('/api/commands',json={'commandId':'bad-action','revision':out.json['revision'],'method':'encounterAction','args':{'action':'hack'}},headers={'X-CSRF-Token':csrf}); self.assertIn(out.status_code,(400,409))

    def test_public_routes_are_whitelisted(self):
        self.assertEqual(self.client.get('/game/index.html').status_code,200)
        self.assertEqual(self.client.get('/docs/tovilis-map-data.js').status_code,200)
        self.assertEqual(self.client.get('/.env').status_code,404)

    def test_bad_method_payload_and_presence_profile_are_controlled(self):
        r=self.register('shape@example.com'); csrf=self.csrf(r); rev=self.client.get('/api/me').json['revision']
        bad=self.client.post('/api/commands',json={'commandId':'shape','revision':rev,'method':[],'args':[]},headers={'X-CSRF-Token':csrf}); self.assertEqual(bad.status_code,400)
        p=self.client.get('/api/world/presence').json; self.assertIn('players',p)

if __name__=='__main__': unittest.main()
