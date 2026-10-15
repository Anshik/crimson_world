"""Authoritative game and persistence services for the online Tovilis pilot."""
from __future__ import annotations

import hashlib, hmac, json, os, secrets, sqlite3, threading, time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]


class GameEngine:
    """Run the browser's rule module in QuickJS; Python owns entropy and state."""
    METHODS = {"create", "createCharacter", "choose", "begin", "arrive", "acknowledge",
               "noticeAction", "encounterAction", "service", "equip", "battle", "playDice",
               "finishWork", "cancelWork", "drink", "rename"}

    def __init__(self, base: Path = ROOT):
        import quickjs
        self.ctx = quickjs.Context()
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
            if (method === 'noticeAction') return r.noticeAction(state,args.action,die);
            if (method === 'encounterAction') return r.encounterAction(state,args.action);
            if (method === 'service') return r.service(state,args.action,die,args.quantity ?? 1);
            if (method === 'equip') return r.equip(state,args.slot,args.id);
            if (method === 'battle') return r.battle(state,args.action,die);
            if (method === 'playDice') return r.playDice(state,die,args.stake ?? 1);
            if (method === 'finishWork') return r.finishWork(state,die);
            if (method === 'cancelWork') return r.cancelWork(state);
            if (method === 'drink') return r.drink(state);
            if (method === 'rename') return r.rename(state,args.name);
            throw new Error('method not allowlisted');
          };
          globalThis.__callRulesJSON = function(method, stateJson, argsJson, rollsJson) { var out=__callRules(method,stateJson,argsJson,rollsJson); __rules.validate(out); return JSON.stringify(out); };
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
            c.executescript("""
            CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, created_at INTEGER NOT NULL, admin INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS game_states(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS commands(user_id INTEGER NOT NULL, command_id TEXT NOT NULL, revision INTEGER NOT NULL, request_hash TEXT NOT NULL DEFAULT '', response TEXT NOT NULL, PRIMARY KEY(user_id,command_id));
            CREATE TABLE IF NOT EXISTS presence(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, cell TEXT NOT NULL, facing TEXT, sex TEXT, race TEXT, origin TEXT, class_id TEXT, revision INTEGER NOT NULL DEFAULT 0, seen_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS chat(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS offers(id TEXT PRIMARY KEY, sender INTEGER NOT NULL, recipient INTEGER NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS feedback(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, context TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS unique_items(item_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, updated_at INTEGER NOT NULL);
            """)
            cols={r[1] for r in c.execute("PRAGMA table_info(commands)")}
            if "request_hash" not in cols: c.execute("ALTER TABLE commands ADD COLUMN request_hash TEXT NOT NULL DEFAULT ''")
            pcols={r[1] for r in c.execute("PRAGMA table_info(presence)")}
            for name, definition in (("sex","TEXT"),("race","TEXT"),("origin","TEXT"),("class_id","TEXT"),("revision","INTEGER NOT NULL DEFAULT 0")):
                if name not in pcols: c.execute(f"ALTER TABLE presence ADD COLUMN {name} {definition}")

    def register(self, email: str, password: str) -> tuple[int, str, str]:
        email = email.strip().lower()
        if "@" not in email or len(email) > 254 or len(password) < 8 or len(password) > 128: raise ValueError("Некорректная почта или пароль (минимум 8 символов).")
        with self.lock, self.db() as c:
            c.execute("BEGIN IMMEDIATE")
            if c.execute("SELECT COUNT(*) FROM users").fetchone()[0] >= 10: raise ValueError("Регистрация временно закрыта: достигнут лимит 10 игроков.")
            try: c.execute("INSERT INTO users(email,password,created_at) VALUES(?,?,?)", (email, _hash_password(password), int(time.time())))
            except sqlite3.IntegrityError: raise ValueError("Такая почта уже зарегистрирована.")
            uid = c.execute("SELECT last_insert_rowid()").fetchone()[0]
            state = self.engine.run("create", None, {"name": email.split("@")[0][:24]})
            c.execute("INSERT INTO game_states(user_id,state,updated_at) VALUES(?,?,?)", (uid, json.dumps(state, ensure_ascii=False), int(time.time())))
        return (uid, email, self.new_session(uid))

    def new_session(self, uid: int) -> str:
        token = secrets.token_urlsafe(32); csrf = secrets.token_urlsafe(24); now=int(time.time())
        with self.db() as c: c.execute("INSERT INTO sessions VALUES(?,?,?,?,?)", (hashlib.sha256(token.encode()).hexdigest(),uid,csrf,now,now))
        return token

    def authenticate(self, email: str, password: str) -> tuple[int, str] | None:
        with self.db() as c:
            row=c.execute("SELECT id,password FROM users WHERE email=?", (email.strip().lower(),)).fetchone()
            if not row or not _check_password(password,row[1]): return None
        return row[0], self.new_session(row[0])

    def session(self, token: str) -> sqlite3.Row | None:
        if not token: return None
        with self.db() as c:
            row=c.execute("SELECT s.*,u.email,u.admin FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),)).fetchone()
            if row:
                now=int(time.time())
                if now - row["created_at"] > self.SESSION_TTL or now - row["last_seen"] > self.SESSION_TTL:
                    c.execute("DELETE FROM sessions WHERE token_hash=?",(row[0],)); return None
                c.execute("UPDATE sessions SET last_seen=? WHERE token_hash=?", (now,row[0]))
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
            old=c.execute("SELECT revision,request_hash,response FROM commands WHERE user_id=? AND command_id=?",(uid,command_id)).fetchone()
            if old:
                if old[1] != request_hash: raise ValueError("command_id уже использован для другого запроса")
                return json.loads(old[2]), old[0]
            c.execute("BEGIN IMMEDIATE")
            row=c.execute("SELECT state,revision FROM game_states WHERE user_id=?",(uid,)).fetchone()
            if row[1] != expected: raise ValueError("state revision conflict")
            current=json.loads(row[0])
            if method == "createCharacter" and current.get("hero",{}).get("character",{}).get("legacy") is not True:
                raise ValueError("персонаж уже создан")
            rolls=[secrets.randbits(32) for _ in range(128)]
            result=self.engine.run(method,current,args,rolls)
            rev=row[1]+1; payload=json.dumps(result,ensure_ascii=False,separators=(",",":"))
            c.execute("UPDATE game_states SET state=?,revision=?,updated_at=? WHERE user_id=?",(payload,rev,int(time.time()),uid))
            c.execute("INSERT INTO commands(user_id,command_id,revision,request_hash,response) VALUES(?,?,?,?,?)",(uid,command_id,rev,request_hash,payload)); return result,rev

    def feedback(self, uid:int, category:str,title:str,body:str,context:dict):
        if category not in ("bug","idea","feedback"): raise ValueError("unknown feedback category")
        if not title.strip() or not body.strip() or len(body)>10000: raise ValueError("Заполните заголовок и описание.")
        safe={k:context.get(k) for k in ("version","phase","position","lastAction") if k in context}
        with self.db() as c: c.execute("INSERT INTO feedback(user_id,category,title,body,context,created_at) VALUES(?,?,?,?,?,?)",(uid,category,title[:160],body[:10000],json.dumps(safe,ensure_ascii=False),int(time.time())))

