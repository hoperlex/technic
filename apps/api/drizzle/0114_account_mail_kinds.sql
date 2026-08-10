-- Три новых вида письма по учётным записям (план `docs/registration-reject-mail-plan.md`, ADR 0087):
-- отказ по заявке на регистрацию, одобрение заявки и заведение учётки администратором.
--
-- Значения добавляются отдельной миграцией и в той же транзакции кодом не используются: раннер
-- применяет файл миграции целиком в одной транзакции (`apps/api/src/db/migration-journal.ts:94`),
-- а PostgreSQL не разрешает пользоваться новым значением enum до её фиксации. Тот же приём — в
-- миграциях 0054, 0065, 0103.
--
-- Аддитивная миграция: смысл существующих данных не меняется, протокол выката необратимых
-- миграций (`docs/schema-cutover-protocol.md`) к ней не применяется.
ALTER TYPE mail_kind ADD VALUE IF NOT EXISTS 'registration_rejected';
ALTER TYPE mail_kind ADD VALUE IF NOT EXISTS 'registration_approved';
ALTER TYPE mail_kind ADD VALUE IF NOT EXISTS 'account_created';
