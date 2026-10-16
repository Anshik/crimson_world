"""Player history written in the same transaction as authoritative state changes."""
import json
import time


def init_monitoring(c):
    if 'is_bot' not in {r[1] for r in c.execute('PRAGMA table_info(users)')}:
        c.execute('ALTER TABLE users ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0')
    if 'last_seen' not in {r[1] for r in c.execute('PRAGMA table_info(users)')}:
        c.execute('ALTER TABLE users ADD COLUMN last_seen INTEGER')
        c.execute('UPDATE users SET last_seen=(SELECT MAX(last_seen) FROM sessions WHERE user_id=users.id)')
    if 'is_bot' not in {r[1] for r in c.execute('PRAGMA table_info(invites)')}:
        c.execute('ALTER TABLE invites ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0')
    c.executescript('''
        CREATE TABLE IF NOT EXISTS player_events(
            id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at INTEGER NOT NULL, revision INTEGER NOT NULL,
            method TEXT NOT NULL, args TEXT NOT NULL, snapshot TEXT NOT NULL,
            changes TEXT NOT NULL, journal TEXT NOT NULL, turns INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS player_events_user_date ON player_events(user_id,created_at,id);
        CREATE TABLE IF NOT EXISTS admin_audit(
            id INTEGER PRIMARY KEY, actor INTEGER NOT NULL, user_id INTEGER NOT NULL,
            created_at INTEGER NOT NULL, action TEXT NOT NULL, before_value TEXT, after_value TEXT);
    ''')
    # One honest baseline: existing commands have no wall-clock timestamps.
    c.execute('BEGIN IMMEDIATE')
    for row in c.execute('SELECT user_id,state,revision FROM game_states WHERE NOT EXISTS (SELECT 1 FROM player_events e WHERE e.user_id=game_states.user_id)').fetchall():
        record_event(c, row['user_id'], row['revision'], 'baseline', {}, None, json.loads(row['state']))
    c.execute('COMMIT')


def record_event(c, uid, revision, method, args, before, after):
    hero = after.get('hero', {})
    old_hero = (before or {}).get('hero', {})
    changes = {k: {'before': old_hero.get(k), 'after': v} for k, v in hero.items() if old_hero.get(k) != v}
    if (before or {}).get('bank', {}) != after.get('bank', {}):
        changes['bank'] = {'before': (before or {}).get('bank', {}), 'after': after.get('bank', {})}
    journal = after.get('journal', [])
    old_journal = (before or {}).get('journal', [])
    overlap = 0
    for n in range(1, min(len(old_journal), len(journal)) + 1):
        if old_journal[-n:] == journal[:n]:
            overlap = n
    snapshot = {k: after.get(k) for k in ('hero', 'bank', 'position', 'phase', 'turn', 'ticks', 'quest')}
    if method == 'baseline':
        snapshot['journal'] = journal
    turns = max(0, after.get('turn', 0) - (before or after).get('turn', 0))
    c.execute('INSERT INTO player_events(user_id,created_at,revision,method,args,snapshot,changes,journal,turns) VALUES(?,?,?,?,?,?,?,?,?)',
              (uid, int(time.time()), revision, method, json.dumps(args, ensure_ascii=False),
               json.dumps(snapshot, ensure_ascii=False), json.dumps(changes, ensure_ascii=False),
               json.dumps([] if method == 'baseline' else journal[overlap:], ensure_ascii=False), turns))


def player_summary(row):
    result = {k: row[k] for k in ('id', 'username', 'created_at', 'is_bot', 'admin', 'revision', 'updated_at', 'last_seen')}
    state = json.loads(row['state']) if row['state'] else {}
    hero = state.get('hero', {})
    result.update(name=hero.get('name'), character=hero.get('character'), phase=state.get('phase'),
                  position=state.get('position'), turn=state.get('turn', 0),
                  hero={k: hero.get(k) for k in ('hp', 'maxHp', 'strength', 'agility', 'defense', 'experience', 'reputation', 'coins')})
    return result


PLAYER_QUERY = '''SELECT u.id,u.username,u.created_at,u.is_bot,u.admin,g.state,g.revision,g.updated_at,
    u.last_seen
    FROM users u LEFT JOIN game_states g ON g.user_id=u.id'''


def recover_legacy_journal(rows, baseline):
    """Recover journal entries from old response snapshots, without assigning dates."""
    result, previous = [], []
    for journal in [*(json.loads(row['response']).get('journal', []) for row in rows), baseline]:
        overlap = 0
        for n in range(1, min(len(previous), len(journal)) + 1):
            if previous[-n:] == journal[:n]: overlap = n
        result.extend(journal[overlap:])
        previous = journal
    return result
