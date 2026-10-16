"""Admin boundaries, durable history, migration and cross-player changes."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import server.app as web
from server.core import Store

PROFILE = {'name':'Игрок', 'sex':'male', 'race':'dwarf', 'origin':'dwarf', 'class':'warrior'}


class AdminTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = web.store
        self.store = Store(Path(self.temp.name)/'test.sqlite')
        web.store = self.store
        web._attempts.clear()
        self.env = patch.dict(os.environ, {'ADMIN_LOGINS':'operator'})
        self.env.start()
        self.uid, _, self.token = self.store.register('operator','long-pass-1',self.store.create_invites()[0][1])
        self.client = web.app.test_client()
        self.client.set_cookie('cw_session', self.token)
        self.csrf = self.store.session(self.token)['csrf']
        with self.store.db() as c: c.execute('UPDATE users SET admin=1 WHERE id=?',(self.uid,))

    def tearDown(self):
        web.store = self.previous
        self.env.stop()
        self.temp.cleanup()

    def detail(self):
        result = self.client.get(f'/api/admin/players/{self.uid}')
        self.assertEqual(result.status_code,200)
        return result.json

    def activate(self, uid=None):
        uid = uid or self.uid
        return self.store.command(uid,'character',0,'createCharacter',{'profile':PROFILE})

    def test_access_requires_session_flag_and_allowlist(self):
        anonymous = web.app.test_client()
        for route in ('/admin','/api/admin/players',f'/api/admin/players/{self.uid}','/api/admin/feedback'):
            self.assertEqual(anonymous.get(route).status_code,401)
        with self.store.db() as c: c.execute('UPDATE users SET admin=0')
        self.assertEqual(self.client.get('/api/admin/players').status_code,403)
        with self.store.db() as c: c.execute('UPDATE users SET admin=1')
        with patch.dict(os.environ, {'ADMIN_LOGINS':'someone_else'}):
            self.assertFalse(self.client.get('/api/me').json['user']['isAdmin'])
            self.assertEqual(self.client.get('/admin').status_code,403)
        self.assertTrue(self.client.get('/api/me').json['user']['isAdmin'])
        self.assertEqual(self.client.get('/admin').status_code,200)

    def test_private_fields_never_leave_admin_api_and_cache_disabled(self):
        response = self.client.get('/api/admin/players')
        self.assertEqual(response.headers['Cache-Control'],'no-store')
        detail = self.detail()
        for payload in (response.json,detail):
            text = json.dumps(payload)
            for secret in ('scrypt$', 'token_hash', 'legacy_login', 'request_hash', self.csrf):
                self.assertNotIn(secret,text)
        self.assertEqual(self.client.get('/api/admin/players/99999').status_code,404)

    def test_bot_changes_require_csrf_and_are_audited_once(self):
        path = f'/api/admin/players/{self.uid}'
        self.assertEqual(self.client.post(path,json={'isBot':True}).status_code,403)
        headers = {'X-CSRF-Token':self.csrf}
        self.assertEqual(self.client.post(path,json={'isBot':'true'},headers=headers).status_code,400)
        for _ in range(2): self.assertEqual(self.client.post(path,json={'isBot':True},headers=headers).status_code,200)
        result = self.detail()
        self.assertEqual(result['player']['is_bot'],1)
        self.assertEqual(len(result['audit']),1)
        self.assertEqual(result['audit'][0]['actor'],self.uid)
        self.assertEqual(self.client.post(path,json={'isBot':False},headers={**headers,'Origin':'https://other.test'}).status_code,403)

    def test_replay_invalid_commands_and_rolled_back_history(self):
        self.activate()
        first = self.store.command(self.uid,'rename',1,'rename',{'name':'Новое имя'})
        self.assertEqual(first,self.store.command(self.uid,'rename',1,'rename',{'name':'Новое имя'}))
        with self.assertRaises(ValueError): self.store.command(self.uid,'bad',2,'equip',{'slot':'bad','id':'fake'})
        result = self.detail()
        self.assertEqual([e['method'] for e in result['events']],['registration','createCharacter','rename'])
        self.assertEqual(result['events'][-1]['changes']['name'],{'before':'Игрок','after':'Новое имя'})
        self.assertEqual(sum(e['turns'] for e in result['events']),0)
        with patch('server.core.record_event',side_effect=RuntimeError('disk error')):
            with self.assertRaises(RuntimeError): self.store.command(self.uid,'rollback',2,'rename',{'name':'Не сохранить'})
        self.assertEqual(self.store.state(self.uid),first)
        self.assertEqual(len(self.detail()['events']),3)

    def test_completed_turns_and_journal_survive_ring_buffer(self):
        from server.monitoring import record_event
        before={'turn':10,'hero':{'hp':5},'journal':[{'turn':i,'text':str(i)} for i in range(80)]}
        after={'turn':11,'hero':{'hp':4},'journal':before['journal'][1:]+[{'turn':11,'text':'New'}]}
        with self.store.db() as c: record_event(c,self.uid,1,'acknowledge',{},before,after)
        event=self.detail()['events'][-1]
        self.assertEqual(event['turns'],1)
        self.assertEqual(event['journal'],[{'turn':11,'text':'New'}])
        self.assertEqual(event['changes']['hp'],{'before':5,'after':4})

    def test_existing_players_get_one_baseline_without_fake_dates(self):
        self.activate()
        with self.store.db() as c: c.execute('DELETE FROM player_events')
        self.store.init_db()
        self.store.init_db()
        result = self.detail()
        self.assertEqual(len(result['events']),1)
        self.assertEqual(result['events'][0]['method'],'baseline')
        self.assertEqual(result['events'][0]['turns'],0)
        self.assertEqual(result['legacyCommands'],1)
        self.assertTrue(result['legacyJournal'])

    def test_legacy_history_recovers_more_than_the_current_journal_limit(self):
        from server.monitoring import recover_legacy_journal
        entries = [{'turn':i,'text':f'event {i}'} for i in range(160)]
        rows = [{'response':json.dumps({'journal':entries[:80]})},
                {'response':json.dumps({'journal':entries[40:120]})},
                {'response':json.dumps({'journal':entries[80:]})}]
        self.assertEqual(recover_legacy_journal(rows,entries[80:]),entries)
        self.assertEqual(recover_legacy_journal([],entries[-80:]),entries[-80:])

    def test_bot_invites_classify_new_accounts_without_trusting_public_payload(self):
        code=self.store.create_invites(is_bot=True)[0][1]
        client=web.app.test_client()
        response=client.post('/api/auth/register',json={'username':'newbot','password':'long-pass-1','inviteCode':code,'isBot':False})
        self.assertEqual(response.status_code,200)
        uid=response.json['user']['id']
        self.assertEqual(self.client.get(f'/api/admin/players/{uid}').json['player']['is_bot'],1)
        code=self.store.create_invites()[0][1]
        response=client.post('/api/auth/register',json={'username':'newhuman','password':'long-pass-1','inviteCode':code,'isBot':True})
        self.assertEqual(response.status_code,200)
        uid=response.json['user']['id']
        self.assertEqual(self.client.get(f'/api/admin/players/{uid}').json['player']['is_bot'],0)

    def test_last_seen_survives_logout(self):
        self.client.post('/api/auth/logout',headers={'X-CSRF-Token':self.csrf})
        with self.store.db() as c:
            self.assertIsNotNone(c.execute('SELECT last_seen FROM users WHERE id=?',(self.uid,)).fetchone()[0])

    def test_trade_records_both_players_and_no_completed_turn(self):
        self.activate()
        uid, _, token = self.store.register('recipient','long-pass-1',self.store.create_invites()[0][1])
        self.activate(uid)
        recipient=web.app.test_client();recipient.set_cookie('cw_session',token)
        offered=self.client.post('/api/trades/offers',json={'recipient':uid,'payload':{'coins':1}},headers={'X-CSRF-Token':self.csrf})
        self.assertEqual(offered.status_code,200)
        accepted=recipient.post('/api/trades/offers/'+offered.json['id']+'/accept',headers={'X-CSRF-Token':self.store.session(token)['csrf']})
        self.assertEqual(accepted.status_code,200)
        sender_event=self.detail()['events'][-1]
        recipient_event=self.client.get(f'/api/admin/players/{uid}').json['events'][-1]
        self.assertEqual(sender_event['method'],'trade_sent')
        self.assertEqual(recipient_event['method'],'trade_received')
        self.assertEqual(sender_event['changes']['coins'],{'before':1,'after':0})
        self.assertEqual(recipient_event['changes']['coins'],{'before':1,'after':2})
        self.assertEqual(sender_event['turns']+recipient_event['turns'],0)


if __name__ == '__main__': unittest.main()
