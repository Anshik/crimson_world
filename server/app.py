"""Flask HTTP API for the shared Tovilis pilot."""
from __future__ import annotations
import os, time, uuid, hashlib
from functools import wraps
from flask import Flask, jsonify, request, make_response, send_from_directory
from werkzeug.middleware.proxy_fix import ProxyFix
from .core import Store, ROOT

app = Flask(__name__, static_folder=None)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
store = Store()
_attempts: dict[str,list[float]] = {}

@app.get('/health')
def health():
    return jsonify({'status': 'ok'})
KNOWN_FINDS={"glass","defenseRing","caneKnob","platinumRing","almaMedallion","chrysoberyl"}
KNOWN_ARTIFACTS={"skalemnirArmor","therionCloak","compassionTear"}

def json_error(message, status=400): return jsonify({"error":message}), status
def body():
    value=request.get_json(silent=True)
    return value if isinstance(value,dict) else {}
def valid_origin():
    origin=request.headers.get("Origin")
    return not origin or origin.rstrip('/') == request.host_url.rstrip('/')
def limited(bucket, max_count=20, window=60):
    now=time.time(); values=[v for v in _attempts.get(bucket,[]) if now-v<window]
    if len(values)>=max_count: return False
    values.append(now); _attempts[bucket]=values; return True

def auth(required=True):
    def deco(fn):
        @wraps(fn)
        def wrapped(*args,**kwargs):
            origin=request.headers.get("Origin")
            if origin and origin.rstrip('/') != request.host_url.rstrip('/'): return json_error("Недопустимый источник запроса.",403)
            row=store.session(request.cookies.get("cw_session"))
            if not row and required: return json_error("Требуется вход.",401)
            if row and request.method not in ("GET","HEAD") and request.headers.get("X-CSRF-Token") != row["csrf"]: return json_error("Недействительный CSRF-токен.",403)
            return fn(row,*args,**kwargs)
        return wrapped
    return deco

def session_response(data, token, uid):
    row=store.session(token); out=make_response(jsonify(data)); out.set_cookie("cw_session",token,httponly=True,samesite="Lax",secure=bool(request.is_secure),max_age=60*60*24*30)
    out.set_cookie("cw_csrf",row["csrf"],httponly=False,samesite="Lax",secure=bool(request.is_secure),max_age=60*60*24*30); return out

@app.post('/api/auth/register')
def register():
    if not valid_origin(): return json_error("Недопустимый источник запроса.",403)
    if not limited(request.remote_addr or "unknown",3,300): return json_error("Слишком много попыток.",429)
    b=body()
    try: uid,email,token=store.register(str(b.get("email","")),str(b.get("password","")))
    except ValueError as e: return json_error(str(e))
    return session_response({"user":{"id":uid,"email":email},"emailVerification":"not_configured"},token,uid)

@app.post('/api/auth/login')
def login():
    if not valid_origin(): return json_error("Недопустимый источник запроса.",403)
    if not limited(request.remote_addr or "unknown",8,300): return json_error("Слишком много попыток.",429)
    b=body(); pair=store.authenticate(str(b.get("email","")),str(b.get("password","")))
    if not pair: return json_error("Неверная почта или пароль.",401)
    uid,token=pair; return session_response({"user":{"id":uid}},token,uid)

@app.post('/api/auth/logout')
@auth()
def logout(row):
    with store.db() as c: c.execute("DELETE FROM sessions WHERE token_hash=?",(hashlib.sha256(request.cookies.get("cw_session").encode()).hexdigest(),))
    out=make_response(jsonify({"ok":True})); out.delete_cookie("cw_session"); out.delete_cookie("cw_csrf"); return out

@app.get('/api/me')
@auth()
def me(row):
    state,rev=store.state(row["user_id"]); return jsonify({"user":{"id":row["user_id"],"email":row["email"]},"state":state,"revision":rev,"csrf":row["csrf"]})

@app.post('/api/commands')
@auth()
def command(row):
    b=body(); method=b.get("method"); args=b.get("args") or {}
    if not isinstance(method,str) or method not in store.engine.METHODS: return json_error("Команда недоступна.")
    try: result,rev=store.command(row["user_id"],str(b.get("commandId","")),int(b.get("revision",-1)),method,args)
    except (ValueError,TypeError) as e: return json_error(str(e),409 if ("revision" in str(e) or "command_id" in str(e)) else 400)
    return jsonify({"state":result,"revision":rev})

@app.get('/api/world/presence')
@auth()
def presence(row):
    state,rev=store.state(row["user_id"]); now=int(time.time())
    ch=state.get("hero",{}).get("character") or {}
    with store.db() as c:
        c.execute("INSERT INTO presence(user_id,name,cell,facing,sex,race,origin,class_id,revision,seen_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,cell=excluded.cell,facing=excluded.facing,sex=excluded.sex,race=excluded.race,origin=excluded.origin,class_id=excluded.class_id,revision=excluded.revision,seen_at=excluded.seen_at",(row["user_id"],state["hero"]["name"],state["position"],state.get("facing"),ch.get("sex"),ch.get("race"),ch.get("origin"),ch.get("class"),rev,now))
        rows=c.execute("SELECT user_id,name,cell,facing,sex,race,origin,class_id,revision FROM presence WHERE seen_at>? AND user_id!=?",(now-60,row["user_id"])).fetchall()
    return jsonify({"players":[dict(r) for r in rows]})

@app.get('/api/chat')
@auth()
def chat_get(row):
    after=int(request.args.get("after",0));
    with store.db() as c: rows=c.execute("SELECT id,name,body,created_at FROM chat WHERE id>? ORDER BY id DESC LIMIT 50",(after,)).fetchall()
    return jsonify({"messages":[dict(r) for r in reversed(rows)]})

@app.post('/api/chat')
@auth()
def chat_post(row):
    b=body(); text=str(b.get("body","" )).strip()
    if not text or len(text)>1000: return json_error("Сообщение пустое или слишком длинное.")
    with store.db() as c:
        count=c.execute("SELECT COUNT(*) FROM chat WHERE user_id=? AND created_at>?",(row["user_id"],int(time.time())-10)).fetchone()[0]
        if count>=5: return json_error("Слишком много сообщений.",429)
        state,_=store.state(row["user_id"]); c.execute("INSERT INTO chat(user_id,name,body,created_at) VALUES(?,?,?,?)",(row["user_id"],state["hero"]["name"],text,int(time.time())))
    return jsonify({"ok":True})

@app.get('/api/feedback')
@auth()
def feedback_get(row):
    with store.db() as c: rows=c.execute("SELECT id,category,title,body,context,status,created_at FROM feedback WHERE user_id=? ORDER BY id DESC",(row["user_id"],)).fetchall()
    return jsonify({"items":[dict(r) for r in rows]})

@app.post('/api/feedback')
@auth()
def feedback_post(row):
    if not limited(f"feedback:{row['user_id']}",5,300): return json_error("Слишком много обращений.",429)
    b=body(); state,_=store.state(row["user_id"])
    try: store.feedback(row["user_id"],str(b.get("category","feedback")),str(b.get("title","")),str(b.get("body","")),{"version":state.get("version"),"phase":state.get("phase"),"position":state.get("position"),"lastAction":state.get("lastMove")})
    except ValueError as e: return json_error(str(e))
    return jsonify({"ok":True})

@app.post('/api/trades/offers')
@auth()
def offer_create(row):
    b=body(); recipient=int(b.get("recipient",0)); payload=b.get("payload") or {}
    if recipient == row["user_id"] or not isinstance(payload,dict): return json_error("Неверное предложение.")
    try:
        coins=payload.get("coins",0); items=payload.get("items",{}); finds=payload.get("finds",{}); artifacts=payload.get("artifacts",[])
        if not isinstance(coins,int) or coins<0 or coins>100000 or not isinstance(items,dict) or not isinstance(finds,dict) or not isinstance(artifacts,list) or len(artifacts)>10: raise ValueError
        if any(not isinstance(k,str) or k not in {"sword","shield","food","potions"} or not isinstance(v,int) or v<1 or v>100 for k,v in items.items()): raise ValueError
        if any(not isinstance(k,str) or k not in KNOWN_FINDS or not isinstance(v,int) or v<1 or v>100 for k,v in finds.items()): raise ValueError
        if any(not isinstance(k,str) or k not in KNOWN_ARTIFACTS for k in artifacts) or len(set(artifacts))!=len(artifacts): raise ValueError
    except (TypeError,ValueError): return json_error("Неверное содержимое предложения.")
    with store.db() as c:
        target=c.execute("SELECT id FROM users WHERE id=?",(recipient,)).fetchone()
        if not target: return json_error("Игрок не найден.")
        sender_state,_=store.state(row["user_id"]); target_state,_=store.state(recipient)
        if sender_state["position"] != target_state["position"]: return json_error("Игроки должны находиться в одной клетке.")
        allowed={"coins","items","finds","artifacts"}; clean={k:v for k,v in payload.items() if k in allowed}
        oid=uuid.uuid4().hex; c.execute("INSERT INTO offers VALUES(?,?,?,?,?,?)",(oid,row["user_id"],recipient,__import__('json').dumps(clean,ensure_ascii=False),"open",int(time.time())))
    return jsonify({"id":oid,"status":"open"})

@app.get('/api/trades/offers')
@auth()
def offer_list(row):
    with store.db() as c:
        c.execute("UPDATE offers SET status='expired' WHERE status='open' AND created_at<?",(int(time.time())-86400,))
        rows=c.execute("SELECT id,sender,recipient,payload,status,created_at FROM offers WHERE sender=? OR recipient=? ORDER BY created_at DESC LIMIT 50",(row["user_id"],row["user_id"])).fetchall()
    return jsonify({"offers":[dict(r) for r in rows]})

@app.post('/api/trades/offers/<offer_id>/accept')
@auth()
def offer_accept(row,offer_id):
    with store.lock,store.db() as c:
        c.execute("BEGIN IMMEDIATE"); off=c.execute("SELECT * FROM offers WHERE id=?",(offer_id,)).fetchone()
        if not off or off["recipient"]!=row["user_id"] or off["status"]!="open" or int(off["created_at"]) < int(time.time())-86400: return json_error("Предложение недоступно.")
        a=c.execute("SELECT state,revision FROM game_states WHERE user_id=?",(off["sender"],)).fetchone(); b=c.execute("SELECT state,revision FROM game_states WHERE user_id=?",(off["recipient"],)).fetchone()
        sa,sb=__import__('json').loads(a[0]),__import__('json').loads(b[0]);
        if sa["position"]!=sb["position"]: return json_error("Игроки больше не на одной клетке.")
        p=__import__('json').loads(off["payload"]); ha,hb=sa["hero"],sb["hero"]
        coins=p.get("coins",0)
        if coins<0 or ha.get("coins",0)<coins: return json_error("У отправителя нет этих монет.")
        ha["coins"]-=coins; hb["coins"]=hb.get("coins",0)+coins
        for key in ("finds",):
            for item,count in (p.get(key) or {}).items():
                if item not in KNOWN_FINDS or not isinstance(count,int) or count<1: return json_error("Недопустимая находка.")
                if item in ha.get("equipment",{}).values(): return json_error("Сначала снимите находку перед передачей.")
                have=int(ha.get(key,{}).get(item,0))
                if have<count: return json_error("Предмет уже потрачен.")
                ha[key][item]=have-count; hb.setdefault(key,{})[item]=int(hb[key].get(item,0))+count
        item_counts={"sword":"sword","shield":"shield","food":"food","potions":"potions","net":"net"}
        for item,count in (p.get("items") or {}).items():
            field=item_counts.get(item); count=int(count)
            if not field or count<0: return json_error("Недопустимый предмет.")
            if item in ha.get("equipment",{}).values(): return json_error("Сначала снимите предмет перед передачей.")
            have=int(ha.get(field,0) if field not in ("sword","shield","net") else bool(ha.get(field)))
            if have<count: return json_error("Предмет уже недоступен.")
            if field in ("sword","shield","net"): ha[field]=False if count else ha.get(field); hb[field]=True
            else:
                if field == "potions" and int(hb.get(field,0))+count > 3: return json_error("У получателя нет места для зелий.")
                ha[field]=have-count; hb[field]=int(hb.get(field,0))+count
        for item in p.get("artifacts") or []:
            if item not in KNOWN_ARTIFACTS or item not in ha.get("artifacts",[]): return json_error("Артефакт уже недоступен.")
            if item in hb.get("artifacts",[]): return json_error("У получателя уже есть этот уникальный артефакт.")
            if item in sa.get("hero",{}).get("equipment",{}).values(): return json_error("Сначала снимите артефакт перед передачей.")
            ha["artifacts"].remove(item); hb.setdefault("artifacts",[]).append(item)
            existing=c.execute("SELECT user_id FROM unique_items WHERE item_id=?",(item,)).fetchone()
            if existing and existing[0] not in (off["sender"],off["recipient"]): return json_error("Уникальный артефакт уже закреплён за другим игроком.")
            c.execute("INSERT OR REPLACE INTO unique_items(item_id,user_id,updated_at) VALUES(?,?,?)",(item,off["recipient"],int(time.time())))
            sa.setdefault("world",{}).setdefault("uniqueArtifacts",{}).pop(item,None); sb.setdefault("world",{}).setdefault("uniqueArtifacts",{})[item]='hero'
        try:
            sa=store.engine.run("rename",sa,{"name":ha["name"]},[]); sb=store.engine.run("rename",sb,{"name":hb["name"]},[])
        except ValueError as exc: return json_error(str(exc),400)
        c.execute("UPDATE game_states SET state=?,revision=revision+1,updated_at=? WHERE user_id=?",(__import__('json').dumps(sa,ensure_ascii=False),int(time.time()),off["sender"]))
        c.execute("UPDATE game_states SET state=?,revision=revision+1,updated_at=? WHERE user_id=?",(__import__('json').dumps(sb,ensure_ascii=False),int(time.time()),off["recipient"]))
        c.execute("UPDATE offers SET status='accepted' WHERE id=?",(offer_id,))
    return jsonify({"ok":True})

@app.post('/api/trades/offers/<offer_id>/decline')
@auth()
def offer_decline(row, offer_id):
    with store.db() as c:
        result=c.execute("UPDATE offers SET status='declined' WHERE id=? AND recipient=? AND status='open'",(offer_id,row["user_id"]))
    if result.rowcount != 1: return json_error("Предложение недоступно.",404)
    return jsonify({"ok":True})

@app.post('/api/trades/offers/<offer_id>/cancel')
@auth()
def offer_cancel(row, offer_id):
    with store.db() as c:
        result=c.execute("UPDATE offers SET status='cancelled' WHERE id=? AND sender=? AND status='open'",(offer_id,row["user_id"]))
    if result.rowcount != 1: return json_error("Предложение недоступно.",404)
    return jsonify({"ok":True})

@app.get('/api/admin/feedback')
@auth()
def admin_feedback(row):
    if not row["admin"] or row["email"] not in [x.strip().lower() for x in os.environ.get("ADMIN_EMAILS","").split(",") if x.strip()]: return json_error("Недоступно.",403)
    with store.db() as c: rows=c.execute("SELECT * FROM feedback ORDER BY id DESC").fetchall()
    return jsonify({"items":[dict(r) for r in rows]})

@app.post('/api/admin/feedback/<int:item_id>')
@auth()
def admin_feedback_status(row,item_id):
    if not row["admin"] or row["email"] not in [x.strip().lower() for x in os.environ.get("ADMIN_EMAILS","").split(",") if x.strip()]: return json_error("Недоступно.",403)
    status=str(body().get("status",""));
    if status not in ("open","in_progress","fixed","closed"): return json_error("Недопустимый статус")
    with store.db() as c: c.execute("UPDATE feedback SET status=? WHERE id=?",(status,item_id))
    return jsonify({"ok":True})

@app.get('/<path:path>')
def static_game(path):
    # Only the public game tree is exposed. The server never serves docs, .env or SQLite.
    public=ROOT / "game"
    if path == "": path="index.html"
    candidate=(public / path).resolve()
    if public not in candidate.parents and candidate != public: return "",404
    if not candidate.is_file(): return "",404
    if path == "index.html":
        text=candidate.read_text(encoding="utf-8"); text=text.replace("<head>",'<head><meta name="game-server" content="true">',1); return text
    return send_from_directory(public,path)

@app.get('/')
def static_index():
    public = ROOT / "game"
    text = (public / "index.html").read_text(encoding="utf-8")
    return text.replace("<head>", '<head><meta name="game-server" content="true">', 1)

@app.get('/game/<path:path>')
def static_game_alias(path):
    return static_game(path)

@app.get('/assets/<path:path>')
def static_assets(path):
    root=ROOT / "assets"; candidate=(root / path).resolve()
    if root not in candidate.parents or not candidate.is_file(): return "",404
    # Public art/map data only; notebooks, originals and archives stay private.
    if any(part in {"notebook","originals"} or part.startswith(".") for part in candidate.relative_to(root).parts): return "",404
    return send_from_directory(root,path)

@app.get('/docs/<path:path>')
def public_docs(path):
    if path not in {'tovilis-map-data.js','tovilis-map.html'}: return '',404
    root=ROOT/'docs'; return send_from_directory(root,path)

if __name__ == '__main__': app.run(host='127.0.0.1',port=int(os.environ.get('PORT',8000)))
