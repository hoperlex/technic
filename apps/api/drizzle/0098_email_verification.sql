-- Подтверждение адреса и восстановление пароля по ссылке (ADR 0072).
--
-- До сих пор портал не проверял, что за адресом регистрации стоит живой человек: заявку заводил
-- кто угодно на чей угодно email, а администратор активировал её, доверяя написанному. Отсюда две
-- вещи в этой миграции: отметка подтверждения на учётке и одноразовые токены.
--
-- Токен хранится ТОЛЬКО хешем. Утечка дампа не должна давать вход в портал: по SHA-256 обратно
-- ссылку не собрать, а сам токен живёт лишь в письме и в адресной строке того, кто его получил.
-- Тем же приёмом хранится refresh-сессия.

ALTER TABLE users ADD COLUMN email_verified_at timestamptz;

-- Учётки, которые уже работают, подтверждать задним числом не у кого: адрес им завёл или проверил
-- администратор, назначив роль. Требовать от них подтверждения означало бы выключить портал всем
-- сразу. Заявки, ждущие рассмотрения (role IS NULL), остаются неподтверждёнными — им письмо и
-- уходит; архивных не касаемся вовсе.
UPDATE users SET email_verified_at = now() WHERE deleted_at IS NULL AND role IS NOT NULL;

CREATE TYPE email_token_purpose AS ENUM ('verify_email', 'password_reset');

CREATE TABLE user_email_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose email_token_purpose NOT NULL,
  -- SHA-256 от значения из ссылки; сам токен в базе не появляется никогда.
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  -- Проставляется в момент использования: одноразовость держит УСЛОВИЕ ОБНОВЛЕНИЯ, а не проверка
  -- в коде — два одновременных перехода по одной ссылке иначе оба сочли бы токен живым.
  used_at timestamptz,
  -- С какого адреса запросили: расследование злоупотреблений — единственная причина это хранить.
  requested_ip text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_email_tokens_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT user_email_tokens_expires_after_created CHECK (expires_at > created_at)
);

-- Хеш — ключ поиска: по ссылке из письма сервер считает SHA-256 и ищет строку. Уникальность заодно
-- исключает совпадение токенов.
CREATE UNIQUE INDEX user_email_tokens_hash_unique ON user_email_tokens (token_hash);

-- Живые токены назначения: по ним гасятся старые при выпуске нового и считается троттлинг
-- повторной отправки.
CREATE INDEX user_email_tokens_live_idx ON user_email_tokens (user_id, purpose, created_at DESC)
  WHERE used_at IS NULL;
