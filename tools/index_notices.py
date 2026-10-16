#!/usr/bin/env python3
"""Build a searchable, lossless index of every notices source field."""
from __future__ import annotations

import argparse, json, re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'docs/rules/sources/notices.md'
OUTPUT = ROOT / 'docs/rules/notices-index.json'
IMPLEMENTED = {
    ('t1-r30', 2): 'fortune', ('t1-r28', 1): 'find', ('t1-r34', 1): 'fall',
    ('t1-r31', 2): 'mood', ('t1-r37', 1): 'actors', ('t1-r37', 2): 'friend',
    ('t1-r28', 2): 'chase', ('t1-r34', 2): 'elf', ('t1-r35', 2): 'wasp',
    ('t1-r43', 1): 'cat', ('t1-r43', 2): 'water', ('t1-r27', 2): 'rescuer',
}

def _context(text: str) -> str:
    first = text.strip().splitlines()[0].strip() if text.strip() else ''
    if re.match(r'^Н\.?\s*П\.?\b', first, re.I): return 'Н.П.'
    if re.match(r'^Б\.?\s*К\.?\b|^БК\.?\b', first, re.I): return 'Б.К.'
    if re.match(r'^Тр\.?\b', first, re.I): return 'Тр.'
    return 'не указан'

def _conditions(text: str, context: str) -> list[str]:
    lines = [x.strip() for x in text.splitlines() if x.strip()]
    if context == 'не указан': return []
    result = []
    first = lines[0] if lines else ''
    prefix = re.sub(r'^(?:Н\.?\s*П\.?|Б\.?\s*К\.?|БК\.?|Тр\.?)\s*', '', first, flags=re.I).strip()
    if prefix: result.append(prefix)
    for line in lines[1:]:
        if re.match(r'^(?:Только|Не |Если |Даже |Все ваши спутники|При |Вне |Кроме )', line, re.I):
            result.append(line)
    return list(dict.fromkeys(result))

def _unsupported(text: str, context: str, city: bool, implemented: str | None) -> list[str]:
    if implemented: return []
    out = []
    if context == 'Б.К.': out.append('большая карта')
    if context == 'Тр.': out.append('трактирная колода')
    if not city and context == 'не указан': out.append('контекст источника не указан')
    for needle, label in (('маг', 'магия'), ('заклин', 'заклинания'), ('кораб', 'корабли'), ('карет', 'верховой/транспорт'), ('лошад', 'лошади'), ('оруж', 'расширенное оружие'), ('алхим', 'алхимия'), ('ключ', 'ключи и замки'), ('банк', 'банк'), ('артефакт', 'артефакты')):
        if needle in text.lower() and label not in out: out.append(label)
    if city: out.append('условия или последствия требуют отдельной механики')
    return out

def build(source: Path = SOURCE) -> dict:
    raw = source.read_text(encoding='utf-8')
    chunks = re.split(r'<a id="([^"]+)"></a>', raw)
    entries = []
    for i in range(1, len(chunks), 2):
        anchor, body = chunks[i], chunks[i + 1]
        for match in re.finditer(r'\*\*Поле (\d+):\*\*\s*\n\n(.*?)(?=\n\n\*\*Поле \d+:\*\*|\Z)', body, re.S):
            field = int(match.group(1)); text = match.group(2).strip()
            context = _context(text); implemented = IMPLEMENTED.get((anchor, field))
            city = context == 'Н.П.'
            entries.append({
                'sourceAnchor': anchor, 'sourceField': field, 'fullText': text,
                'context': context, 'applicableCity': city,
                'conditionsRaw': _conditions(text, context),
                'supportImplemented12': [implemented] if implemented else [],
                'unsupportedSystemsBacklog': _unsupported(text, context, city, implemented),
            })
    entries.sort(key=lambda x: (x['sourceAnchor'].split('-')[0], int(x['sourceAnchor'].split('-r')[1]), x['sourceField']))
    return {'source': 'docs/rules/sources/notices.md', 'generatedBy': 'tools/index_notices.py', 'entryCount': len(entries), 'entries': entries}

def main() -> int:
    parser = argparse.ArgumentParser(); parser.add_argument('--check', action='store_true'); parser.add_argument('--source', type=Path, default=SOURCE); parser.add_argument('--output', type=Path, default=OUTPUT); args = parser.parse_args()
    result = build(args.source); encoded = json.dumps(result, ensure_ascii=False, indent=2) + '\n'
    if args.check:
        if not args.output.exists() or args.output.read_text(encoding='utf-8') != encoded: print('notices-index.json is stale'); return 1
        print(f"ok: {result['entryCount']} notice fields indexed"); return 0
    args.output.write_text(encoded, encoding='utf-8'); print(f"wrote {args.output} ({result['entryCount']} notice fields)"); return 0

if __name__ == '__main__': raise SystemExit(main())
