"""Small operator CLI. Administrative grants are explicitly allowlisted."""
import argparse, os
from .core import Store

def main():
    p=argparse.ArgumentParser(); p.add_argument("command",choices=("feedback","status","grant-admin","invite-create","invite-list","invite-revoke","reset-password")); p.add_argument("id",nargs="?"); p.add_argument("value",nargs="?"); p.add_argument('--detail',action='store_true'); p.add_argument('--count',type=int,default=1); p.add_argument('--days',type=int,default=30); p.add_argument('--label',default=''); p.add_argument('--bot',action='store_true'); a=p.parse_args(); s=Store()
    with s.db() as c:
        if a.command=="feedback":
            query="SELECT id,category,title,status,created_at,body,context,user_id FROM feedback ORDER BY id DESC" if a.detail else "SELECT id,category,title,status,created_at FROM feedback ORDER BY id DESC"
            for r in c.execute(query): print(dict(r))
        elif a.command=="status":
            if not a.id or a.value not in ("open","in_progress","fixed","closed"): p.error("status ID open|in_progress|fixed|closed")
            try: ident=int(a.id)
            except ValueError: p.error('status ID must be an integer')
            if c.execute("SELECT 1 FROM feedback WHERE id=?",(ident,)).fetchone() is None: p.error('feedback item not found')
            c.execute("UPDATE feedback SET status=? WHERE id=?",(a.value,ident))
        elif a.command=="grant-admin":
            login=(a.id or '').strip()
            if not login: p.error("grant-admin LOGIN")
            allowed=[x.strip().casefold() for x in os.environ.get("ADMIN_LOGINS","").split(',') if x.strip()]
            if login.casefold() not in allowed: p.error("login must be listed in ADMIN_LOGINS")
            if c.execute("UPDATE users SET admin=1 WHERE username_key=? OR lower(legacy_login)=?",(login.casefold(),login.casefold())).rowcount != 1: p.error('user not found')
        elif a.command=='invite-create':
            for ident,raw in s.create_invites(a.count,a.days,a.label,is_bot=a.bot): print(f'{ident}\t{raw}')
        elif a.command=='invite-list':
            for item in s.list_invites(): print(item)
        elif a.command=='invite-revoke':
            if not a.id or not s.revoke_invite(int(a.id)): p.error('invite not found or already used')
        elif a.command=='reset-password':
            if not a.id: p.error('reset-password LOGIN')
            token=s.issue_reset(a.id)
            if not token: p.error('user not found')
            print(token)
if __name__ == '__main__': main()
