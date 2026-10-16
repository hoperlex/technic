-- Receipt-backed creation must not be announced as working in the broken df2c910e build: that
-- build reached users without its table. Migration 0384 runs before this entry and before the
-- matching API starts. Record the Moscow calendar date of that actual rollout, not the date on
-- which the broken code first appeared (ADR 0077, ADR 0231).
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 134;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  134, '0.1.123.0231', (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow')::date,
  'Заявки: повтор отправки больше не создаёт дубль', '{231}',
  '[
    {"kind":"fix","text":"В новых формах заказа техники, вывоза мусора, механизации и обслуживания оргтехники повтор одной отправки после потери ответа не создаёт вторую заявку, повторных файлов и писем"},
    {"kind":"feature","text":"Если результат отправки неизвестен, форма сохраняет исходные данные и показывает «Проверить создание». Проверка сообщает, создана ли заявка, прежде чем разрешить новую попытку"},
    {"kind":"improvement","text":"Пока исход не подтверждён, повтор использует те же данные, даже если поля формы уже изменены. После подтверждения, что заявка не создана, можно исправить поля и отправить новую попытку"},
    {"kind":"fix","text":"Команда «Дублировать» в механизации тоже сохраняет ключ попытки: потерянный ответ можно проверить и повторить без второй копии, а следующую копию создаёт только отдельная подтверждённая команда"},
    {"kind":"fix","text":"Повтор той же отправки после полуночи по Москве остаётся повтором исходной заявки, а не новым созданием"}
  ]'::jsonb
);
