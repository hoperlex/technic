# План интеграции почтового сервиса

Статус: черновик к согласованию. Целевой ADR — `docs/adr/0039-email-delivery.md` (номер проверить
перед созданием: поток ADR и поток миграций нумеруются независимо).

Область: три сценария — верификация почты при регистрации, восстановление доступа со сбросом на
автогенерируемый пароль, оповещения по связанным заявкам. На первом этапе письма уходят в
sandbox-инбокс mailtrap.io: наружу не доставляется ничего, писать можно на любые адреса, включая
вымышленные из seed-данных.

## 1. Что в портале уже есть и переиспользуется

| Есть                                                           | Как используется                                        |
| -------------------------------------------------------------- | ------------------------------------------------------- |
| `jobs` + `apps/worker/src/index.ts` (outbox, §16)               | доставка писем — фоновая задача `send_email`             |
| `enqueueJob()` в `apps/api/src/lib/jobs.ts`                     | постановка писем в очередь                               |
| `randomToken()` / `sha256hex()` в `apps/api/src/lib/crypto.ts`  | одноразовые токены в письмах хранятся только хешами      |
| `issueCaptcha()` / `verifyCaptcha()` (ADR 0034)                 | защита публичных форм «подтвердить» и «забыли пароль»    |
| `mustChangePassword` + `revokeAllForUser()`                     | автогенерируемый пароль требует смены при первом входе   |
| `passwordSchema`, `passwordWeakness()` (`contracts/password.ts`) | генератор пароля проверяется той же политикой           |
| `MAIL_ENABLED`, `SMTP_*`, `MAIL_FROM` в `.env.example`          | переменные уже зарезервированы, добавляется разбор в конфиг |
| `writeAudit()`                                                  | новые события аудита по той же схеме                    |

Ничего из перечисленного менять не нужно — кроме `enqueueJob()`, которому добавляется необязательный
`tx` (см. п. 2).

## 2. Архитектура доставки

```
API (обработчик)                     БД                          worker
─────────────────────────────────────────────────────────────────────────────────
рендер письма  ──►  INSERT mail_messages  ─┐
                     (в той же транзакции) │ INSERT jobs('send_email')
                                           ┘
                                                          ──►  claim job
                                                               SMTP → Mailtrap
                                                               UPDATE mail_messages
                                                                 status='sent'
```

Решения, которые стоит зафиксировать в ADR:

1. **Письма идут через `jobs`, а не отправляются в обработчике запроса.** Обработчик, который ждёт
   SMTP, отдаёт заявку на полсекунды дольше и падает вместе с чужим сервисом. Outbox в портале уже
   есть, и повторы с backoff'ом в нём написаны.

2. **Отдельная таблица `mail_messages`, а не тело письма в `jobs.payload`.** Нужен журнал «что и кому
   ушло» — при разборе «мне не пришло письмо» иначе нечего смотреть, а `jobs` после `status='done'`
   отвечает только «задача выполнена». Плюс идемпотентность: `UNIQUE (kind, dedupe_key)` не даёт
   отправить второе письмо об одном и том же событии при повторе задачи.

3. **Рендер — в API на момент постановки в очередь, worker получает готовые `subject`/`body`.**
   Worker остаётся с тремя зависимостями (`pg`, `pino`, транспорт) и ничего не знает ни о правах, ни
   о заявках. Следствие принято сознательно: правка шаблона не меняет уже поставленные в очередь
   письма.

4. **Транспорт за интерфейсом с тремя реализациями.**
   `MailTransport.send(msg) → { messageId }`:
   - `log` — пишет письмо в pino (локальная разработка без Mailtrap; поведение по умолчанию, когда
     `MAIL_ENABLED=false`);
   - `smtp` — nodemailer; один и тот же код для Mailtrap sandbox и для прод-Yandex Postbox, переход
     между ними — только смена `SMTP_*`;
   - `mailtrapApi` — POST на `https://sandbox.api.mailtrap.io/api/send/{inbox_id}` с заголовком
     `Api-Token`; ~30 строк на `fetch`, запасной путь, если на VPS закрыты исходящие SMTP-порты.

   Первым этапом делаются `log` и `smtp`.

5. **Постановка письма — внутри транзакции бизнес-операции.** `enqueueJob()` получает
   `opts.tx?: Tx`. Иначе возможны обе беды: письмо «заявка переведена в работу» при откате
   транзакции и молчание при падении между commit и enqueue. Аудит остаётся как есть (пишется после
   commit и глушит свои ошибки) — у него другая цена ошибки.

6. **Ссылки в письмах открывают страницу портала, а действие выполняет POST с этой страницы.**
   Почтовые сканеры и превью в мессенджерах дёргают ссылки из письма сами. GET, который
   подтверждает адрес, — терпимо; GET, который сбрасывает пароль, — это пароль, сброшенный без
   участия человека. Поэтому `/verify-email?token=…` и `/reset-password?token=…` — страницы с
   кнопкой, дальше `POST /api/v1/auth/…`.

7. **Токены в письмах хранятся хешами** (`sha256hex`, как `refresh_sessions.token_hash`),
   одноразовые (`used_at`), с TTL: сутки на подтверждение адреса, час на сброс пароля.

8. **Ответы публичных форм нейтральны.** «Если адрес зарегистрирован, письмо отправлено» — иначе
   `/forgot-password` превращается в справочник «есть ли такой человек в портале», ровно та же
   причина, по которой капча в `/register` проверяется до проверки занятости email.

## 3. Схема БД

Миграция `0062_mail_outbox.sql`:

```sql
CREATE TYPE mail_status AS ENUM ('pending', 'sent', 'failed');

CREATE TABLE mail_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL,               -- 'verify_email', 'password_reset', 'request.status_changed', …
  dedupe_key    text NOT NULL,               -- см. п. 2.2
  to_email      citext NOT NULL,
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  entity_type   text,                        -- 'waste_request' | 'vehicle_request' | 'user'
  entity_id     text,
  subject       text NOT NULL,
  body_text     text NOT NULL,
  body_html     text NOT NULL DEFAULT '',
  status        mail_status NOT NULL DEFAULT 'pending',
  provider_id   text,                        -- message-id транспорта, для сверки с кабинетом
  last_error    text,
  sent_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX mail_messages_dedupe_unique ON mail_messages (kind, dedupe_key);
CREATE INDEX mail_messages_user_idx   ON mail_messages (user_id, created_at DESC);
CREATE INDEX mail_messages_entity_idx ON mail_messages (entity_type, entity_id, created_at DESC);
CREATE INDEX mail_messages_status_idx ON mail_messages (status) WHERE status <> 'sent';
```

Миграция `0063_email_verification.sql`:

```sql
ALTER TABLE users ADD COLUMN email_verified_at timestamptz;
-- Действующие учётки не должны в одну ночь стать «неподтверждёнными»: они уже активированы
-- администратором, и адрес у них проверен вручную.
UPDATE users SET email_verified_at = now() WHERE is_active = true;

CREATE TYPE user_email_token_purpose AS ENUM ('verify_email', 'password_reset');

CREATE TABLE user_email_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     user_email_token_purpose NOT NULL,
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX user_email_tokens_hash_unique ON user_email_tokens (token_hash);
-- «Есть ли живой токен этого назначения» — главный вопрос к таблице (троттлинг и повторная отправка).
CREATE INDEX user_email_tokens_live_idx ON user_email_tokens (user_id, purpose, created_at DESC)
  WHERE used_at IS NULL;

-- Заявки на регистрацию без подтверждённого адреса: их выметает фоновая уборка (п. 5).
CREATE INDEX users_unverified_pending_idx ON users (created_at)
  WHERE deleted_at IS NULL AND is_active = false AND role IS NULL AND email_verified_at IS NULL;
```

Отражение в `apps/api/src/db/schema.ts` (drizzle) — теми же приёмами, что у соседних таблиц:
partial-индексы через `.where(sql\`…\`)`, enum через `pgEnum`.

Перед созданием файлов проверить оба потока нумерации: `ls apps/api/drizzle | tail -3` и
`ls docs/adr | tail -3`.

## 4. Этап 0 — транспорт и тестовая отправка

Новые файлы:

- `apps/api/src/services/mail.ts` — `queueMail({ kind, dedupeKey, to, userId, entity, subject, text, html }, tx?)`:
  `INSERT … ON CONFLICT (kind, dedupe_key) DO NOTHING` + `enqueueJob('send_email', { mailMessageId }, { tx })`.
  При `MAIL_ENABLED=false` письмо всё равно записывается — доставку решает worker, а не бизнес-код.
- `apps/api/src/services/mail-templates.ts` — рендер: `subject`, `text` (основной) и минимальный
  `html`. Русский язык, ссылки от `PUBLIC_ORIGIN`, без внешних картинок и трекеров.
- `apps/worker/src/mail-transport.ts` — интерфейс + реализации `log` / `smtp` (+ `mailtrapApi` при
  необходимости).
- `apps/worker/src/index.ts` — обработчик `send_email`: читает `mail_messages`, отправляет,
  `status='sent'` + `provider_id`; на ошибке отдаёт исключение в общий backoff, а исчерпав попытки
  (`jobs.status='dead'`) помечает письмо `failed` с `last_error`.
- `apps/api/src/scripts/send-test-mail.ts` + скрипт `mail:test` в `apps/api/package.json` — разовая
  отправка на заданный адрес для проверки конфигурации.

Правки конфига (`apps/api/src/config.ts`): в `rawSchema` добавить `MAIL_TRANSPORT`
(`'log' | 'smtp' | 'mailtrapApi'`, по умолчанию `log`), `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
`SMTP_PASSWORD`, `MAIL_FROM`, `MAILTRAP_INBOX_ID`, `MAIL_VERIFY_TTL_SECONDS` (86400),
`MAIL_RESET_TTL_SECONDS` (3600), `MAIL_REGISTRATION_EXPIRY_DAYS` (7). Startup check: при
`MAIL_ENABLED=true` и `MAIL_TRANSPORT=smtp` обязательны `SMTP_HOST`/`SMTP_USER`/`SMTP_PASSWORD`/`MAIL_FROM`
— иначе сервис поднимется и будет молча копить `pending`. `SMTP_PASSWORD` добавить в `SECRET_KEYS`
(проверка на `CHANGE_ME` в проде). Worker читает `process.env` напрямую, как остальные свои
переменные; в compose ничего не меняется — `technic-api` и `technic-worker` уже делят один `env_file`.

Зависимость: `nodemailer` (+ `@types/nodemailer`) в `apps/worker`. В API она не нужна.

Проверка этапа: `pnpm --filter @technic/api mail:test -- --to test@example.com` → письмо видно в
инбоксе Mailtrap, `mail_messages.status='sent'`, `provider_id` заполнен.

## 5. Этап 1 — верификация почты при регистрации

Решение: **неподтверждённый адрес блокирует активацию учётки администратором**, плюс автоотказ по
таймауту. Причина: и оповещения, и восстановление доступа опираются на то, что адрес рабочий; учётка
с недоставляемым адресом ломает оба сценария молча.

Изменения:

1. `POST /api/v1/auth/register` (`routes/auth.ts`) — в той же транзакции, что вставка `users`:
   токен `verify_email` + `queueMail`. Ответ меняется по тексту: «Мы отправили письмо на <email>.
   Подтвердите адрес, после этого заявку рассмотрит администратор». Занятость email по-прежнему не
   раскрывается — 409 остаётся, он и сейчас за капчей.
2. `POST /api/v1/auth/verify-email` `{ token }` — помечает `used_at`, ставит `email_verified_at`,
   пишет аудит `user.email_verified`. Просроченный/использованный токен → 400 с текстом «Ссылка
   недействительна или устарела» и предложением выслать письмо заново.
3. `POST /api/v1/auth/verify-email/resend` `{ email, captchaToken, captchaAnswer }` — нейтральный
   202. Троттлинг: не чаще одного письма в 5 минут на учётку (по `user_email_tokens`), rate limit
   5/10 мин на адрес запроса.
4. `PATCH /api/v1/users/:id` (`routes/users.ts`) — активация (`isActive: true`) при
   `email_verified_at IS NULL` → 400 «Пользователь не подтвердил адрес почты». Отдельная кнопка
   «Отправить письмо повторно» в карточке — тот же сервис, но от лица администратора и без капчи.
   Полезное следствие: администратор может подтвердить адрес вручную, если человек не может получить
   письмо (право `users.manage`, аудит `user.email_verified_manually`).
5. Уборка в worker'е — рядом с `cleanupOrphanUploads()`, тем же расписанием: заявки на регистрацию
   старше `MAIL_REGISTRATION_EXPIRY_DAYS` без подтверждения удаляются **физически** (`DELETE`), а не
   soft delete. Причина: `users_email_unique` — безусловный уникальный индекс, и soft-deleted строка
   навсегда занимает адрес — человек, не увидевший письмо, больше никогда не зарегистрируется.
   Внешних ссылок на такую учётку нет: `refresh_sessions` уходит каскадом,
   `audit_log.actor_user_id` — `SET NULL`, поэтому перед удалением пишется
   `user.registration_expired` с `metadata.email` (тем же приёмом, что `user.reject_registration`).
   Порог намеренно больше TTL токена: сутки на письмо, семь — на попытки.
6. `MAIL_ENABLED=false` (локальная разработка) — правило «без подтверждения не активировать» не
   действует, регистрация ведёт себя как сейчас. Иначе портал без почты становится неработоспособным.

Веб:

- `apps/web/src/pages/VerifyEmailPage.tsx` + маршрут `/verify-email` в `App.tsx` (публичный): читает
  `token` из query, кнопка «Подтвердить адрес», состояния успех / просрочено / уже подтверждён, из
  каждого — путь дальше.
- `RegisterPage.tsx` — текст успешной регистрации и подсказка «письмо не пришло → выслать повторно».
- `LoginPage.tsx` — обработка отказа «адрес не подтверждён» с кнопкой повторной отправки.
- `pages/admin/UsersTab.tsx` — бейдж «Почта подтверждена / Не подтверждена» в списке заявок на
  регистрацию, блокировка активации, кнопки «Выслать письмо» и «Подтвердить вручную».
- `apps/web/src/api/resources.ts` — новые вызовы.

## 6. Этап 2 — восстановление доступа

Сценарий (как заказано): запрос по почте → письмо со ссылкой → подтверждение → пароль
перегенерируется → второе письмо с новым паролем.

- `POST /api/v1/auth/password-reset/request` `{ email, captchaToken, captchaAnswer }` → 202,
  нейтрально. Токен `password_reset`, TTL час. Не выдаётся для удалённых и неактивных учёток (письмо
  просто не отправляется — ответ тот же). Rate limit 3/10 мин на адрес запроса + 1 письмо в 5 минут
  на учётку. Аудит `auth.password_reset_requested`.
- `POST /api/v1/auth/password-reset/confirm` `{ token }` → 200 «Новый пароль отправлен на почту».
  В одной транзакции: `used_at`, новый `passwordHash`, `mustChangePassword=true`,
  `authVersion + 1`, `queueMail('password_reset_done')`; после commit — `revokeAllForUser()`.
  Аудит `auth.password_reset_completed`. Все живые токены `password_reset` этой учётки гасятся —
  иначе вторая ссылка из старого письма сбрасывает пароль ещё раз.
- `apps/api/src/auth/password-generator.ts` — 14 символов из алфавита без похожих знаков
  (`0/O`, `1/l/I`), `randomInt` из `node:crypto`; результат проверяется `passwordWeakness()` и
  `passwordContainsIdentity()` против email и ФИО и перегенерируется при отказе. Пароль нигде не
  логируется и не попадает в аудит — только в тело письма.
- Веб: `ForgotPasswordPage.tsx` (`/forgot-password`, email + капча), `ResetPasswordPage.tsx`
  (`/reset-password`, кнопка «Сбросить пароль и получить новый на почту»), ссылка «Забыли пароль?» на
  `LoginPage`. После входа с `mustChangePassword` человек и сейчас попадает на `/change-password` —
  этот путь уже работает.

**Оговорка по безопасности.** Пароль в письме — это пароль, оставшийся в почтовом ящике навсегда:
он читается любым, кто получит доступ к ящику, и попадает в бэкапы почты. Ослабляют это
`mustChangePassword=true`, одноразовый токен на час, отзыв всех сессий и явный текст в письме
«смените при первом входе». Отраслевой стандарт — ссылка на форму, где человек задаёт пароль сам, и
портал вообще не пересылает секретов по почте; переход на эту схему — правка одного обработчика и
одной страницы, если решишь. Реализуется заказанный вариант, альтернатива фиксируется в ADR.

## 7. Этап 3 — оповещения по связанным заявкам

События (первый этап):

| Событие                      | Модуль        | Точка в коде                                              |
| ---------------------------- | ------------- | --------------------------------------------------------- |
| смена статуса                | вывоз, ТС     | `PATCH /:id/status` — `waste-requests.ts`, `vehicle-requests.ts` |
| назначен оператор вывоза     | вывоз         | `PATCH /:id/operator` — `waste-requests.ts`               |
| назначена техника            | ТС            | `PATCH /:id/status` (перевод в работу, ADR 0027)           |
| заявка ждёт визы             | ТС            | `POST /` — заявка создана без визы (ADR 0025, 0032)       |
| виза поставлена / снята      | ТС            | `PATCH /:id/approval`                                     |

Получатели — **все связанные с заявкой**, строго в границах видимости: автор заявки, руководитель
строительства объекта, активные учётки назначенного исполнителя (оператор вывоза или арендодатель
назначенной машины). Инициатор действия исключается: он только что сделал это сам.

Ключевое решение: `apps/api/src/services/notification-recipients.ts` **выводит получателей из тех же
предикатов, что `lib/access.ts`** (`requestVisibilityWhere`, `operatorVisibilityWhere`,
`lessorVisibilityWhere`). Второй, независимо написанный список ролей — это утечка: список видимости и
список рассылки разойдутся при первой правке прав, и письмо уйдёт тому, кто заявку открыть не может.
Тело письма при этом минимально — номер заявки, объект, что произошло, ссылка на карточку; детали
остаются за входом в портал.

- `apps/api/src/services/request-notifications.ts` — `notifyRequestEvent({ module, requestId, kind, actorId, … }, tx)`:
  собирает получателей, рендерит, ставит письма. `dedupe_key` = `${requestId}:${historyId ?? version}:${userId}`,
  поэтому повтор задачи или двойной клик дубля не породят.
- Вызовы — внутри существующих `db.transaction(...)` перечисленных обработчиков, рядом с вставкой в
  `requestStatusHistory` / `vehicleRequestStatusHistory`.
- Учётки без подтверждённого адреса и деактивированные в рассылку не попадают.
- Глобальный выключатель — `MAIL_ENABLED`. Персональной отписки на первом этапе нет (см. п. 11).

## 8. Env-переменные

```
# ── Почта ──
MAIL_ENABLED=true
# log | smtp | mailtrapApi
MAIL_TRANSPORT=smtp
MAIL_FROM="Портал Техник <no-reply@auto.su10.ru>"
# Mailtrap sandbox: креды инбокса из кабинета (Integrations → SMTP)
SMTP_HOST=sandbox.smtp.mailtrap.io
SMTP_PORT=2525
SMTP_USER=
SMTP_PASSWORD=
# только для MAIL_TRANSPORT=mailtrapApi
MAILTRAP_INBOX_ID=
MAIL_VERIFY_TTL_SECONDS=86400
MAIL_RESET_TTL_SECONDS=3600
MAIL_REGISTRATION_EXPIRY_DAYS=7
```

Порт `2525` выбран потому, что `25`/`587` часто закрыты на исходящих у хостеров; если и он не
проходит — `MAIL_TRANSPORT=mailtrapApi` (обычный HTTPS). Секреты — только в
`/etc/technic-portal/prod.env` и локальном `.env`; в `.env.example` значения пустые. Обновить
`docs/setup-infra.md` (раздел с почтой) и `docs/runbook.md` (диагностика: `mail_messages` со
статусом `failed`, `jobs` в `dead` с типом `send_email`).

## 9. Тесты

Существующие, которые обязательно правятся:

- `apps/api/test/route-authorization.test.ts` — новые публичные маршруты (`/auth/verify-email`,
  `/auth/verify-email/resend`, `/auth/password-reset/request`, `/auth/password-reset/confirm`)
  добавить в `PUBLIC_ROUTES`, иначе страж авторизации красный.
- `apps/web/test/register-form.test.tsx` — изменившийся текст успеха.

Новые:

- `apps/api/test/mail-outbox.test.ts` — `queueMail` идемпотентен по `(kind, dedupe_key)`;
  рендер шаблонов (ссылка от `PUBLIC_ORIGIN`, токен только в ссылке, никакого пароля в `subject`).
- `apps/api/test/email-verification.test.ts` — токен одноразовый, просроченный отклоняется, чужой
  токен не подтверждает соседнюю учётку, активация без подтверждения → 400.
- `apps/api/test/password-reset.test.ts` — нейтральность ответа для незнакомого адреса, гашение
  прочих токенов, `mustChangePassword` и `authVersion` после сброса, сгенерированный пароль проходит
  `passwordSchema` (прогон 1000 генераций).
- `apps/api/test/notification-recipients.test.ts` — получатели совпадают с областью видимости для
  каждой роли (в том числе: арендодатель не получает письмо о заявке без назначения, объектная роль
  — только о своём объекте), инициатор исключён.

## 10. Порядок работ

Один коммит на этап, каждый — рабочее состояние портала (коммитим в `main` явными путями).

1. `feat(mail): outbox писем и SMTP-транспорт` — миграция `0062`, `mail_messages`, транспорт в
   worker, `mail:test`, env, ADR 0039 (черновик решений 1–8).
2. `feat(auth): верификация адреса при регистрации` — миграция `0063`, эндпоинты, уборка в worker,
   страницы, блокировка активации, тесты.
3. `feat(auth): восстановление доступа по почте` — генератор пароля, два эндпоинта, три страницы,
   тесты.
4. `feat(requests): оповещения по заявкам на почту` — `notification-recipients`,
   `request-notifications`, вызовы в пяти точках, тесты.
5. `docs: почтовый сервис в setup-infra и runbook` — если не разошлось по этапам.

Приёмка на Mailtrap: регистрация → письмо → подтверждение → активация администратором → смена
статуса заявки → письма связанным → «забыли пароль» → вход с автопаролем → принудительная смена.

## 11. Вне объёма первого этапа

- Персональные настройки уведомлений (отписка от отдельных событий) — понадобится колонка настроек
  у `users` и раздел в профиле; сейчас выключатель один и общий.
- Дайджест вместо письма на каждое событие (если рассылка окажется шумной).
- Прод-доставка через Yandex Postbox: домен, SPF/DKIM/DMARC, разогрев. Кода не касается — только
  `SMTP_*` и DNS.
- Обработка bounce/complaint (отметка «адрес недоставляем» у учётки).
- Экран журнала писем для администратора: данные для него `mail_messages` уже несёт.

## 12. Что нужно со стороны Mailtrap

1. Креды sandbox-инбокса (`SMTP_USER`/`SMTP_PASSWORD` из карточки инбокса) либо его `inbox_id` — для
   HTTP-варианта. API-токен из чата к sandbox-инбоксу сам по себе не привязан: он адресует аккаунт, а
   не инбокс.
2. Токен, присланный в переписке, стоит считать одноразовым и перевыпустить после тестового этапа —
   он попал в историю чата. В git он не попадает ни в каком виде.
