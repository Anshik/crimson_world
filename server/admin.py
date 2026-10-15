"""Small operator CLI. Admin access is always explicit via ADMIN_EMAILS."""
import argparse, os
from .core import Store

def main():
    p=argparse.ArgumentParser(); p.add_argument("command",choices=("feedback","status","grant-admin")); p.add_argument("id",nargs="?"); p.add_argument("value",nargs="?"); a=p.parse_args(); s=Store()
    with s.db() as c:
        if a.command=="feedback":
            for r in c.execute("SELECT id,category,title,status,created_at FROM feedback ORDER BY id DESC"): print(dict(r))
        elif a.command=="status":
            if not a.id or a.value not in ("open","in_progress","fixed","closed"): p.error("status ID open|in_progress|fixed|closed")
            c.execute("UPDATE feedback SET status=? WHERE id=?",(a.value,int(a.id)))
        else:
            if not a.value: p.error("grant-admin EMAIL")
            if a.value.lower() not in [x.strip().lower() for x in os.environ.get("ADMIN_EMAILS","").split(",") if x.strip()]: p.error("email must be listed in ADMIN_EMAILS")
            c.execute("UPDATE users SET admin=1 WHERE email=?",(a.value.lower(),))
if __name__ == '__main__': main()
