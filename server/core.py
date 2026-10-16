"""Authoritative game and persistence services for the online Tovilis pilot."""
from __future__ import annotations

import hashlib, hmac, json, os, secrets, sqlite3, threading, time
import re, unicodedata
from urllib.parse import urlsplit
from pathlib import Path
from typing import Any
from .monitoring import init_monitoring, record_event

ROOT = Path(__file__).resolve().parents[1]


class GameEngine:
    """Run the browser's rule module in QuickJS; Python owns entropy and state."""
    METHODS = {"create", "createCharacter", "choose", "begin", "arrive", "acknowledge",
               "huntAction", "noticeAction", "encounterAction", "service", "equip", "battle", "playDice",
               "finishWork", "cancelWork", "drink", "rename", "bankTransfer"}

    def __init__(self, base: Path = ROOT):
        import quickjs
        self.ctx = quickjs.Context()
        if hasattr(self.ctx, 'set_memory_limit'): self.ctx.set_memory_limit(64 * 1024 * 1024)
        if hasattr(self.ctx, 'set_time_limit'): self.ctx.set_time_limit(2.0)
        self.ctx.eval("globalThis.window=globalThis; Object.hasOwn ||= function(o,k){return Object.prototype.hasOwnProperty.call(o,k)}; Array.prototype.at ||= function(n){return this[n<0?this.length+n:n]}; String.prototype.at ||= function(n){return this[n<0?this.length+n:n]};")
        if (base / "game" / "characters.js").exists(): self.ctx.eval((base / "game" / "characters.js").read_text(encoding="utf-8"))
        else: self.ctx.eval("globalThis.TOVILIS_CHARACTERS={baseFor:function(h,b){return {strength:3,agility:4,defense:3,maxHp:16}}};")
        for name in ("content.js", "equipment.js", "rules.js"):
            self.ctx.eval((base / "game" / name).read_text(encoding="utf-8"))
        mp = json.loads((base / "assets/maps/geometry/tovilis-v9.json").read_text(encoding="utf-8"))
        self.ctx.eval("globalThis.__rules = createTovilisRules(%s);" % json.dumps(mp, ensure_ascii=False, separators=(",", ":")))
        self.ctx.eval("""
          globalThis.__callRules = function(method, stateJson, argsJson, rollsJson) {
            var state=JSON.parse(stateJson), args=JSON.parse(argsJson), rolls=JSON.parse(rollsJson);
            var i=0; var die=function(sides){ if (!Number.isSafeInteger(sides) || sides<1 || sides>1000) throw new Error('invalid dice sides'); var limit=Math.floor(4294967296/sides)*sides, v; do { v=rolls[i++]; if (v === undefined) throw new Error('server dice exhausted'); } while (v>=limit); return (v%sides)+1; };
            var r=__rules;
            if (method === 'create') return r.create(args.name);
            if (method === 'createCharacter') return r.createCharacter ? r.createCharacter(args.profile) : r.create(args.name);
            if (method === 'choose') return r.choose(state,args.next,args.stopBuilding ?? null);
            if (method === 'begin') { if (args.next !== undefined) state=r.choose(state,args.next,args.stopBuilding ?? null); return r.begin(state,die); }
            if (method === 'arrive') return r.arrive(state);
            if (method === 'acknowledge') return r.acknowledge(state);
            if (method === 'huntAction') return r.huntAction(state,args.action,die,args.target ?? 0);
            if (method === 'noticeAction') return r.noticeAction(state,args.action,die);
            if (method === 'encounterAction') return r.encounterAction(state,args.action);
            if (method === 'service') return r.service(state,args.action,die,args.quantity ?? 1);
            if (method === 'bankTransfer') return r.bankTransfer(state,args.action,args.amount);
            if (method === 'equip') return r.equip(state,args.slot,args.id);
            if (method === 'battle') return r.battle(state,args.action,die,args.targetId ?? null);
            if (method === 'playDice') return r.playDice(state,die,args.stake ?? 1);
            if (method === 'finishWork') return r.finishWork(state,die);
            if (method === 'cancelWork') return r.cancelWork(state);
            if (method === 'drink') return r.drink(state);
            if (method === 'rename') return r.rename(state,args.name);
            throw new Error('method not allowlisted');
          };
          globalThis.__callRulesJSON = function(method, stateJson, argsJson, rollsJson) { var out=__callRules(method,stateJson,argsJson,rollsJson); __rules.validate(out); return JSON.stringify(out); };
          globalThis.__noticeFindJSON = function(stateJson) { return JSON.stringify(__rules.noticeFind(JSON.parse(stateJson))); };
        """)
        self.lock = threading.RLock()

    def run(self, method: str, state: dict | None, args: dict | None = None, rolls: list[int] | None = None) -> dict:
        if method not in self.METHODS:
            raise ValueError("method is not available online")
        args, rolls = args or {}, rolls or []
        with self.lock:
            try:
                result = json.loads(self.ctx.get("__callRulesJSON")(method, json.dumps(state, ensure_ascii=False), json.dumps(args, ensure_ascii=False), json.dumps(rolls)))
            except Exception as exc:
                raise ValueError(str(exc)) from exc
        if not isinstance(result, dict):
            raise ValueError("rules returned invalid state")
        return result

    def notice_find(self, state: dict) -> dict | None:
        with self.lock:
            return json.loads(self.ctx.get("__noticeFindJSON")(json.dumps(state, ensure_ascii=False)))


def _hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    value = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)
    return "scrypt$%s$%s" % (salt.hex(), value.hex())


def _check_password(password: str, stored: str) -> bool:
    try:
        _, salt, value = stored.split("$", 2)
        actual = _hash_password(password, bytes.fromhex(salt)).split("$", 2)[2]
        return hmac.compare_digest(actual, value)
    except (ValueError, TypeError):
        return False


class Store:
    SESSION_TTL = 60 * 60 * 24 * 30
    def __init__(self, path: str | Path = os.environ.get("CRIMSON_DB", str(ROOT / "data" / "crimsonworld.sqlite")), engine: GameEngine | None = None):
        self.path = str(path); Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.engine = engine or GameEngine()
        self.lock = threading.RLock()
        self.init_db()

    def db(self):
        c = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys=ON"); c.execute("PRAGMA journal_mode=WAL")
        return c

    def init_db(self):
        with self.db() as c:
            # Critical migration seam: preserve user IDs referenced by every child table.
            # SQLite only permits changing the NOT NULL email schema with foreign keys off.
            c.execute("PRAGMA foreign_keys=OFF")
            if c.execute("PRAGMA foreign_keys").fetchone()[0] != 0: raise RuntimeError("could not disable foreign keys for users migration")
            user_cols={r[1] for r in c.execute("PRAGMA table_info(users)")}
            email_notnull=any(r[1]=='email' and r[3] for r in c.execute("PRAGMA table_info(users)"))
            if user_cols and ("username" not in user_cols or "username_key" not in user_cols or "legacy_login" not in user_cols or email_notnull):
                c.execute("BEGIN IMMEDIATE")
                c.execute("CREATE TABLE users_new(id INTEGER PRIMARY KEY, username TEXT NOT NULL, username_key TEXT UNIQUE NOT NULL, legacy_login TEXT UNIQUE, password TEXT NOT NULL, created_at INTEGER NOT NULL, admin INTEGER NOT NULL DEFAULT 0)")
                legacy_source='email' if 'email' in user_cols else 'legacy_login'
                username_source='username' if 'username' in user_cols else 'NULL'
                rows=c.execute(f"SELECT id,{legacy_source},password,created_at,admin,{username_source} FROM users ORDER BY id").fetchall()
                used=set()
                for uid,legacy_login,password,created,admin,existing_username in rows:
                    stem=re.sub(r"[^\w.-]+","-",unicodedata.normalize('NFKC',existing_username or (legacy_login or 'player').split('@')[0]),flags=re.UNICODE).strip('-._') or 'player'
                    display=stem[:24]; key=unicodedata.normalize('NFKC',display).casefold()
                    suffix=0
                    while key in used:
                        tail=f'-{uid}' if suffix == 0 else f'-{uid}-{suffix}'
                        display=stem[:24-len(tail)]+tail; key=display.casefold(); suffix+=1
                    used.add(key); c.execute("INSERT INTO users_new VALUES(?,?,?,?,?,?,?)",(uid,display,key,legacy_login,password,created,admin))
                c.execute("DROP TABLE users"); c.execute("ALTER TABLE users_new RENAME TO users"); violations=c.execute("PRAGMA foreign_key_check").fetchall()
                if violations: c.execute("ROLLBACK"); raise RuntimeError("users migration foreign-key check failed")
                c.execute("COMMIT")
            c.executescript("""
            CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT NOT NULL, username_key TEXT UNIQUE NOT NULL, legacy_login TEXT UNIQUE, password TEXT NOT NULL, created_at INTEGER NOT NULL, admin INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS recovery_tokens(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL, used_at INTEGER);
            CREATE TABLE IF NOT EXISTS invites(id INTEGER PRIMARY KEY AUTOINCREMENT, code_hash TEXT UNIQUE NOT NULL, label TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, used_by INTEGER REFERENCES users(id), revoked_at INTEGER);
            CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS game_states(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS commands(user_id INTEGER NOT NULL, command_id TEXT NOT NULL, revision INTEGER NOT NULL, request_hash TEXT NOT NULL DEFAULT '', response TEXT NOT NULL, PRIMARY KEY(user_id,command_id));
            CREATE TABLE IF NOT EXISTS presence(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, cell TEXT NOT NULL, facing TEXT, sex TEXT, race TEXT, origin TEXT, class_id TEXT, revision INTEGER NOT NULL DEFAULT 0, seen_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS chat(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS offers(id TEXT PRIMARY KEY, sender INTEGER NOT NULL, recipient INTEGER NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS feedback(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, context TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS unique_items(item_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, updated_at INTEGER NOT NULL);
            DROP TABLE IF EXISTS email_tokens;
            """)
            cols={r[1] for r in c.execute("PRAGMA table_info(commands)")}
            if "request_hash" not in cols: c.execute("ALTER TABLE commands ADD COLUMN request_hash TEXT NOT NULL DEFAULT ''")
            pcols={r[1] for r in c.execute("PRAGMA table_info(presence)")}
            for name, definition in (("sex","TEXT"),("race","TEXT"),("origin","TEXT"),("class_id","TEXT"),("revision","INTEGER NOT NULL DEFAULT 0")):
                if name not in pcols: c.execute(f"ALTER TABLE presence ADD COLUMN {name} {definition}")
            c.execute("PRAGMA foreign_keys=ON")
            init_monitoring(c)

    def register(self, username: str, password: str, invite_code: str | None = None) -> tuple[int, str, str]:
        if not isinstance(username,str): raise ValueError("Некорректный логин.")
        username=unicodedata.normalize('NFKC',username).strip()
        if not re.fullmatch(r"[A-Za-zА-Яа-яЁё0-9_.-]{3,24}",username) or '@' in username: raise ValueError("Некорректный логин.")
        key=username.casefold()
        if not isinstance(password,str) or len(password) < 8 or len(password) > 128: raise ValueError("Некорректный пароль (минимум 8 символов).")
        invite_code = self.normalize_invite_code(invite_code)
        if invite_code is None: raise ValueError("Нужен действующий код приглашения.")
        digest=hashlib.sha256(invite_code.encode()).hexdigest(); now=int(time.time())
        with self.lock, self.db() as c:
            c.execute("BEGIN IMMEDIATE")
            if c.execute("SELECT COUNT(*) FROM users").fetchone()[0] >= 10: raise ValueError("Регистрация временно закрыта: достигнут лимит 10 игроков.")
            invite=c.execute("SELECT id,is_bot FROM invites WHERE code_hash=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?",(digest,now)).fetchone()
            if not invite: raise ValueError("Нужен действующий код приглашения.")
            try: c.execute("INSERT INTO users(username,username_key,legacy_login,password,created_at,is_bot) VALUES(?,?,?,?,?,?)", (username,key,None,_hash_password(password), now,invite["is_bot"]))
            except sqlite3.IntegrityError: raise ValueError("Такой логин уже зарегистрирован.")
            uid = c.execute("SELECT last_insert_rowid()").fetchone()[0]
            state = self.engine.run("create", None, {"name": username})
            c.execute("INSERT INTO game_states(user_id,state,updated_at) VALUES(?,?,?)", (uid, json.dumps(state, ensure_ascii=False), int(time.time())))
            record_event(c, uid, 0, "registration", {}, None, state)
            if c.execute("UPDATE invites SET used_at=?,used_by=? WHERE id=? AND used_at IS NULL",(now,uid,invite[0])).rowcount != 1: raise ValueError("Код приглашения уже использован.")
        return (uid, username, self.new_session(uid))

    @staticmethod
    def normalize_invite_code(value: str | None) -> str | None:
        """Extract the code from supported link syntaxes without altering it."""
        if not isinstance(value, str):
            return None
        value = value.strip()
        if len(value) > 2048:
            return None
        if value.startswith('#invite='):
            code = value[len('#invite='):]
        elif value.startswith('invite='):
            code = value[len('invite='):]
        elif value.startswith('='):
            code = value[1:]
        else:
            try:
                parsed = urlsplit(value)
            except ValueError:
                return None
            if parsed.fragment.startswith('invite='):
                code = parsed.fragment[len('invite='):]
            elif parsed.scheme or parsed.netloc:
                return None
            else:
                code = value
        return code if code and len(code) <= 200 else None

    def new_session(self, uid: int) -> str:
        token = secrets.token_urlsafe(32); csrf = secrets.token_urlsafe(24); now=int(time.time())
        with self.db() as c:
            c.execute("INSERT INTO sessions VALUES(?,?,?,?,?)", (hashlib.sha256(token.encode()).hexdigest(),uid,csrf,now,now))
            c.execute("UPDATE users SET last_seen=? WHERE id=?", (now,uid))
        return token

    def create_invites(self, count:int=1, days:int=30, label:str='', is_bot:bool=False):
        if not isinstance(is_bot,bool): raise ValueError('invalid bot flag')
        if not isinstance(count,int) or isinstance(count,bool) or count<1 or count>100 or not isinstance(days,int) or isinstance(days,bool) or days<1 or days>365: raise ValueError('invalid invite options')
        now=int(time.time()); result=[]
        with self.db() as c:
            for _ in range(count):
                raw=secrets.token_urlsafe(18); c.execute('INSERT INTO invites(code_hash,label,created_at,expires_at,is_bot) VALUES(?,?,?,?,?)',(hashlib.sha256(raw.encode()).hexdigest(),label[:120],now,now+days*86400,int(is_bot))); result.append((c.execute('SELECT last_insert_rowid()').fetchone()[0],raw))
        return result

    def list_invites(self):
        with self.db() as c: return [dict(r) for r in c.execute('SELECT id,label,created_at,expires_at,used_at,used_by,revoked_at,is_bot FROM invites ORDER BY id DESC')]

    def revoke_invite(self, invite_id:int):
        with self.db() as c: return c.execute('UPDATE invites SET revoked_at=? WHERE id=? AND used_at IS NULL AND revoked_at IS NULL',(int(time.time()),invite_id)).rowcount == 1

    def authenticate(self, login: str, password: str) -> tuple[int, str] | None:
        with self.db() as c:
            value=unicodedata.normalize('NFKC',login).strip().casefold(); row=c.execute("SELECT id,password,legacy_login FROM users WHERE username_key=?", (value,)).fetchone()
            if not row:
                rows=c.execute("SELECT id,password,legacy_login FROM users WHERE legacy_login IS NOT NULL LIMIT 10").fetchall(); row=next((r for r in rows if unicodedata.normalize('NFKC',r['legacy_login']).casefold()==value),None)
            if not row or not _check_password(password,row[1]): return None
        return row[0], self.new_session(row[0])

    def issue_reset(self, login:str, ttl:int=3600) -> str | None:
        if not isinstance(login,str): return None
        value=unicodedata.normalize('NFKC',login).strip().casefold()
        with self.db() as c:
            rows=c.execute("SELECT id,username,legacy_login FROM users LIMIT 10").fetchall(); user=next((r for r in rows if r['username'].casefold()==value or (r['legacy_login'] and unicodedata.normalize('NFKC',r['legacy_login']).casefold()==value)),None)
        if not user: return None
        raw=secrets.token_urlsafe(32); now=int(time.time())
        with self.lock, self.db() as c:
            c.execute('BEGIN IMMEDIATE')
            c.execute("UPDATE recovery_tokens SET used_at=? WHERE user_id=? AND used_at IS NULL",(now,user['id']))
            c.execute("INSERT INTO recovery_tokens(token_hash,user_id,expires_at) VALUES(?,?,?)",(hashlib.sha256(raw.encode()).hexdigest(),user['id'],now+ttl))
        return raw

    def reset_password(self, raw:str, password:str) -> bool:
        if not isinstance(raw,str) or not isinstance(password,str) or len(password)<8 or len(password)>128 or len(raw)>200: return False
        digest=hashlib.sha256(raw.encode()).hexdigest(); now=int(time.time())
        with self.lock,self.db() as c:
            c.execute('BEGIN IMMEDIATE'); row=c.execute("SELECT user_id FROM recovery_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>?",(digest,now)).fetchone()
            if not row: return False
            c.execute("UPDATE users SET password=? WHERE id=?",(_hash_password(password),row[0])); c.execute("UPDATE recovery_tokens SET used_at=? WHERE user_id=? AND used_at IS NULL",(now,row[0])); c.execute("DELETE FROM sessions WHERE user_id=?",(row[0],)); return True

    def session(self, token: str) -> sqlite3.Row | None:
        if not token: return None
        with self.db() as c:
            row=c.execute("SELECT s.*,u.username,u.legacy_login,u.admin FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),)).fetchone()
            if row:
                now=int(time.time())
                if now - row["created_at"] > self.SESSION_TTL or now - row["last_seen"] > self.SESSION_TTL:
                    c.execute("DELETE FROM sessions WHERE token_hash=?",(row[0],)); return None
                c.execute("UPDATE sessions SET last_seen=? WHERE token_hash=?", (now,row[0]))
                c.execute("UPDATE users SET last_seen=? WHERE id=?", (now,row["user_id"]))
            return row

    def state(self, uid: int) -> tuple[dict,int]:
        with self.db() as c:
            r=c.execute("SELECT state,revision FROM game_states WHERE user_id=?",(uid,)).fetchone()
            if not r: raise ValueError("state missing")
            return json.loads(r[0]), r[1]

    def command(self, uid:int, command_id:str, expected:int, method:str, args:dict) -> tuple[dict,int]:
        if not command_id or len(command_id)>100: raise ValueError("command_id required")
        with self.lock, self.db() as c:
            request_hash=hashlib.sha256(json.dumps({"method":method,"args":args,"revision":expected},sort_keys=True,ensure_ascii=False).encode()).hexdigest()
            c.execute("BEGIN IMMEDIATE")
            old=c.execute("SELECT revision,request_hash,response FROM commands WHERE user_id=? AND command_id=?",(uid,command_id)).fetchone()
            if old:
                if old[1] != request_hash: raise ValueError("command_id уже использован для другого запроса")
                return json.loads(old[2]), old[0]
            row=c.execute("SELECT state,revision FROM game_states WHERE user_id=?",(uid,)).fetchone()
            if row[1] != expected: raise ValueError("state revision conflict")
            current=json.loads(row[0])
            if method == "create": raise ValueError("создание персонажа доступно только при регистрации")
            if method == "createCharacter" and current.get("hero",{}).get("character",{}).get("legacy") is not True:
                raise ValueError("персонаж уже создан")
            if current.get("hero",{}).get("character",{}).get("legacy") is True and method != "createCharacter":
                raise ValueError("Сначала завершите создание персонажа")
            rolls=[secrets.randbits(32) for _ in range(128)]
            result=self.engine.run(method,current,args,rolls)
            rev=row[1]+1; payload=json.dumps(result,ensure_ascii=False,separators=(",",":"))
            c.execute("UPDATE game_states SET state=?,revision=?,updated_at=? WHERE user_id=?",(payload,rev,int(time.time()),uid))
            c.execute("INSERT INTO commands(user_id,command_id,revision,request_hash,response) VALUES(?,?,?,?,?)",(uid,command_id,rev,request_hash,payload))
            record_event(c, uid, rev, method, args, current, result)
            return result,rev

    def feedback(self, uid:int, category:str,title:str,body:str,context:dict):
        if category not in ("bug","idea","feedback"): raise ValueError("unknown feedback category")
        if not title.strip() or not body.strip() or len(body)>10000: raise ValueError("Заполните заголовок и описание.")
        safe={k:context.get(k) for k in ("buildId","version","phase","position","lastAction","hero","recentJournal") if k in context}
        with self.db() as c: c.execute("INSERT INTO feedback(user_id,category,title,body,context,created_at) VALUES(?,?,?,?,?,?)",(uid,category,title[:160],body[:10000],json.dumps(safe,ensure_ascii=False),int(time.time())))

