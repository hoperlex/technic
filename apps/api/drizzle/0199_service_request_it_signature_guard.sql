-- Виза ИТ по смете: подпись без ревизии больше не записывается. Миграция M10 плана переработки
-- заявок (`docs/office-equipment-requests-rework-plan.md`, §5), выпуск 2 «Contract».
--
-- ЧТО ЗАКРЫВАЕТ. Решение 3 ADR 0133 сделало визу ИТ РЕВИЗИОННОЙ: подписывают не «заявку вообще», а
-- конкретную ревизию сметы, и следующее предъявление сметы подпись обесценивает, не стирая её.
-- Выпуск 1 (`0175`) завёл колонку `it_approved_estimate_revision` и мягкий `CHECK`, где `NULL`
-- означает «виза старого образца, поставленная на входе заявки» — такие строки в базе есть, и
-- трогать их нельзя.
--
-- ПОЧЕМУ ТРИГГЕР, А НЕ `CHECK`. Правило здесь — про ИЗМЕНЕНИЕ, а не про состояние: «подпись,
-- которую записывают ИЛИ меняют после этого выпуска, обязана нести ревизию». `CHECK` видит только
-- итоговую строку и не отличает старую визу от новой; запрети он `NULL` — и накат упёрся бы в
-- исторические строки, разреши — и новую визу старого образца завести можно по-прежнему.
-- Триггер различает их по `TG_OP` и по тому, менялась ли сама подпись.

CREATE FUNCTION service_requests_it_signature_guard() RETURNS trigger AS $$
DECLARE signature_changed boolean;
BEGIN
  signature_changed := TG_OP = 'INSERT'
    OR NEW.it_approved_at IS DISTINCT FROM OLD.it_approved_at
    OR NEW.it_approved_by IS DISTINCT FROM OLD.it_approved_by;

  -- 1. РЕВИЗИЮ НЕЛЬЗЯ ПОДВИНУТЬ В ОДИНОЧКУ.
  --
  -- Самый неочевидный из трёх обходов, и найден он был ревью, а не тестом. Без этой ветки старую
  -- визу можно сделать действующей одним `UPDATE … SET it_approved_estimate_revision =
  -- estimate_revision`: подпись при этом та же самая, ревизия непустая и равна текущей — то есть
  -- все прочие проверки такую строку пропускают, а заявка выглядит согласованной отделом ИТ,
  -- которого никто не спрашивал.
  IF TG_OP = 'UPDATE'
     AND NEW.it_approved_estimate_revision IS DISTINCT FROM OLD.it_approved_estimate_revision
     AND NOT signature_changed THEN
    RAISE EXCEPTION 'Ревизия визы ИТ меняется только вместе с самой подписью';
  END IF;

  IF NEW.it_approved_at IS NOT NULL AND signature_changed THEN
    -- 2. Подпись без ревизии — это и есть «входная виза старого образца». Существующие такие
    --    строки живут дальше, а завести новую после этого выпуска нельзя.
    IF NEW.it_approved_estimate_revision IS NULL THEN
      RAISE EXCEPTION 'Виза ИТ записывается только вместе с ревизией сметы';
    END IF;
    -- 3. Подписывают ТЕКУЩУЮ смету, а не любую прошлую. Равенство, а не «не больше»: ослабнет оно
    --    до `<=` — и подпись встанет на позапрошлую ревизию, оставив нынешнюю несогласованной, а
    --    предикат «виза на текущей ревизии» ответит «да».
    IF NEW.it_approved_estimate_revision <> NEW.estimate_revision THEN
      RAISE EXCEPTION 'Виза ИТ ставится на текущую ревизию сметы';
    END IF;
  END IF;

  -- 4. Снятие подписи чистит и ревизию: «ревизия без подписи» не означает ничего. Того же требует
  --    `CHECK` из `0175` — здесь то же правило на пути записи, чтобы отказ пришёл словами, а не
  --    нарушением ограничения.
  IF NEW.it_approved_at IS NULL AND NEW.it_approved_estimate_revision IS NOT NULL THEN
    RAISE EXCEPTION 'Ревизия визы ИТ остаётся без подписи';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

COMMENT ON FUNCTION service_requests_it_signature_guard() IS
  'Барьер записи ревизионной визы ИТ (решение 3 ADR 0133, M10 плана переработки заявок): подпись '
  'без ревизии, ревизия без подписи, ревизия в одиночку и подпись на чужой ревизии.';

CREATE TRIGGER service_requests_it_signature_guard
  BEFORE INSERT OR UPDATE ON service_requests
  FOR EACH ROW EXECUTE FUNCTION service_requests_it_signature_guard();

-- `ENABLE ALWAYS` отдельной командой: в `CREATE TRIGGER` такого слова нет, а обычный триггер на
-- реплике-приёмнике не срабатывает — правило репликации, а не наша осторожность. То же у всех
-- триггеров этого плана (`0178`, `0186`).
ALTER TABLE service_requests ENABLE ALWAYS TRIGGER service_requests_it_signature_guard;
