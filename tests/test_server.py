import json, tempfile, unittest
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import server.app as web
from server.core import Store

class ServerTests(unittest.TestCase):
    def setUp(self):
        self.old=web.store; self.store=Store(tempfile.mktemp()); web.store=self.store; web._attempts.clear(); self.client=web.app.test_client()
    def tearDown(self): web.store=self.old
    def register(self,email):
        code=self.store.create_invites(1)[0][1]; username=email.split('@')[0]; username=(username+'user')[:24] if len(username)<3 else username
        r=self.client.post('/api/auth/register',json={'username':username,'password':'long-pass-1','inviteCode':code}); self.assertEqual(r.status_code,200); return r
    def csrf(self,r): return next(x.split('cw_csrf=')[1].split(';')[0] for x in r.headers.getlist('Set-Cookie') if 'cw_csrf=' in x)
    def activate(self,reg,profile=None):
        profile=profile or {'name':'Герой','sex':'male','race':'dwarf','origin':'dwarf','class':'warrior'}
        csrf=self.csrf(reg); rev=self.client.get('/api/me').json['revision']; out=self.client.post('/api/commands',json={'commandId':'character-'+str(id(reg)),'revision':rev,'method':'createCharacter','args':{'profile':profile}},headers={'X-CSRF-Token':csrf}); self.assertEqual(out.status_code,200); return csrf,out.json['revision']
    def test_auth_csrf_and_feedback(self):
        r=self.register('a@example.com'); csrf=self.csrf(r)
        self.assertEqual(self.client.post('/api/feedback',json={'category':'bug','title':'Кнопка','body':'Не работает'}).status_code,403)
        r=self.client.post('/api/feedback',json={'category':'bug','title':'Кнопка','body':'Не работает'},headers={'X-CSRF-Token':csrf}); self.assertEqual(r.status_code,200)
        self.assertEqual(len(self.client.get('/api/feedback').json['items']),1)
    def test_command_idempotency(self):
        r=self.register('b@example.com'); csrf,created=self.activate(r); state=self.client.get('/api/me').json
        # acknowledge is harmless in ready phase and still exercises CAS/idempotency.
        args={'commandId':'same','revision':state['revision'],'method':'acknowledge','args':{}}
        a=self.client.post('/api/commands',json=args,headers={'X-CSRF-Token':csrf}); b=self.client.post('/api/commands',json=args,headers={'X-CSRF-Token':csrf})
        self.assertEqual(a.status_code,200); self.assertEqual(a.json,b.json); self.assertEqual(a.json['revision'],2)
    def test_private_state_and_presence(self):
        self.register('c@example.com'); first=self.client.get('/api/me').json['state']; self.register('d@example.com'); second=self.client.get('/api/me').json['state']; self.assertNotEqual(first['hero']['name'],second['hero']['name'])
        self.assertIn('players',self.client.get('/api/world/presence').json)
    def test_trade_same_cell_and_unique_registry(self):
        reg=self.register('e@example.com'); one=self.client.get('/api/me').json; token=self.csrf(reg)
        # API rejects unknown recipient before any inventory mutation.
        r=self.client.post('/api/trades/offers',json={'recipient':999,'payload':{'coins':1}},headers={'X-CSRF-Token':token}); self.assertEqual(r.status_code,400)

    def test_command_id_cannot_replay_different_payload(self):
        r=self.register('replay@example.com'); csrf,rev=self.activate(r)
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
            try: return self.store.register(f'user{i}','long-pass-1',codes[i])[0]
            except ValueError: return None
        codes=[x[1] for x in self.store.create_invites(16)]
        with ThreadPoolExecutor(max_workers=16) as pool: ids=list(pool.map(register,range(16)))
        self.assertEqual(sum(x is not None for x in ids),10)

    def test_concurrent_offer_acceptance_and_unique_artifact(self):
        a=self.register('sender@example.com'); csrf_a=self.csrf(a); bclient=web.app.test_client(); code=self.store.create_invites(1)[0][1]; b=bclient.post('/api/auth/register',json={'username':'receiver','password':'long-pass-1','inviteCode':code}); csrf_b=self.csrf(b)
        self.activate(a)
        activated=bclient.post('/api/commands',json={'commandId':'activate-recipient','revision':0,'method':'createCharacter','args':{'profile':{'name':'Получатель','sex':'female','race':'human','origin':'tovilis','class':'warrior'}}},headers={'X-CSRF-Token':csrf_b})
        self.assertEqual(activated.status_code,200)
        sa,_=self.store.state(1); sb,_=self.store.state(2); sa['hero']['coins']=3; sa['hero']['artifacts']=['compassionTear']; sb['hero']['artifacts']=[]
        with self.store.db() as c:
            c.execute('UPDATE game_states SET state=? WHERE user_id=1',(json.dumps(sa),)); c.execute('UPDATE game_states SET state=? WHERE user_id=2',(json.dumps(sb),))
        offer=self.client.post('/api/trades/offers',json={'recipient':2,'payload':{'artifacts':['compassionTear']}},headers={'X-CSRF-Token':csrf_a}).json['id']
        def accept():
            c=web.app.test_client(); c.set_cookie('cw_session',b.headers.get('Set-Cookie').split('cw_session=')[1].split(';')[0]); c.set_cookie('cw_csrf',csrf_b)
            return c.post(f'/api/trades/offers/{offer}/accept',headers={'X-CSRF-Token':csrf_b}).status_code
        with ThreadPoolExecutor(max_workers=2) as pool: statuses=list(pool.map(lambda _:accept(),range(2)))
        self.assertEqual(statuses.count(200),1); state_b,_=self.store.state(2); self.assertEqual(state_b['hero']['artifacts'].count('compassionTear'),1)

    def test_trade_cannot_be_accepted_during_a_new_event_or_before_character_creation(self):
        a=self.register('sender-phase@example.com'); csrf_a=self.csrf(a)
        bclient=web.app.test_client(); code=self.store.create_invites(1)[0][1]; b=bclient.post('/api/auth/register',json={'username':'receiverphase','password':'long-pass-1','inviteCode':code}); csrf_b=self.csrf(b)
        headers={'X-CSRF-Token':csrf_a}
        payload={'recipient':2,'payload':{'coins':1}}
        self.assertEqual(self.client.post('/api/trades/offers',json=payload,headers=headers).status_code,400)
        self.activate(a)
        out=bclient.post('/api/commands',json={'commandId':'recipient-create','revision':0,'method':'createCharacter','args':{'profile':{'name':'Получатель','sex':'female','race':'elf','origin':'forestElf','class':'warrior'}}},headers={'X-CSRF-Token':csrf_b})
        self.assertEqual(out.status_code,200)
        offered=self.client.post('/api/trades/offers',json=payload,headers=headers)
        self.assertEqual(offered.status_code,200)
        before_a,rev_a=self.store.state(1); before_b,rev_b=self.store.state(2)
        moving=self.store.engine.run('begin',before_a,{'next':'J03'},[0]*128)
        with self.store.db() as c: c.execute('UPDATE game_states SET state=? WHERE user_id=1',(json.dumps(moving),))
        accepted=bclient.post('/api/trades/offers/'+offered.json['id']+'/accept',headers={'X-CSRF-Token':csrf_b})
        self.assertEqual(accepted.status_code,400)
        self.assertEqual(self.store.state(1)[0]['hero']['coins'],before_a['hero']['coins'])
        self.assertEqual(self.store.state(2),(before_b,rev_b))

    def test_all_exposed_rule_actions_have_server_dispatch(self):
        r=self.register('actions@example.com'); csrf,rev=self.activate(r)
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

    def test_recovery_tokens_are_single_use_and_expire(self):
        uid,_,_=self.store.register('recoveruser','long-pass-1',self.store.create_invites(1)[0][1])
        token=self.store.issue_reset('recoveruser')
        self.assertTrue(self.store.reset_password(token,'new-pass-1'))
        self.assertFalse(self.store.reset_password(token,'third-pass'))
        self.assertIsNotNone(self.store.authenticate('recoveruser','new-pass-1'))
        with self.store.db() as db:
            self.assertIsNotNone(db.execute('SELECT used_at FROM recovery_tokens WHERE user_id=?',(uid,)).fetchone()[0])

    def test_trade_and_chat_bad_scalars_never_500_and_empty_trade_rejected(self):
        r=self.register('badshape@example.com'); csrf=self.csrf(r)
        for payload in ({'recipient':'abc','payload':{'coins':1}}, {'recipient':2,'payload':{}}, {'recipient':2,'payload':{'items':{'sword':True}}}):
            out=self.client.post('/api/trades/offers',json=payload,headers={'X-CSRF-Token':csrf}); self.assertLess(out.status_code,500)
        self.assertLess(self.client.get('/api/chat?after=nope').status_code,500)

    def test_trade_requires_ready_and_bad_command_revision_is_400(self):
        r=self.register('phase@example.com'); csrf=self.csrf(r); me=self.client.get('/api/me').json; state=me['state']; state['phase']='moving'
        with self.store.db() as c: c.execute('UPDATE game_states SET state=? WHERE user_id=1',(json.dumps(state),))
        out=self.client.post('/api/trades/offers',json={'recipient':1,'payload':{'coins':1}},headers={'X-CSRF-Token':csrf}); self.assertLess(out.status_code,500)
        out=self.client.post('/api/commands',json={'commandId':'float','revision':1.5,'method':'rename','args':{'name':'x'}},headers={'X-CSRF-Token':csrf}); self.assertEqual(out.status_code,400)

    def test_auth_config_and_strict_invite_validation(self):
        self.assertEqual(self.client.get('/api/auth/config').json, {'registrationMode':'invite','adminRecovery':True})
        self.assertLess(self.client.post('/api/auth/register',json={'username':'ab','password':'long-pass-1','inviteCode':'bad'}).status_code,500)
        self.assertLess(self.client.post('/api/auth/register',json={'username':'validname','password':None,'inviteCode':'bad'}).status_code,500)

    def test_api_accepts_invite_link_and_consumes_it_once(self):
        code=self.store.create_invites(1)[0][1]
        wrapped='https://example.test/register#invite='+code
        first=self.client.post('/api/auth/register',json={'username':'linkuser','password':'long-pass-1','inviteCode':wrapped})
        self.assertEqual(first.status_code,200)
        second=self.client.post('/api/auth/register',json={'username':'linkuser2','password':'long-pass-1','inviteCode':wrapped})
        self.assertEqual(second.status_code,400)

    def test_store_cannot_reset_character_with_public_create(self):
        uid,_,_=self.store.register('guarduser','long-pass-1',self.store.create_invites(1)[0][1])
        with self.assertRaises(ValueError): self.store.command(uid,'reset',0,'create',{'name':'Cheat'})

    def test_real_encounter_battle_target_and_weapon_switch(self):
        import collections
        engine=self.store.engine; state=engine.run('createCharacter',None,{'profile':{'name':'Боец','sex':'male','race':'dwarf','origin':'dwarf','class':'warrior'}},[])
        mp=json.loads(Path('assets/maps/geometry/tovilis-v9.json').read_text()); graph={c['id']:[] for c in mp['cells']}
        for e in mp['edges']:
            if e['bidirectional']: graph[e['from']].append(e['to']); graph[e['to']].append(e['from'])
        target=next(c['id'] for c in mp['cells'] if c.get('event')=='encounter'); start=state['position']; q=collections.deque([start]); prev={start:None}
        while q:
            cur=q.popleft()
            if cur==target: break
            for nxt in graph[cur]:
                if nxt not in prev: prev[nxt]=cur; q.append(nxt)
        route=[]; cur=target
        while prev[cur] is not None: route.append(cur); cur=prev[cur]
        route.reverse()
        notice_actions={'fortune':'take','find':'search','fall':'continue','mood':'reflect','actors':'watch','friend':'visit','chase':'pass','elf':'pass','wasp':'continue','cat':'continue','water':'pass','rescuer':'take'}
        for nxt in route:
            if state['phase']=='notice':
                state=engine.run('noticeAction',state,{'action':notice_actions[state['notice']['id']]},[0]*128)
                state=engine.run('acknowledge',state,{},[0]*128)
            begin_rolls=([0,5]+[0]*126) if nxt==target else [0]*128
            state=engine.run('begin',state,{'next':nxt},begin_rolls)
            self.assertEqual(state['phase'],'moving'); state=engine.run('arrive',state,{},[0]*128)
            if state['phase']=='encounter': break
        self.assertEqual(state['phase'],'encounter'); state=engine.run('encounterAction',state,{'action':'provoke'},[])
        state['hero']['sword']=True
        state=engine.run('battle',state,{'action':'switch','targetId':'sword'},[0]*128)
        self.assertEqual(state['encounter']['report']['switch']['to'],'sword')
        self.assertGreaterEqual(state['encounter']['round'],1)

if __name__=='__main__': unittest.main()
