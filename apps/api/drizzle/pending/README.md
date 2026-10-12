# `drizzle/pending` — подготовленные, но не выкатываемые миграции

Каталог `apps/api/drizzle/` плоский, и мигратор катит **всё, что в нём лежит**: положи сюда файл с
номером — и он уедет ближайшим же деплоем. Реформе доступа это запрещено правилом трёх релизов
(план реструктуризации §13.2): между `prepare`, `migrate` и `cleanup` обязан пройти выкат, иначе
снимок, взведённые назначения и перевод учёток случаются одной транзакцией времени и откат «через
шаг» становится невозможен.

Отсюда этот подкаталог. Файлы в нём — готовый SQL будущих релизов: написан, прочитан, проверен
тестом, но **не номерован** и потому не является миграцией.

## Почему отсюда ничего не уедет

Список миграций собирает ровно одна функция — `listMigrationFiles()`
(`apps/api/src/db/migration-journal.ts`):

```ts
readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
```

`readdirSync` без `recursive` возвращает имена **входов каталога**, а не дерево; имя `pending` на
`.sql` не оканчивается и отсеивается фильтром. Внутрь каталога никто не заглядывает.

Через эту же функцию ходят все остальные читатели — второго обхода каталога в проекте нет:

| Читатель                                            | Что делает                                        |
| --------------------------------------------------- | -------------------------------------------------- |
| `applyMigrations` (`db:migrate`)                    | накат: то, чего нет в `_migrations`                |
| `diffMigrations` (`db:migrate:check`, `:status`)    | гейт деплоя «есть неприменённые»                   |
| `migration-report.ts` (`db:migrate:files`)          | состав миграций образа для гейтов отката           |
| `checkMigrations` (`db/migration-check.ts`)         | стартовая сверка сервера «код и схема разошлись»   |

Поэтому подготовленный файл не виден ни накату, ни журналу, ни `.meta` бэкапа, ни границам отката
(`schema-floor.state`): для них его не существует. В образ он всё же попадает (`COPY . .` в
`deploy/Dockerfile.api`) — это безвредно и удобно: файл лежит рядом со своим релизом.

Инвариант закреплён тестом `apps/api/test/migration-pending-dir.test.ts`: он требует, чтобы имя
каталога не оканчивалось на `.sql` и чтобы ни один здешний файл не попал в `listMigrationFiles()`.

## Как файл становится миграцией

В релизе своего шага — и только тогда:

```bash
ls apps/api/drizzle/            # занятый номер + 1; номера идут параллельными потоками, проверять обязательно
git mv apps/api/drizzle/pending/<файл>.sql apps/api/drizzle/<NNNN>_<имя>.sql
```

Содержимое при этом не правится: номер — единственное, что файл получает при выкате. Условие
готовности шага и порядок относительно выката — в `docs/runbook.md`, раздел «Перевод ролей».

## What lies here

| File                                    | Step                                         | Release                                           |
| --------------------------------------- | -------------------------------------------- | ------------------------------------------------- |
| `stage8-migrate-site-role.sql`          | stage 8, `migrate`                           | the one after prepare (`0154`–`0156`)             |
| `stage9-migrate-department-role.sql`    | stage 9, `migrate`                           | the same one or the next                          |
| `stage8-cleanup-site-role.sql`          | stage 8, `cleanup`                           | the one after stage 8 `migrate`                   |
| `stage9-cleanup-department-role.sql`    | stage 9, `cleanup`                           | the one after stage 9 `migrate`                   |
| `service-chat-drop-service-comment.sql` | request discussion, release C                | the one after release B (ADR 0141, plan §3.10)    |
| `department-object-column-drop.sql`     | department objects stage 9, release B        | the one after release A (ADR 0144)                |
| `vehicle-type-waybill-form-check.sql`   | ADR 0128: CHECK `4p\|leg3`, guard names `esm2` types | R2, after R1 is confirmed deployed |

Step 1e (`step1e-drop-user-role-addons.sql`) left this directory: it became a numbered migration in
the release after 1d, by the procedure above.
