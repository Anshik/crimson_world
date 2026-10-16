#!/usr/bin/env python3
"""Package the public game and Python runtime, excluding sources and credentials."""
import argparse
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import tarfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    paths = []
    for folder, suffixes in [('server', {'.py'}), ('game', {'.js', '.html', '.css'}),
                             ('assets/characters', {'.png'}), ('assets/illustrations', {'.png'}),
                             ('deploy', {'.service', '.timer', '.example'})]:
        paths.extend(p for p in (ROOT / folder).glob('*') if p.is_file() and p.suffix in suffixes)
    paths.extend(ROOT / name for name in [
        'requirements.txt', 'requirements.lock', 'deploy/Caddyfile', 'tools/backup_game.py',
        'docs/tovilis-map-data.js', 'assets/maps/geometry/tovilis-v9.json',
        'assets/maps/working/tovilis-v9.png'])
    paths = sorted(set(paths))
    files = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
    build_id = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()[:16]
    metadata = json.dumps({'buildId': build_id, 'createdAt': datetime.now(timezone.utc).isoformat(), 'files': files}, indent=2).encode()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(args.output, 'w:gz') as archive:
        for path in paths:
            archive.add(path, arcname=path.relative_to(ROOT), recursive=False)
        info = tarfile.TarInfo('build.json'); info.size = len(metadata); info.mode = 0o644
        archive.addfile(info, io.BytesIO(metadata))
    print(json.dumps({'buildId': build_id, 'files': len(files), 'archive': str(args.output.resolve()), 'bytes': args.output.stat().st_size}))


if __name__ == '__main__':
    main()
