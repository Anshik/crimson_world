# Алый Мир — Товилис

Браузерная игра: путешествие по Товилису, встречи, поручения и бой. Онлайн-режим использует Flask, QuickJS и SQLite.

## Запуск локально

Нужны Python 3.10+ и Node.js для тестов JavaScript.

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m server
```

Откройте http://127.0.0.1:8000 . SQLite-база создаётся автоматически в `data/` и не хранится в Git.

Для запуска через Gunicorn:

```sh
gunicorn --bind 127.0.0.1:8000 --workers 1 --threads 4 server.app:app
```

Переменная `CRIMSON_DB` задаёт путь к базе; `ADMIN_EMAILS` — адреса разрешённых администраторов. Существующую базу на VPS храните отдельно от кода и сохраняйте при обновлениях.

## Состав проекта

- `game/` — интерфейс, контент и правила.
- `server/` — API, хранение партий и администрирование.
- `assets/` — текущая карта, её геометрия и используемые изображения.
- `docs/tovilis-map*` — данные карты и просмотр разметки.
- `tests/` — тесты игры и сервера.
- `tools/` — сборка и проверка карты.
- `deploy/` — конфигурация службы VPS; [инструкция](docs/DEPLOYMENT.md).

Исторические архивы, исследования, промежуточные изображения, локальные базы и окружения исключены из репозитория. Отправка в GitHub сама по себе не запускает развёртывание на VPS.

## Проверки

```sh
node --test tests/*.test.cjs
python -m unittest discover -s tests -p 'test_*.py'
python tools/validate_tovilis_map.py
```
