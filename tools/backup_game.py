#!/usr/bin/env python3
"""Consistent online SQLite backup; keep the latest fourteen daily copies."""
import argparse
from datetime import datetime, timezone
from pathlib import Path
import sqlite3


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('database', type=Path)
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    if not args.database.is_file():
        raise SystemExit('Database does not exist')
    args.directory.mkdir(parents=True, exist_ok=True)
    target = args.directory / ('game-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '.sqlite')
    pending = target.with_suffix('.partial')
    try:
        with sqlite3.connect(args.database.resolve().as_uri() + '?mode=ro', uri=True) as source:
            with sqlite3.connect(pending) as destination:
                source.backup(destination)
                if destination.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise SystemExit('Backup integrity check failed')
        pending.replace(target)
    finally:
        pending.unlink(missing_ok=True)
    for old in sorted(args.directory.glob('game-*.sqlite'), reverse=True)[14:]:
        old.unlink()
    print(target.name)


if __name__ == '__main__':
    main()
