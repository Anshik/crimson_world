"""The operator backup must include committed data still in SQLite WAL."""
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class BackupTests(unittest.TestCase):
    def test_backup_sees_committed_wal_while_game_connection_stays_open(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source = base / 'game.sqlite'
            with sqlite3.connect(source) as live:
                live.execute('PRAGMA journal_mode=WAL')
                live.execute('CREATE TABLE progress(id INTEGER PRIMARY KEY, value TEXT)')
                live.execute('INSERT INTO progress VALUES(1, ?)', ('Новое сохранение',))
                live.commit()
                self.assertTrue(Path(str(source) + '-wal').exists())
                subprocess.run([sys.executable, str(ROOT / 'tools/backup_game.py'), str(source), str(base / 'copies')], check=True, capture_output=True)
                copies = list((base / 'copies').glob('*.sqlite'))
                self.assertEqual(len(copies), 1)
                with sqlite3.connect(copies[0]) as saved:
                    self.assertEqual(saved.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
                    self.assertEqual(saved.execute('SELECT value FROM progress').fetchone()[0], 'Новое сохранение')
                self.assertEqual(live.execute('SELECT COUNT(*) FROM progress').fetchone()[0], 1)

    def test_missing_source_never_creates_an_empty_database_or_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            out = subprocess.run([sys.executable, str(ROOT / 'tools/backup_game.py'), str(base / 'absent.sqlite'), str(base / 'copies')], capture_output=True)
            self.assertNotEqual(out.returncode, 0)
            self.assertFalse((base / 'absent.sqlite').exists())
            self.assertFalse((base / 'copies').exists())


if __name__ == '__main__':
    unittest.main()
