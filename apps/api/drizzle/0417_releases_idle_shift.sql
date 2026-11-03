-- «Не работал»: the driver closes a shift without work, the garage checks it (ADR 0244, release
-- 1B). The schema came with release 1A (0412, 0413); this file is the feed entry alone. The feed
-- date is the Moscow calendar day this migration reaches users (ADR 0077).
-- Rollback of the feed entry: DELETE FROM app_releases WHERE seq = 150;

INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  150, '0.1.139.0244', (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow')::date,
  'Кабинет водителя: отметка «Не работал»', '{244}',
  '[
    {"kind":"feature","text":"У каждой машины в кабинете водителя появился переключатель «Не работал»: если техника в смену не работала — праздник, простой на объекте, ремонт, — водитель включает его и выбирает причину. Числа и время можно не вводить, смена считается переданной. Для причины «Другое» нужно коротко написать, почему не работали"},
    {"kind":"improvement","text":"Гараж принимает «Не работал» как сданную смену: зелёной, если ничто ей не противоречит, и жёлтой с объяснением, если на этот день был рейс, объект подписал часы по заявке или у машины в этот день есть показания другой смены. Такой отчёт принимается по одному, в пакетный приём он не попадает"},
    {"kind":"improvement","text":"Диспетчер может отметить «Не работал» за водителя в форме ввода показаний. В карточке машины появилось число смен «Не работал», а в журнале, выгрузках и книге показаний такая смена подписана причиной"}
  ]'::jsonb
);
