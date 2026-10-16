# Контракт API анкеты героя

`game/characters.js` экспортирует UMD-глобал `window.TOVILIS_CHARACTERS` (Node: `require('./game/characters.js')`). В браузере файл должен быть подключён до `equipment.js` и `rules.js`.

Публичные определения:

- `characters.sexes`: `{male: 'Мужчина', female: 'Женщина'}`;
- `characters.races`: человек `human`, гном `dwarf`, эльф `elf`, с допустимыми `origins`;
- `characters.origins`: `north`, `dwarf`, `highElf`, `forestElf`, `tovilis`, `taranaris`, `crimsonDragon`, `abir`, `sevenMines`;
- `characters.classes`: `warrior`, `mage`, `thief`, `scout`.

`characters.profile({name, sex, race, origin, class})` нормализует имя и возвращает проверенный профиль с полями `base`, `maxHp`, `skills`, `restrictions` и `labels`. Входные ключи `race`, `origin` и `class` обязательны для серверной анкеты; `race` также проверяется на соответствие происхождению. `characters.baseFor(hero, legacyBase)` возвращает рассчитанную базу для нового героя либо `legacyBase` для `hero.character.legacy`.

`rules.createCharacter(profile)` создаёт состояние версии 9. `rules.create()` сохраняет исторического гнома и помечает его `hero.character.legacy`. Сервер должен принимать только профиль, передавать его в `createCharacter`, а характеристики, ЖС и ограничения брать из возвращённого состояния. Нельзя принимать от клиента `base`, `maxHp`, `strength`, `agility` или `equipment` как источник истины.
