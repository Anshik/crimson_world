#!/usr/bin/env python3
"""Bounded HTTP playtest against an explicitly selected game server.

Uses ordinary accounts and server dice. Rules are loaded only to read the map,
available services and notice choices; no fabricated state is sent to the API.
Credentials and full traces belong in a private directory, never in Git.
"""
from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
from pathlib import Path
import signal
import sys
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]


def save_json(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2))
    temp.chmod(0o600)
    temp.replace(path)


class HTTPFailure(Exception):
    def __init__(self, status, body):
        self.status, self.body = status, body
        super().__init__(f'HTTP {status}: {body}')


class Client:
    def __init__(self, base):
        self.base = base.rstrip('/')
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.latencies = []

    def call(self, path, payload=None):
        headers = {'Content-Type': 'application/json', 'User-Agent': 'CrimsonWorld-Playtest/1'}
        for cookie in self.jar:
            if cookie.name == 'cw_csrf':
                headers['X-CSRF-Token'] = cookie.value
        req = urllib.request.Request(self.base + path, headers=headers,
                                     data=None if payload is None else json.dumps(payload).encode())
        started = time.monotonic()
        try:
            with self.opener.open(req, timeout=15) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            raise HTTPFailure(exc.code, exc.read().decode()[:2000]) from exc
        finally:
            self.latencies.append(round((time.monotonic() - started) * 1000, 2))


class Policy:
    """One shared policy. Only pacing differs between the three players."""
    def __init__(self, release, work_shifts=12):
        sys.path.insert(0, str(release))
        from server.core import GameEngine
        self.engine = GameEngine(Path(release))
        self.view = self.engine.ctx.eval('''(function(raw) {
          var s=JSON.parse(raw),r=__rules;
          return JSON.stringify({services:r.services(s),directions:r.directions(s.position),
            card:s.phase==='notice'?r.noticeCard(s):null});
        })''')
        self.validate = self.engine.ctx.eval('(function(raw){__rules.validate(JSON.parse(raw));return true;})')
        self.route = self.engine.ctx.eval('(function(a,b){return JSON.stringify(__rules.shortestPath(a,b));})')
        self.buildings = json.loads((Path(release)/'assets/maps/geometry/tovilis-v9.json').read_text())['buildings']
        self.cells = {b['id']: b['cell'] for b in self.buildings}
        self.work_shifts = work_shifts

    def move(self, state, target, view):
        path = json.loads(self.route(state['position'], self.cells[target]))
        if len(path) < 2:
            raise RuntimeError(f'No route to {target}')
        option = next(d for d in view['directions'] if d['next'] == path[1])
        args = {'next': path[1]}
        # Only stop at the entrance if it is on our shortest route. Random dice
        # and corridor endings still determine the actual arrival position.
        building = option.get('building')
        if building and building['cell'] in path[1:]:
            args['stopBuilding'] = building['id']
        return 'begin', args

    def decide(self, s, memory):
        view = json.loads(self.view(json.dumps(s)))
        phase, h = s['phase'], s['hero']
        if phase == 'moving': return 'arrive', {}
        if phase in ('outcome', 'work-result', 'won'): return 'acknowledge', {}
        if phase == 'work': return 'finishWork', {}
        if phase == 'notice':
            if s['notice']['stage'] != 'choice': return 'acknowledge', {}
            choices = [a[0] for a in view['card']['actions']]
            action = choices[0]
            if view['card']['id'] == 'elf' and h['potions'] < 1: action = 'pass'
            return 'noticeAction', {'action': action}
        if phase in ('encounter', 'combat'):
            encounter = s['encounter']
            if not encounter['hostile']: return 'encounterAction', {'action': 'pass'}
            if h['hp'] <= h['maxHp'] * .4 and h['potions']:
                return 'battle', {'action': 'potion'}
            if h['hp'] <= 3: return 'battle', {'action': 'flee'}
            target = min((e for e in encounter['enemies'] if e['hp'] > 0), key=lambda e: e['hp'])
            return 'battle', {'action': 'attack', 'targetId': target['id']}
        if phase != 'ready': raise RuntimeError(f'Unsupported phase {phase}')
        offers = {o['id']: o for o in view['services'] if o['enabled']}
        def service(action): return 'service', {'action': action}
        taverns = ('tavern', 'near-tavern')
        nearest_inn = min(taverns, key=lambda b: len(json.loads(self.route(s['position'], self.cells[b]))))
        if h['food'] <= 1 and h['coins'] >= 1:
            if 'food' in offers:
                return 'service', {'action': 'food', 'quantity': min(3, h['coins'])}
            return self.move(s, nearest_inn, view)
        if h['hp'] < h['maxHp'] * .5:
            if h['potions']: return 'drink', {}
            for action in ('rest', 'ale'):
                if action in offers: return service(action)
        # A fixed work phase exposes the personal-day earning loop before the
        # one-shot quest ends the game. It is identical for every player.
        required_shifts = memory.get('required_shifts', self.work_shifts)
        if memory['shifts'] < required_shifts:
            target = 'forge'
            if s['position'] == self.cells[target]:
                for action in ('sword', 'shield'):
                    if action in offers: return service(action)
                for action in ('work-forge', 'wait-opening', 'wait-work'):
                    if action in offers: return service(action)
                raise RuntimeError('No legal work action at forge')
            return self.move(s, target, view)
        if s['quest'] == 'complete':
            route = ['mill', 'tavern', 'far-shop', 'near-tavern', 'forge', 'port', 'orders']
            index = memory.get('tour_index', 0)
            if s['position'] == self.cells[route[index]]:
                index += 1
                if index == len(route):
                    memory['tour_index'] = 0
                    memory['required_shifts'] = memory['shifts'] + 2
                    return self.move(s, 'forge', view)
                memory['tour_index'] = index
            return self.move(s, route[index], view)
        # Sell finds and buy the net through ordinary movement/services.
        if s['quest'] == 'none':
            if 'quest' in offers: return service('quest')
            return self.move(s, 'orders', view)
        if not h['net']:
            if s['position'] == self.cells['shop']:
                sells = [a for a in offers if a.startswith('sell-') and a not in ('sell-sword','sell-shield','sell-potion')]
                if sells: return service(sells[0])
                if 'net' in offers: return service('net')
                if 'wait-opening' in offers: return service('wait-opening')
                # Earn the missing money at the nearest repeatable workplace.
                memory['required_shifts'] = memory['shifts'] + 2
                return self.move(s, 'forge', view)
            return self.move(s, 'shop', view)
        if 'deliver' in offers: return service('deliver')
        return self.move(s, 'port', view)


def metrics(s):
    h = s['hero']
    return {k: h.get(k) for k in ('coins','food','hp','maxHp','experience','reputation','sword','shield','potions','attackBonus','defense')} | {
        'phase': s['phase'], 'cell': s['position'], 'ticks': s['ticks'], 'turns': s['turn'], 'quest': s['quest'],
        'finds': h.get('finds', {}), 'equipment': h.get('equipment', {})}


def check_transition(before, after, method, args):
    problems = []
    if after['ticks'] < before['ticks']: problems.append('clock_moved_backwards')
    if after['turn'] < before['turn']: problems.append('turn_moved_backwards')
    h = after['hero']
    for key in ('coins','food','experience','potions'):
        if not isinstance(h[key], int) or h[key] < 0: problems.append(f'invalid_{key}')
    if not 1 <= h['hp'] <= h['maxHp']: problems.append('invalid_hp')
    if method == 'finishWork' and after['phase'] == 'work-result':
        expected = (after['job']['roll'] + 1) // 2
        if h['coins'] - before['hero']['coins'] != expected: problems.append('work_pay_mismatch')
    report = (after.get('encounter') or {}).get('report') or {}
    if method == 'battle':
        for hit in report.get('hits', []):
            if 'damage' in hit and hit['damage'] != max(0, hit['attack'] - hit['absorption']):
                problems.append('combat_damage_mismatch')
    if method == 'service' and args.get('action') == 'deliver':
        if h['coins'] - before['hero']['coins'] != 10: problems.append('quest_reward_mismatch')
    return problems


class Bot:
    def __init__(self, credential, base, interval):
        self.name = credential['username']
        self.client = Client(base)
        self.client.call('/api/auth/login', {'login': self.name, 'password': credential['password']})
        me = self.client.call('/api/me')
        self.uid, self.state, self.revision = me['user']['id'], me['state'], me['revision']
        self.interval = interval
        self.due = time.monotonic()
        self.memory = {'shifts': 0}
        self.actions = 0
        self.commands = 0
        self.status = 'running'
        self.errors = []
        self.warnings = []
        self.visited = {self.state['position']}
        self.milestones = {}
        self.no_progress = 0

    def command(self, method, args):
        payload = {'method': method, 'args': args, 'revision': self.revision, 'commandId': uuid.uuid4().hex}
        # Retry transport failures with the SAME idempotency key. Never retry
        # a rejected game command or silently replace a stale revision.
        for attempt in range(2):
            try:
                result = self.client.call('/api/commands', payload)
                break
            except (urllib.error.URLError, TimeoutError):
                if attempt: raise
        before = self.state
        if result['revision'] != self.revision + 1: raise RuntimeError('Unexpected command revision')
        self.state, self.revision = result['state'], result['revision']
        self.commands += 1
        return before

    def summary(self):
        latency = sorted(self.client.latencies)
        return {'name': self.name, 'user_id': self.uid, 'interval_seconds': self.interval,
                'status': self.status, 'decisions': self.actions, 'commands': self.commands,
                'work_shifts': self.memory['shifts'], 'visited_cells': len(self.visited),
                'milestones_seconds': self.milestones, 'errors': self.errors, 'warnings': self.warnings,
                'http_p95_ms': latency[min(len(latency)-1, int(len(latency)*.95))], **metrics(self.state)}


def provision(args):
    """Dedicated invitations; existing invitations and real accounts untouched."""
    if args.credentials.exists(): raise RuntimeError('Credentials already exist; refusing to provision twice')
    sys.path.insert(0, str(args.release_root))
    from server.core import Store
    import secrets
    store = Store(args.provision_db)
    with store.db() as db:
        count = db.execute('SELECT count(*) FROM users').fetchone()[0]
    if count + 3 > 10: raise RuntimeError('Not enough account slots for three bots')
    suffix = time.strftime('%m%d%H%M%S', time.gmtime())
    credentials = [{'username': f'qa-{speed}-{suffix}', 'password': secrets.token_urlsafe(24)}
                   for speed in ('fast','medium','slow')]
    save_json(args.credentials, credentials)
    invites = store.create_invites(count=3, days=1, label=f'playtest-{suffix}', is_bot=True)
    for credential, (_, invite) in zip(credentials, invites):
        client = Client(args.base_url)
        client.call('/api/auth/register', {**credential, 'inviteCode': invite})
        me = client.call('/api/me')
        client.call('/api/commands', {'commandId': uuid.uuid4().hex, 'revision': me['revision'], 'method': 'createCharacter',
          'args': {'profile': {'name': credential['username'], 'sex': 'male', 'race': 'dwarf', 'origin': 'dwarf', 'class': 'warrior'}}})


def interaction_probe(bots, emit):
    # A closed, zero-net exchange between the test accounts before pacing
    # starts. No chats or offers are sent to human players.
    ids = {b.uid for b in bots}
    for bot in bots: bot.client.call('/api/world/presence')
    for bot in bots:
        players = bot.client.call('/api/world/presence')['players']
        seen = {p['user_id'] for p in players}
        if not ids.difference({bot.uid}).issubset(seen): raise RuntimeError('Bot presence missing')
    a, b = bots[:2]
    before = [bot.state for bot in bots]
    for payload in ({'coins': 1}, {'items': {'food': 1}}, {'items': {'potions': 1}}):
        for sender, recipient in ((a,b),(b,a)):
            offer = sender.client.call('/api/trades/offers', {'recipient': recipient.uid, 'payload': payload})
            listed = recipient.client.call('/api/trades/offers')['offers']
            if not any(o['id'] == offer['id'] for o in listed): raise RuntimeError('Offer missing from recipient list')
            recipient.client.call(f"/api/trades/offers/{offer['id']}/accept", {})
            try:
                recipient.client.call(f"/api/trades/offers/{offer['id']}/accept", {})
                raise RuntimeError('Repeated trade accepted')
            except HTTPFailure as exc:
                if exc.status != 400: raise
    for bot, original in zip(bots, before):
        me = bot.client.call('/api/me')
        if me['state'] != original: raise RuntimeError('Round-trip exchange altered starting state')
        bot.state, bot.revision = me['state'], me['revision']
    emit({'kind': 'interaction', 'presence': 'passed', 'round_trips': ['coins','food','potions'], 'double_accept_rejected': True})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--release-root', type=Path, default=ROOT)
    parser.add_argument('--credentials', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--seconds', type=int, default=3600)
    parser.add_argument('--intervals', default='2,8,30')
    parser.add_argument('--max-actions', type=int, default=2000)
    parser.add_argument('--work-shifts', type=int, default=12)
    parser.add_argument('--provision-db', type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    args.out.mkdir(parents=True, exist_ok=True)
    if (args.out/'events.jsonl').exists(): raise RuntimeError('Output already contains a run; use a new directory')
    intervals = [float(x) for x in args.intervals.split(',')]
    if len(intervals) != 3 or min(intervals) <= 0 or not 0 < args.seconds <= 86400 or args.max_actions <= 0:
        raise RuntimeError('Expected three positive intervals and bounded run duration/actions')
    if args.provision_db: provision(args)
    policy = Policy(args.release_root, args.work_shifts)
    credentials = json.loads(args.credentials.read_text())
    if len(credentials) != 3: raise RuntimeError('Expected three test accounts')
    bots = [Bot(credential, args.base_url, interval) for credential, interval in zip(credentials, intervals)]
    stopped = False
    def stop(*_):
        nonlocal stopped
        stopped = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    started = time.monotonic()
    log = (args.out/'events.jsonl').open('a', buffering=1)
    def emit(event):
        log.write(json.dumps({'elapsed_seconds': round(time.monotonic()-started, 3), **event}, ensure_ascii=False)+'\n')
    def summary(status):
        save_json(args.out/'summary.json', {'status': status, 'started_at_utc': start_utc,
          'elapsed_seconds': round(time.monotonic()-started, 1), 'duration_limit_seconds': args.seconds,
          'base_url': args.base_url, 'release': str(args.release_root.resolve()),
          'work_shifts_target': args.work_shifts, 'bots': [bot.summary() for bot in bots]})
    start_utc = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    emit({'kind': 'start', 'initial': [bot.summary() for bot in bots]})
    summary('starting')
    try:
        interaction_probe(bots, emit)
    except Exception as exc:
        emit({'kind': 'interaction_failed', 'error': str(exc)})
        for bot in bots: bot.status = 'probe_failed'
        summary('failed')
        raise
    started = time.monotonic()
    for bot in bots: bot.due = started
    presence_due, summary_due = started, started
    emit({'kind': 'pacing_start'})
    try:
        while not stopped and time.monotonic()-started < args.seconds:
            active = [b for b in bots if b.status == 'running']
            if not active: break
            now = time.monotonic()
            if now >= presence_due:
                for bot in active:
                    try: bot.client.call('/api/world/presence')
                    except Exception as exc: emit({'kind': 'presence_error', 'bot': bot.name, 'error': str(exc)})
                presence_due = now + 20
            for bot in active:
                if time.monotonic() < bot.due: continue
                try:
                    decision = policy.decide(bot.state, bot.memory)
                    if decision is None:
                        bot.status = 'completed'
                        continue
                    method, arguments = decision
                    technical = method in ('arrive','acknowledge','finishWork')
                    if not technical: bot.actions += 1
                    before = bot.command(method, arguments)
                    problems = check_transition(before, bot.state, method, arguments)
                    # The published validator compares eventData using JSON.stringify;
                    # Flask sorts object keys in HTTP responses. Record this known
                    # serialization defect, but keep using ordinary server commands.
                    try:
                        policy.validate(json.dumps(bot.state))
                    except Exception as exc:
                        message = str(exc).splitlines()[0]
                        if 'Повреждены участники встречи' not in message: raise
                        if message not in bot.warnings:
                            bot.warnings.append(message)
                            emit({'kind': 'validation_warning', 'bot': bot.name, 'error': message,
                                  'state': bot.state, 'cause': 'object_key_order_in_http_json'})
                    bot.visited.add(bot.state['position'])
                    if method == 'finishWork': bot.memory['shifts'] += 1
                    for key, condition in [('sword', bot.state['hero']['sword']), ('shield', bot.state['hero']['shield']),
                                           ('quest_complete', bot.state['quest'] == 'complete')]:
                        if condition and key not in bot.milestones: bot.milestones[key] = round(time.monotonic()-started, 2)
                    emit({'kind': 'command', 'bot': bot.name, 'decision': bot.actions, 'method': method,
                          'args': arguments, 'revision': bot.revision, 'before': before, 'after': bot.state, 'anomalies': problems})
                    if problems: raise RuntimeError(', '.join(problems))
                    # Bound silent command loops without counting journal text as progress.
                    bot.no_progress = bot.no_progress + 1 if metrics(before) == metrics(bot.state) else 0
                    if bot.no_progress >= 12: raise RuntimeError('12 commands without observable progress')
                    if bot.actions >= args.max_actions and bot.state['phase'] == 'ready': bot.status = 'action_limit'
                    # Resolve technical phases immediately; start the tempo delay
                    # only once a decision has reached its final visible result.
                    automatic = bot.state['phase'] in ('moving','outcome','work','work-result','won') or (
                        bot.state['phase'] == 'notice' and bot.state['notice']['stage'] != 'choice')
                    bot.due = time.monotonic() + (0 if automatic else bot.interval)
                except Exception as exc:
                    bot.errors.append(str(exc))
                    bot.status = 'error'
                    emit({'kind': 'bot_error', 'bot': bot.name, 'error': str(exc), 'state': bot.state})
            if time.monotonic() >= summary_due:
                summary('running')
                summary_due = time.monotonic() + 10
            time.sleep(.05)
    finally:
        for bot in bots:
            if bot.status == 'running': bot.status = 'stopped' if stopped else 'time_limit'
            save_json(args.out/(bot.name+'-final.json'), bot.state)
            try: bot.client.call('/api/auth/logout', {})
            except Exception: pass
        emit({'kind': 'end', 'bots': [bot.summary() for bot in bots]})
        summary('stopped' if stopped else 'finished')
        log.close()
    print(json.dumps([bot.summary() for bot in bots], ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
