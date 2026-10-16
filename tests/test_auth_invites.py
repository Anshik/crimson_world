import sqlite3, tempfile, unittest, os, subprocess, sys, time, json, collections
from concurrent.futures import ThreadPoolExecutor
from server.core import Store

class InviteAuthTests(unittest.TestCase):
    def test_one_invite_allows_exactly_one_parallel_registration(self):
        store=Store(tempfile.mktemp()); code=store.create_invites(1)[0][1]
        def attempt(i):
            try: return store.register(f'player{i}','long-pass-1',code)[0]
            except ValueError: return None
        with ThreadPoolExecutor(max_workers=8) as pool: result=list(pool.map(attempt,range(8)))
        self.assertEqual(sum(x is not None for x in result),1)

    def test_invite_link_forms_extract_exactly_and_remain_one_time(self):
        store=Store(tempfile.mktemp())
        forms=('raw','equals','invite','hash','url')
        for i, form in enumerate(forms):
            code=store.create_invites(1)[0][1]
            wrapped={'raw':code,'equals':'='+code,'invite':'invite='+code,
                     'hash':'#invite='+code,'url':'https://example.test/register#invite='+code}[form]
            store.register(f'formuser{i}','long-pass-1',wrapped)
            with self.assertRaises(ValueError): store.register(f'duplicate{i}','long-pass-1',wrapped)

    def test_invite_normalization_does_not_change_token_or_spend_on_bad_forms(self):
        store=Store(tempfile.mktemp()); code=store.create_invites(1)[0][1]
        for bad in ('=='+code, '#invite='+code+'&other=x', code.upper()):
            with self.assertRaises(ValueError): store.register('badform','long-pass-1',bad)
        # A full link consumes the exact code; its bare form cannot be reused.
        store.register('fullurl','long-pass-1',' https://example.test/register#invite='+code+' ')
        with self.assertRaises(ValueError): store.register('bareagain','long-pass-1',code)
        self.assertIsNone(Store.normalize_invite_code('http://[invalid'))

    def test_find_notice_keeps_item_hidden_until_search_then_persists_id(self):
        """The public pre-action state identifies only the card; the result stores the exact find id."""
        store=Store(tempfile.mktemp()); engine=store.engine
        mp=json.loads(open('assets/maps/geometry/tovilis-v9.json',encoding='utf-8').read())
        graph={c['id']:[] for c in mp['cells']}
        for edge in mp['edges']:
            if edge['bidirectional']:
                graph[edge['from']].append(edge['to']); graph[edge['to']].append(edge['from'])
        expected=('glass','defenseRing','caneKnob','platinumRing','almaMedallion','chrysoberyl')
        for value,item_id in enumerate(expected,1):
            state=engine.run('createCharacter',None,{'profile':{'name':'Герой','sex':'male','race':'dwarf','origin':'dwarf','class':'warrior'}},[])
            # A previous find must not affect identification of the current result.
            state['hero']['finds']={'caneKnob':1}
            queue=collections.deque([state['position']]); previous={state['position']:None}
            while queue:
                cell=queue.popleft()
                if cell=='Q10': break
                for nxt in graph[cell]:
                    if nxt not in previous: previous[nxt]=cell; queue.append(nxt)
            route=[]; cell='Q10'
            while previous[cell] is not None: route.append(cell); cell=previous[cell]
            route.reverse()
            for nxt in route:
                # Movement roll, notice-card roll (=2, the find card), then find roll.
                rolls=([0,1,value-1]+[0]*125) if nxt=='Q10' else [0]*128
                state=engine.run('begin',state,{'next':nxt},rolls)
                state=engine.run('arrive',state,{},[0]*128)
            self.assertEqual(state['phase'],'notice')
            self.assertEqual(state['notice']['id'],'find')
            self.assertEqual(state['hero']['finds'],{'caneKnob':1})
            self.assertIsNone(engine.notice_find(state))
            state=engine.run('noticeAction',state,{'action':'search'},[value-1])
            self.assertEqual(state['hero']['finds'].get(item_id), 2 if item_id == 'caneKnob' else 1)
            self.assertEqual(state['notice']['stage'],'result')
            self.assertEqual(engine.notice_find(state)['id'],item_id)
            state=engine.run('acknowledge',state,{},[0]*128)
            self.assertIsNone(engine.notice_find(state))

    def test_old_email_accounts_migrate_without_child_id_changes(self):
        path=tempfile.mktemp(); c=sqlite3.connect(path)
        c.executescript("""
        PRAGMA foreign_keys=OFF;
        CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL,created_at INTEGER,admin INTEGER DEFAULT 0);
        INSERT INTO users VALUES(7,'Veteran@example.com','scrypt$x$y',1,0);
        CREATE TABLE game_states(user_id INTEGER PRIMARY KEY,state TEXT,revision INTEGER,updated_at INTEGER,FOREIGN KEY(user_id) REFERENCES users(id));
        CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id INTEGER,csrf TEXT,created_at INTEGER,last_seen INTEGER,FOREIGN KEY(user_id) REFERENCES users(id));
        INSERT INTO game_states VALUES(7,'{}',3,4); INSERT INTO sessions VALUES('h',7,'c',1,1);
        """); c.commit(); c.close()
        store=Store(path)
        with store.db() as db:
            self.assertEqual(db.execute('SELECT id,username,legacy_login FROM users').fetchone()[0],7)
            self.assertEqual(db.execute('SELECT user_id,revision FROM game_states').fetchone()[1],3)
            self.assertEqual(db.execute('SELECT user_id FROM sessions').fetchone()[0],7)
            self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(),[])

    def test_email_is_not_accepted_as_new_registration_alias(self):
        store=Store(tempfile.mktemp()); code=store.create_invites(1)[0][1]
        with self.assertRaises(ValueError): store.register('new@example.com','long-pass-1',code)

    def test_invalid_revoked_expired_invites_are_not_consumed(self):
        store=Store(tempfile.mktemp())
        with self.assertRaises(ValueError): store.register('baduser','long-pass-1','not-a-code')
        revoked_id, revoked=store.create_invites(1)[0]
        self.assertTrue(store.revoke_invite(revoked_id))
        with self.assertRaises(ValueError): store.register('revoked','long-pass-1',revoked)
        expired_id, expired=store.create_invites(1)[0]
        with store.db() as db: db.execute('UPDATE invites SET expires_at=? WHERE id=?',(int(time.time())-1,expired_id))
        with self.assertRaises(ValueError): store.register('expired','long-pass-1',expired)
        with store.db() as db:
            self.assertEqual(db.execute('SELECT used_at FROM invites WHERE id=?',(revoked_id,)).fetchone()[0],None)
            self.assertEqual(db.execute('SELECT used_at FROM invites WHERE id=?',(expired_id,)).fetchone()[0],None)

    def test_username_casefold_and_unicode_duplicate(self):
        store=Store(tempfile.mktemp())
        code=store.create_invites(2)
        store.register('Ёжик','long-pass-1',code[0][1])
        with self.assertRaises(ValueError): store.register('ёжик','long-pass-1',code[1][1])

    def test_migration_preserves_cascade_children(self):
        path=tempfile.mktemp(); c=sqlite3.connect(path)
        c.executescript("""
        PRAGMA foreign_keys=OFF;
        CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL,created_at INTEGER,admin INTEGER DEFAULT 0);
        INSERT INTO users VALUES(4,'cascade@example.com','scrypt$x$y',1,0);
        CREATE TABLE game_states(user_id INTEGER PRIMARY KEY,state TEXT,revision INTEGER,updated_at INTEGER,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
        CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id INTEGER,csrf TEXT,created_at INTEGER,last_seen INTEGER,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
        CREATE TABLE presence(user_id INTEGER PRIMARY KEY,cell TEXT,updated_at INTEGER,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
        INSERT INTO game_states VALUES(4,'{}',0,1); INSERT INTO sessions VALUES('h',4,'c',1,1); INSERT INTO presence VALUES(4,'J01',1);
        """); c.commit(); c.close()
        store=Store(path)
        with store.db() as db:
            self.assertEqual(db.execute('SELECT state,revision FROM game_states WHERE user_id=4').fetchone()[:],('{}',0))
            self.assertEqual(db.execute('SELECT token_hash,csrf FROM sessions WHERE user_id=4').fetchone()[:],('h','c'))
            self.assertEqual(db.execute('SELECT cell FROM presence WHERE user_id=4').fetchone()[0],'J01')
            db.execute('DELETE FROM users WHERE id=4')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM game_states').fetchone()[0],0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0],0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM presence').fetchone()[0],0)
            self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(),[])

    def test_cli_invite_create_and_reset_password(self):
        path=tempfile.mktemp(); env={**os.environ,'CRIMSON_DB':path}
        created=subprocess.run([sys.executable,'-m','server.admin','invite-create','--count','1'],env=env,text=True,capture_output=True,check=True)
        invite_id, code=created.stdout.strip().split('\t')
        store=Store(path); uid,_,_=store.register('cliuser','old-pass-1',code)
        reset=subprocess.run([sys.executable,'-m','server.admin','reset-password','cliuser'],env=env,text=True,capture_output=True,check=True)
        self.assertTrue(store.reset_password(reset.stdout.strip(),'new-pass-1'))
        listed=subprocess.run([sys.executable,'-m','server.admin','invite-list'],env=env,text=True,capture_output=True,check=True)
        self.assertIn(str(invite_id),listed.stdout)

    def test_admin_reset_token_is_single_use_and_revokes_sessions(self):
        store=Store(tempfile.mktemp()); uid,_,session=store.register('recoverme','old-pass-1',store.create_invites(1)[0][1]); token=store.issue_reset('recoverme'); self.assertIsNotNone(token)
        self.assertTrue(store.reset_password(token,'new-pass-1')); self.assertIsNone(store.session(session)); self.assertFalse(store.reset_password(token,'third-pass'))
        self.assertIsNotNone(store.authenticate('recoverme','new-pass-1'))

if __name__=='__main__': unittest.main()
