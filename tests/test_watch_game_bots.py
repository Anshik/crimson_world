import copy
import json
from pathlib import Path
import random
import tempfile
import unittest

from tools.watch_game_bots import PersistentBot, RolePolicy, ROLES, TRANSPORT_ERRORS

ROOT=Path(__file__).resolve().parents[1]


class ContinuousBotTests(unittest.TestCase):
    def stocked_at_forge(self):
        policy=RolePolicy(ROOT)
        state=policy.engine.run('createCharacter',None,{'profile':{'name':'Тест','sex':'male','race':'dwarf','origin':'dwarf','class':'warrior'}})
        state['position']=policy.cells['forge'];state['hero'].update(coins=14,food=5)
        state=policy.engine.run('service',state,{'action':'shield'})
        return policy,state

    def test_only_fighting_roles_buy_sword(self):
        policy,state=self.stocked_at_forge()
        for role in ROLES:
            with self.subTest(role=role):
                decision=policy.decide_role(copy.deepcopy(state),{'shifts':4,'cell_visits':{}},role)
                if role in ('aggressive','balanced','hunter'):
                    self.assertEqual(decision,('service',{'action':'sword'}))
                else:
                    self.assertNotEqual(decision,('service',{'action':'sword'}))

    def test_trader_sells_unused_sword_and_keeps_starting_weapon_and_shield(self):
        policy,state=self.stocked_at_forge()
        state=policy.engine.run('service',state,{'action':'sword'})
        state['position']=policy.cells['shop']
        method,args=policy.decide_role(state,{'shifts':4,'cell_visits':{}},'trader')
        self.assertEqual((method,args),('service',{'action':'sell-sword'}))
        sold=policy.engine.run(method,state,args,[0]*128)
        self.assertFalse(sold['hero']['sword'])
        self.assertEqual(sold['hero']['equipment']['mainHand'],'shortSword')
        self.assertTrue(sold['hero']['shield'])
        self.assertEqual(sold['hero']['coins'],4)
        sold['position']=policy.cells['forge'];sold['hero']['coins']=8
        self.assertNotEqual(policy.decide_role(sold,{'shifts':4,'cell_visits':{}},'trader'),('service',{'action':'sword'}))

    def test_trader_tries_another_buyer_after_refusal_without_repeating_sale(self):
        policy,state=self.stocked_at_forge()
        state=policy.engine.run('service',state,{'action':'sword'})
        state['position']=policy.cells['shop']
        refused=policy.engine.run('service',state,{'action':'sell-sword'},[5]*128)
        self.assertTrue(refused['hero']['sword'])
        decision=policy.decide_role(refused,{'shifts':4,'cell_visits':{}},'trader')
        self.assertEqual(decision[0],'begin')
        expected_path=json.loads(policy.route(refused['position'],policy.cells['far-shop']))
        self.assertEqual(decision[1]['next'],expected_path[1])

    def test_trader_waits_for_opening_but_does_not_wait_out_refused_demand(self):
        policy,state=self.stocked_at_forge()
        state=policy.engine.run('service',state,{'action':'sword'})
        state['position']=policy.cells['shop'];state['hero'].update(coins=10,food=20)
        state['quest']='complete';state['ticks']=12
        memory={'shifts':4,'cell_visits':{}}
        self.assertEqual(policy.decide_role(state,memory,'trader'),('service',{'action':'wait-opening'}))
        state['shopInterest']={shop:{'day':1,'items':{'sword':6}} for shop in ('shop','far-shop')}
        # Both buyers already refused today: continue finding goods, instead
        # of waiting or shuttling between unavailable buyers.
        method,args=policy.decide_role(state,memory,'trader')
        self.assertEqual(method,'begin')
        self.assertIn('target_cell',memory)

    def test_trader_sells_finds_without_selling_protection_or_healing_stock(self):
        policy,state=self.stocked_at_forge()
        state['position']=policy.cells['shop']
        state['hero']['finds'].update(defenseRing=1,platinumRing=1)
        state=policy.engine.run('equip',state,{'slot':'ring','id':'defenseRing'})
        state['hero']['potions']=2
        method,args=policy.decide_role(state,{'shifts':4,'cell_visits':{}},'trader')
        self.assertEqual((method,args),('service',{'action':'sell-platinumRing'}))
        state=policy.engine.run(method,state,args)
        method,args=policy.decide_role(state,{'shifts':4,'cell_visits':{}},'trader')
        self.assertNotIn(args.get('action'),('sell-defenseRing','sell-shield','sell-potion','sword'))

    def test_all_roles_keep_making_legal_decisions(self):
        for index,role in enumerate(ROLES):
            with self.subTest(role=role):
                policy=RolePolicy(ROOT);rng=random.Random(170+index)
                state=policy.engine.run('createCharacter',None,{'profile':{'name':'Тест','sex':'male','race':'dwarf','origin':'dwarf','class':'warrior'}})
                memory={'shifts':0,'cell_visits':{}}
                for _ in range(800):
                    method,args=policy.decide_role(json.loads(json.dumps(state,sort_keys=True)),memory,role)
                    before=state
                    state=policy.engine.run(method,state,args,[rng.getrandbits(32) for _ in range(128)])
                    if method=='finishWork': memory['shifts']+=1
                    if before['position']!=state['position']:
                        visits=memory['cell_visits'];visits[state['position']]=visits.get(state['position'],0)+1
                self.assertGreater(state['turn'],30)
                self.assertGreater(len(memory['cell_visits']),10)

    def test_lost_response_and_process_restart_replay_same_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            credential={'username':'qa-test','password':'test-only','role':'balanced','interval':8}
            bot=PersistentBot(credential,'http://localhost',Path(tmp))
            bot.state={'marker':'before'};bot.revision=10
            class Choose:
                def decide_role(self,*_): return 'service',{'action':'food'}
            bot.prepare(Choose());original=copy.deepcopy(bot.pending)
            committed={};calls=[]
            class Wire:
                def call(self,path,payload=None):
                    if path=='/api/auth/login': return {}
                    if path=='/api/me': return {'user':{'id':7},'state':{'marker':'after'},'revision':11}
                    calls.append(copy.deepcopy(payload))
                    key=payload['commandId']
                    if key not in committed:
                        committed[key]={'state':{'marker':'after'},'revision':11}
                        raise ConnectionResetError(104,'Connection reset by peer')
                    return committed[key]
            wire=Wire();bot.client=wire
            with self.assertRaises(TRANSPORT_ERRORS): bot.execute()
            # Simulate SIGKILL: only the pre-request checkpoint is available.
            resumed=PersistentBot(credential,'http://localhost',Path(tmp));resumed.client=wire
            resumed.connect()
            self.assertEqual(resumed.state,{'marker':'before'})
            self.assertEqual(resumed.execute(),{'marker':'before'})
            self.assertEqual(resumed.state,{'marker':'after'})
            self.assertEqual(resumed.pending,original)
            self.assertEqual(calls[0],calls[1])
            self.assertEqual(len(committed),1)
            self.assertEqual(resumed.actions,1)

    def test_cautious_and_aggressive_choose_different_responses(self):
        policy=RolePolicy(ROOT)
        state=policy.engine.run('createCharacter',None,{'profile':{'name':'Тест','sex':'male','race':'dwarf','origin':'dwarf','class':'warrior'}})
        state.update(phase='encounter',encounter={'hostile':True,'demand':2,'enemies':[{'id':'bandit-1','hp':8}]})
        state['hero']['coins']=3
        self.assertEqual(policy.decide_role(state,{'shifts':0},'cautious'),('encounterAction',{'action':'pay'}))
        self.assertEqual(policy.decide_role(state,{'shifts':0},'aggressive'),('battle',{'action':'attack','targetId':'bandit-1'}))


if __name__=='__main__': unittest.main()
