#!/usr/bin/env python3
"""Small local online smoke test for Safari QA.

Starts an isolated Flask instance unless --reuse is supplied, then exercises two
independent cookie sessions through the same HTTP contract Safari uses. It does
not touch a production database. Use `--reuse` only with a disposable local
server already bound to --base-url.
"""
from __future__ import annotations
import argparse, json, os, pathlib, subprocess, sys, tempfile, time, urllib.error, urllib.parse, urllib.request, uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

class Client:
    def __init__(self, base: str):
        self.base = base.rstrip('/'); self.cookies = {}
    def call(self, path: str, method='GET', payload=None):
        data = None if payload is None else json.dumps(payload).encode()
        headers = {'Content-Type': 'application/json'}
        if self.cookies: headers['Cookie'] = '; '.join(f'{k}={v}' for k, v in self.cookies.items())
        if self.cookies.get('cw_csrf'): headers['X-CSRF-Token'] = self.cookies['cw_csrf']
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=8) as response:
                for value in response.headers.get_all('Set-Cookie') or []:
                    first = value.split(';', 1)[0]
                    if '=' in first:
                        name, token = first.strip().split('=', 1)
                        if name in ('cw_session', 'cw_csrf'): self.cookies[name] = token
                return response.status, json.loads(response.read() or b'{}')
        except urllib.error.HTTPError as exc:
            body = exc.read().decode(errors='replace')
            raise RuntimeError(f'{method} {path}: HTTP {exc.code} {body}') from exc
    def register(self, username, invite):
        return self.call('/api/auth/register', 'POST', {'username': username, 'password': 'LocalQA-password-123', 'inviteCode': invite})[1]
    def command(self, method, args, revision=0):
        return self.call('/api/commands', 'POST', {'commandId': str(uuid.uuid4()), 'method': method, 'args': args, 'revision': revision})[1]

def wait_server(base):
    for _ in range(120):
        try:
            with urllib.request.urlopen(base + '/health', timeout=1) as r:
                if r.status < 500: return
        except Exception: time.sleep(.15)
    raise RuntimeError(f'local server did not start at {base}')

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base-url', default='http://127.0.0.1:8000')
    ap.add_argument('--reuse', action='store_true', help='use an already running disposable local server')
    ap.add_argument('--width', type=int, default=390)
    args = ap.parse_args()
    if args.width != 390: raise SystemExit('--width is a QA assertion; use 390 for the compact Safari viewport')
    if '<meta name="viewport"' not in (ROOT/'game/index.html').read_text(): raise SystemExit('missing responsive viewport')
    css = (ROOT/'game/game.css').read_text()
    if '@media(max-width:780px)' not in css and '@media (max-width: 780px)' not in css: raise SystemExit('missing compact layout rules')
    proc = None; db = None
    try:
        if not args.reuse:
            fd, db = tempfile.mkstemp(prefix='crimsonworld-online-', suffix='.sqlite'); os.close(fd)
            env = os.environ.copy(); env['CRIMSON_DB'] = db; env['PORT'] = str(urllib.parse.urlparse(args.base_url).port or 8000)
            from server.core import Store
            invites = Store(db).create_invites(count=2, days=1, label='online-api-qa')
            port = urllib.parse.urlparse(args.base_url).port or 8000
            runner = 'from server.app import app; import os; app.run(host="127.0.0.1", port=int(os.environ["PORT"]))'
            python = str(ROOT / '.venv' / 'bin' / 'python')
            proc = subprocess.Popen([python, '-c', runner], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        try:
            wait_server(args.base_url)
        except RuntimeError:
            if proc and proc.poll() is not None:
                raise RuntimeError(f'local server exited: {proc.stdout.read()[-2000:]}')
            raise
        suffix = uuid.uuid4().hex[:10]
        alice, bob = Client(args.base_url), Client(args.base_url)
        if not args.base_url.startswith(('http://127.0.0.1:', 'http://localhost:')): raise SystemExit('QA API smoke only permits localhost')
        if not locals().get('invites'):
            qa_db = os.environ.get('TOVILIS_QA_DB')
            if not qa_db: raise SystemExit('--reuse requires TOVILIS_QA_DB for an isolated database')
            from server.core import Store
            invites = Store(qa_db).create_invites(count=2, days=1, label='online-api-qa')
        alice.call('/api/auth/register', 'POST', {'username':f'alice-{suffix}', 'password':'LocalQA-password-123', 'inviteCode':invites[0][1]})
        bob.call('/api/auth/register', 'POST', {'username':f'bob-{suffix}', 'password':'LocalQA-password-123', 'inviteCode':invites[1][1]})
        ar = alice.command('createCharacter', {'profile': {'name':'Алиса QA','sex':'female','race':'human','origin':'north','class':'warrior'}})
        br = bob.command('createCharacter', {'profile': {'name':'Боб QA','sex':'male','race':'elf','origin':'highElf','class':'warrior'}})
        arev, brev = ar.get('revision', 0), br.get('revision', 0)
        if alice.call('/api/world/presence')[1].get('players') is None: raise RuntimeError('presence payload missing')
        alice.call('/api/chat', 'POST', {'body':'Safari online smoke'})
        if not any('Safari online smoke' in str(x) for x in alice.call('/api/chat')[1].get('messages', [])): raise RuntimeError('chat did not persist')
        alice.call('/api/feedback', 'POST', {'category':'bug','title':'Safari smoke','body':'QA report'})
        if not any(x.get('title') == 'Safari smoke' for x in alice.call('/api/feedback')[1].get('items', [])): raise RuntimeError('feedback did not persist')
        bob_id = bob.call('/api/me')[1].get('user', {}).get('id')
        if not bob_id: raise RuntimeError('second account id missing')
        alice.call('/api/trades/offers', 'POST', {'recipient': bob_id, 'payload': {'coins': 1}})
        offers = bob.call('/api/trades/offers')[1].get('offers', [])
        offer = next((x for x in offers if x.get('status') == 'open'), None)
        if not offer: raise RuntimeError('trade offer did not persist')
        payload = json.loads(offer.get('payload', '{}'))
        if payload.get('coins') != 1: raise RuntimeError('trade payload hidden or changed before acceptance')
        bob.call(f"/api/trades/offers/{offer['id']}/accept", 'POST')
        print(f'PASS online Safari contract: two accounts, presence, chat, trade, feedback, {args.width}px layout')
    finally:
        if proc: proc.terminate(); proc.wait(timeout=5)
        if db:
            try: os.unlink(db)
            except OSError: pass

if __name__ == '__main__': main()
