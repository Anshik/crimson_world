#!/usr/bin/env python3
"""Persistent ordinary-player HTTP bots. No game rules or dice are overridden."""
from __future__ import annotations

import argparse
from collections import deque
import gzip
import http.client
import http.cookiejar
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import sys
import time
import urllib.error
import urllib.request
import uuid

try:
    from .playtest_bots import Client, HTTPFailure, Policy, check_transition, metrics, save_json
except ImportError:
    from playtest_bots import Client, HTTPFailure, Policy, check_transition, metrics, save_json

ROLES = ('aggressive', 'balanced', 'cautious', 'trader', 'hunter', 'explorer')
TRANSPORT_ERRORS = (urllib.error.URLError, TimeoutError, ConnectionError, http.client.HTTPException)


class RolePolicy(Policy):
    def __init__(self, release):
        super().__init__(release, work_shifts=4)
        self.map = json.loads((Path(release)/'assets/maps/geometry/tovilis-v9.json').read_text())
        self.encounter_cells = [c['id'] for c in self.map['cells'] if c.get('event') == 'encounter']
        self.notice_cells = [c['id'] for c in self.map['cells'] if c.get('event') == 'notice']

    def move_cell(self, s, target):
        path = json.loads(self.route(s['position'], target))
        if len(path) < 2:
            raise RuntimeError(f'No route to cell {target}')
        # Event cells cannot be selected as stops: dice still decide encounters.
        return 'begin', {'next': path[1]}

    def decide_role(self, s, memory, role):
        h, phase = s['hero'], s['phase']
        if phase in ('encounter','combat'):
            e = s['encounter']
            if not e['hostile']:
                hunt_ready=role=='hunter' and h['sword'] and h['shield'] and h['hp']>h['maxHp']*.8
                aggressive_ready=role=='aggressive' and h['hp']>h['maxHp']*.65
                if (aggressive_ready or hunt_ready) and e['kind'] == 'robber' and not e['night']:
                    return 'encounterAction', {'action':'provoke'}
                return 'encounterAction', {'action':'pass'}
            if h['hp'] < h['maxHp'] * (.65 if role == 'cautious' else .4) and h['potions']:
                return 'battle', {'action':'potion'}
            if role in ('cautious','trader','explorer'):
                if phase == 'encounter' and h['coins'] >= e['demand']:
                    return 'encounterAction', {'action':'pay'}
                return 'battle', {'action':'flee'}
            if role=='hunter' and (sum(x['hp']>0 for x in e['enemies'])>1 or h['hp']<h['maxHp']*.6):
                if phase=='encounter' and h['coins']>=e['demand']: return 'encounterAction',{'action':'pay'}
                return 'battle',{'action':'flee'}
            if h['hp'] <= (2 if role == 'aggressive' else 4):
                return 'battle', {'action':'flee'}
            enemy = min((x for x in e['enemies'] if x['hp'] > 0), key=lambda x:x['hp'])
            return 'battle', {'action':'attack','targetId':enemy['id']}
        if phase == 'notice' and s['notice']['stage'] == 'choice':
            card = json.loads(self.view(json.dumps(s)))['card']
            choices = [a[0] for a in card['actions']]
            choice = choices[0]
            if 'pass' in choices and (role in ('cautious','trader') or card['id']=='elf' and h['potions']<1):
                choice = 'pass'
            return 'noticeAction', {'action':choice}
        if phase != 'ready':
            return super().decide(s, memory)
        view = json.loads(self.view(json.dumps(s)))
        offers = {o['id']:o for o in view['services'] if o['enabled']}
        def service(a, **extra): return 'service', {'action':a, **extra}
        def nearest(ids): return min(ids, key=lambda b:len(json.loads(self.route(s['position'], self.cells[b]))))
        def surplus_sales(services):
            sales = []
            for offer in services:
                action = offer['id']
                if not offer['enabled'] or not action.startswith('sell-'):
                    continue
                item = action[5:]
                if item in ('potion','shield') or item == 'sword' and role != 'trader':
                    continue
                if h.get('equipment',{}).get('ring') == item and h['finds'].get(item,0) <= 1:
                    continue
                sales.append(offer)
            return sorted(sales, key=lambda offer: (-offer['payout'],offer['id']))
        sales = surplus_sales(view['services'])
        # Sales consume no game time. Raise money locally before leaving to
        # buy food; preserve the shield, healing stock and equipped last ring.
        if sales:
            return service(sales[0]['id'])
        inn = nearest(('tavern','near-tavern'))
        # Food is stocked for several meals; styles vary risk tolerance, not
        # access to fabricated money or automatic recovery.
        if h['food'] <= (2 if role == 'cautious' else 0) and h['coins']:
            if 'food' in offers:
                return service('food', quantity=min(3,h['coins']))
            return self.move(s, inn, view)
        threshold = .8 if role == 'cautious' else .55
        if h['hp'] < h['maxHp'] * threshold:
            if h['potions']: return 'drink', {}
            for action in ('rest','ale'):
                if action in offers: return service(action)
            if h['coins'] >= 1: return self.move(s, 'tavern', view)
        if role == 'trader':
            buyers = []
            for shop in ('shop','far-shop'):
                # Consult the actual game's offers on a hypothetical daytime
                # view, including its per-shop, per-day refusal ledger. This
                # never applies a command or changes the player's state.
                probe = {**s, 'position':self.cells[shop]}
                probe['ticks'] = s['ticks'] // 18 * 18
                shop_view = json.loads(self.view(json.dumps(probe)))
                if surplus_sales(shop_view['services']): buyers.append(shop)
            if buyers:
                buyer = nearest(buyers)
                if s['position'] != self.cells[buyer]: return self.move(s,buyer,view)
                if 'wait-opening' in offers: return service('wait-opening')
        # Peaceful roles never attack with the upgraded sword. They retain
        # defensive equipment; only fighting roles budget for a sword.
        gear = ('sword','shield') if role in ('aggressive','balanced','hunter') else ('shield',)
        for action in gear:
            if action in offers: return service(action)
        need_coins = h['coins'] < (6 if not h['shield'] else 3)
        needs_gear = role in ('aggressive','hunter','balanced') and not (h['sword'] and h['shield'])
        if need_coins or needs_gear or memory['shifts'] < memory.get('required_shifts',4):
            if s['position'] != self.cells['forge']: return self.move(s,'forge',view)
            for action in ('work-forge','wait-opening','wait-work'):
                if action in offers: return service(action)
        # Finish the one-shot city objective before the long-running loop.
        if s['quest'] == 'none':
            if 'quest' in offers: return service('quest')
            return self.move(s,'orders',view)
        if s['quest'] == 'active':
            if h['net']:
                if 'deliver' in offers: return service('deliver')
                return self.move(s,'port',view)
            if 'net' in offers: return service('net')
            if s['position'] == self.cells['shop']:
                if 'wait-opening' in offers: return service('wait-opening')
                memory['required_shifts'] = memory['shifts'] + 2
                return self.move(s,'forge',view)
            return self.move(s,'shop',view)
        if role in ('aggressive','hunter'):
            candidates = [c for c in self.encounter_cells if c != s['position']]
            target = min(candidates, key=lambda c:(memory.get('cell_visits',{}).get(c,0),len(json.loads(self.route(s['position'],c)))))
            return self.move_cell(s,target)
        if role in ('trader','explorer'):
            candidates = [c['id'] for c in self.map['cells'] if c.get('walkable') and c['id'] != s['position']]
            if role == 'trader': candidates = [c for c in self.notice_cells if c!=s['position']]
            target = memory.get('target_cell')
            if not target or target == s['position'] or memory.get('target_attempts',0)>=12:
                target = min(candidates,key=lambda c:(memory.get('cell_visits',{}).get(c,0),len(json.loads(self.route(s['position'],c)))))
                memory['target_cell'],memory['target_attempts'] = target,0
            memory['target_attempts'] = memory.get('target_attempts',0)+1
            return self.move_cell(s,target)
        route = ['mill','tavern','far-shop','port','near-tavern','orders','forge']
        index = memory.get('tour_index',0)%len(route)
        if s['position'] == self.cells[route[index]]:
            index = (index+1)%len(route);memory['tour_index']=index
            if index == 0: memory['required_shifts'] = memory['shifts']+2
        return self.move(s,route[index],view)


class EventLog:
    def __init__(self, directory):
        self.directory=directory;self.stream=None;self.hour=None
        current='events-'+time.strftime('%Y%m%d-%H',time.gmtime())+'.jsonl'
        for path in directory.glob('events-*.jsonl'):
            if path.name!=current: self.archive(path)

    @staticmethod
    def archive(path):
        with path.open('rb') as src,gzip.open(str(path)+'.gz','wb') as dst: shutil.copyfileobj(src,dst)
        path.unlink()

    def emit(self, event):
        hour=time.strftime('%Y%m%d-%H',time.gmtime())
        if hour != self.hour:
            if self.stream:
                old=Path(self.stream.name);self.stream.close()
                self.archive(old)
            self.hour=hour
            self.stream=(self.directory/f'events-{hour}.jsonl').open('a',buffering=1)
            for path in self.directory.glob('events-*.jsonl.gz'):
                if time.time()-path.stat().st_mtime>7*86400: path.unlink()
        self.stream.write(json.dumps({'time_utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),**event},ensure_ascii=False)+'\n')


class PersistentBot:
    def __init__(self, credential, base, directory):
        self.name=credential['username'];self.role=credential['role'];self.interval=credential['interval']
        self.credential=credential;self.client=Client(base)
        self.cookies=http.cookiejar.LWPCookieJar(str(directory/(self.name+'-cookies.txt')))
        try: self.cookies.load(ignore_discard=True)
        except (FileNotFoundError,http.cookiejar.LoadError): pass
        self.client.jar=self.cookies
        self.client.opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookies))
        self.client.latencies=deque(maxlen=1000)
        self.path=directory/(self.name+'-checkpoint.json')
        saved=json.loads(self.path.read_text()) if self.path.exists() else {}
        self.state=saved.get('state');self.revision=saved.get('revision')
        self.memory=saved.get('memory',{'shifts':0,'cell_visits':{}})
        self.actions=saved.get('actions',0);self.commands=saved.get('commands',0)
        self.pending=saved.get('pending');self.no_progress=saved.get('no_progress',0)
        self.incidents=saved.get('incidents',{});self.status=saved.get('status','connecting')
        self.connected=False;self.failures=0;self.due=0;self.last_success=saved.get('last_success')
        self.uid=saved.get('uid');self.last_presence=0

    def checkpoint(self):
        save_json(self.path,{k:getattr(self,k) for k in ('state','revision','memory','actions','commands','pending','no_progress','incidents','status','last_success','uid')})

    def connect(self):
        me=None
        if len(self.cookies):
            try: me=self.client.call('/api/me')
            except HTTPFailure as exc:
                if exc.status!=401: raise
        if me is None:
            self.client.call('/api/auth/login',{'login':self.name,'password':self.credential['password']})
            me=self.client.call('/api/me')
        for cookie in self.cookies:
            if cookie.name=='cw_csrf' and me.get('csrf'): cookie.value=me['csrf']
        self.cookies.save(ignore_discard=True);Path(self.cookies.filename).chmod(0o600)
        self.uid=me['user']['id']
        # An unresolved command is replayed against its original revision/key,
        # even if /me already includes its committed result.
        if not self.pending:
            self.state,self.revision=me['state'],me['revision']
        self.connected=True

    def prepare(self, policy):
        if self.pending: return
        method,args=policy.decide_role(self.state,self.memory,self.role)
        if method not in ('arrive','acknowledge','finishWork'): self.actions+=1
        self.pending={'method':method,'args':args,'revision':self.revision,'commandId':uuid.uuid4().hex}
        self.checkpoint()

    def execute(self):
        before=self.state
        result=self.client.call('/api/commands',self.pending)
        if result['revision']!=self.pending['revision']+1: raise RuntimeError('Unexpected command revision')
        self.state,self.revision=result['state'],result['revision']
        return before

    def summary(self):
        latency=sorted(self.client.latencies)
        return {'name':self.name,'user_id':self.uid,'role':self.role,'interval_seconds':self.interval,
                'status':self.status,'decisions':self.actions,'commands':self.commands,'work_shifts':self.memory['shifts'],
                'last_success_utc':self.last_success,'incidents':self.incidents,
                'visited_cells':len(self.memory.get('cell_visits',{})),
                'http_p95_ms':latency[min(len(latency)-1,int(len(latency)*.95))] if latency else None,
                **(metrics(self.state) if self.state else {})}


def register_roles(args):
    """Reuse the original three players; provision only three new roles."""
    sys.path.insert(0,str(args.release_root))
    from server.core import Store
    store=Store(args.setup_db)
    if args.credentials.exists():
        credentials=json.loads(args.credentials.read_text())
    else:
        original=json.loads(args.setup_from.read_text())
        credentials=[{**c,'role':role,'interval':interval} for c,role,interval in zip(original,ROLES[:3],(2,8,30))]
        suffix=time.strftime('%m%d%H%M',time.gmtime())
        credentials += [{'username':f'qa-{role}-{suffix}','password':secrets.token_urlsafe(24),'role':role,'interval':8}
                        for role in ROLES[3:]]
        save_json(args.credentials,credentials)
    for credential in credentials:
        with store.db() as db:
            found=db.execute('SELECT id FROM users WHERE username_key=?',(credential['username'].casefold(),)).fetchone()
            count=db.execute('SELECT count(*) FROM users').fetchone()[0]
        client=Client(args.base_url)
        if not found:
            if count>=8: raise RuntimeError('Refusing to consume the last two pilot account slots')
            invite=store.create_invites(1,1,'continuous-bot-'+credential['role'])[0][1]
            client.call('/api/auth/register',{k:credential[k] for k in ('username','password')}|{'inviteCode':invite})
        else:
            state,_=store.state(found[0])
            if not state['hero']['character'].get('legacy'): continue
            client.call('/api/auth/login',{'login':credential['username'],'password':credential['password']})
        me=client.call('/api/me')
        if me['state']['hero']['character'].get('legacy'):
            client.call('/api/commands',{'method':'createCharacter','args':{'profile':{'name':credential['username'],
                'sex':'male','race':'dwarf','origin':'dwarf','class':'warrior'}},'revision':me['revision'],'commandId':uuid.uuid4().hex})
        client.call('/api/auth/logout',{})
    print(json.dumps({'prepared':len(credentials),'roles':[c['role'] for c in credentials]}))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url',required=True);parser.add_argument('--release-root',type=Path,required=True)
    parser.add_argument('--credentials',type=Path,required=True);parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--setup-from',type=Path);parser.add_argument('--setup-db',type=Path)
    parser.add_argument('--minimum-free-mb',type=int,default=2048)
    parser.add_argument('--seconds',type=float,help='Optional finite duration for a disposable smoke test')
    args=parser.parse_args();os.umask(0o077);args.out.mkdir(parents=True,exist_ok=True)
    if args.setup_from:
        if not args.setup_db: parser.error('--setup-from requires --setup-db')
        register_roles(args);return
    policy=RolePolicy(args.release_root)
    credentials=json.loads(args.credentials.read_text())
    bots=[PersistentBot(c,args.base_url,args.out) for c in credentials]
    log=EventLog(args.out);stopped=False;started=time.monotonic();summary_due=0;disk_due=0;disk_ok=True
    def stop(*_):
        nonlocal stopped
        stopped=True
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    def incident(bot,kind,error):
        key=kind+':'+str(error).splitlines()[0][:250]
        record=bot.incidents.setdefault(key,{'count':0,'first_utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())})
        record['count']+=1;record['last_utc']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
        # First occurrence and exponential count milestones keep alerts bounded.
        if record['count'] & (record['count']-1)==0:
            log.emit({'kind':kind,'bot':bot.name,'role':bot.role,'error':str(error),'count':record['count'],
                      'revision':bot.revision,'state':bot.state})
    log.emit({'kind':'process_start','roles':[{'name':b.name,'role':b.role,'interval':b.interval} for b in bots]})
    try:
        while not stopped and (args.seconds is None or time.monotonic()-started<args.seconds):
            now=time.monotonic()
            if now>=disk_due:
                disk_ok=shutil.disk_usage(args.out).free>=args.minimum_free_mb*1024*1024
                disk_due=now+60
            for bot in bots:
                if not disk_ok or now<bot.due or bot.status=='needs_attention': continue
                try:
                    if not bot.connected: bot.connect()
                    if now-bot.last_presence>=20:
                        bot.client.call('/api/world/presence');bot.last_presence=now
                    bot.prepare(policy)
                    before=bot.execute();payload=bot.pending
                    # The response confirms the command. Commit this observation
                    # even if a subsequent diagnostic rejects its arithmetic.
                    bot.pending=None
                    bot.commands+=1
                    if payload['method']=='finishWork': bot.memory['shifts']+=1
                    problems=check_transition(before,bot.state,payload['method'],payload['args'])
                    visits=bot.memory.setdefault('cell_visits',{})
                    if before['position']!=bot.state['position']:
                        if bot.state['position'] not in visits: bot.memory['last_new_cell_decision']=bot.actions
                        visits[bot.state['position']]=visits.get(bot.state['position'],0)+1
                    bot.no_progress=bot.no_progress+1 if metrics(before)==metrics(bot.state) else 0
                    log.emit({'kind':'command','bot':bot.name,'role':bot.role,'decision':bot.actions,
                              'command_id':payload['commandId'],'method':payload['method'],'args':payload['args'],
                              'revision':bot.revision,'before':metrics(before),'after':metrics(bot.state),'anomalies':problems,
                              'combat':(bot.state.get('encounter') or {}).get('report') if payload['method']=='battle' else None,
                              'movement':bot.state.get('pending') if payload['method']=='begin' else None,
                              'notice':bot.state.get('notice') if payload['method']=='noticeAction' else None,
                              'outcome':bot.state.get('outcome')})
                    bot.status='running';bot.failures=0
                    bot.last_success=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
                    try: policy.validate(json.dumps(bot.state))
                    except Exception as exc:
                        if 'Повреждены участники встречи' not in str(exc): raise
                        if not any(k.startswith('validation_warning:') for k in bot.incidents): incident(bot,'validation_warning',str(exc).splitlines()[0])
                    if problems: raise RuntimeError('Arithmetic anomaly: '+','.join(problems))
                    if bot.no_progress>=12: raise RuntimeError('12 commands without observable progress')
                    if bot.role=='explorer' and bot.actions-bot.memory.get('last_new_cell_decision',0)>=200 and not bot.memory.get('exploration_saturation_reported'):
                        incident(bot,'playability_warning','200 decisions without reaching a new cell')
                        bot.memory['exploration_saturation_reported']=True
                    automatic=bot.state['phase'] in ('moving','outcome','work','work-result','won') or (
                        bot.state['phase']=='notice' and bot.state['notice']['stage']!='choice')
                    bot.due=time.monotonic()+(0 if automatic else bot.interval)
                    bot.checkpoint()
                except TRANSPORT_ERRORS as exc:
                    incident(bot,'transport_error',exc);bot.failures+=1;bot.status='retrying'
                    bot.due=time.monotonic()+min(60,2**min(bot.failures,6));bot.checkpoint()
                except HTTPFailure as exc:
                    incident(bot,'http_error',exc)
                    if exc.status in (401,403,408,429) or exc.status>=500:
                        if exc.status in (401,403): bot.connected=False
                        bot.status='retrying';bot.due=time.monotonic()+60
                    elif exc.status==409 and 'revision' in exc.body:
                        # A rejected stale command changed nothing. Refresh and
                        # replan; never replace a key after a transport failure.
                        bot.pending=None;bot.connected=False;bot.status='retrying';bot.due=time.monotonic()+5
                    else: bot.status='needs_attention'
                    bot.checkpoint()
                except Exception as exc:
                    incident(bot,'bot_error',exc);bot.status='needs_attention';bot.checkpoint()
            if time.monotonic()>=summary_due:
                save_json(args.out/'summary.json',{'status':'running' if disk_ok else 'disk_reserve_pause',
                    'updated_at_utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'continuous':True,
                    'release':str(args.release_root.resolve()),'free_disk_mb':shutil.disk_usage(args.out).free//(1024*1024),
                    'bots':[b.summary() for b in bots]})
                summary_due=time.monotonic()+10
            time.sleep(.05)
    finally:
        for bot in bots:
            bot.checkpoint()
        log.emit({'kind':'process_stop'})
        save_json(args.out/'summary.json',{'status':'stopped','continuous':True,
            'updated_at_utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),
            'bots':[b.summary() for b in bots]})


if __name__=='__main__': main()
