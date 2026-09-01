-- Переоформление листов ЭСМ-2 переходной недели — миграцией (ADR 0151, уточняет ADR 0149 §3).
--
-- ПОЧЕМУ ЭТО ЗДЕСЬ, А НЕ В ПРОГОНЕ. ADR 0149 §2 поручил разовую работу шагу `deploy-auto`, и шаг
-- этот стоит внутри ветки «есть неприменённые миграции» (`elif [ "$PENDING" -eq 1 ]`). Миграции,
-- накатанные не выкатом, ветку закрывают навсегда: `PENDING=0`, шаг не зовётся, а журнал выпусков
-- уже отрапортовал о переоформлении (выпуск 68). Прод остался с листами «31.08–06.09» одним
-- документом при записи о том, что их нет. Работа по данным обязана ехать тем же путём, что и
-- схема, — иначе она едет мимо.
--
-- ЧТО СНИМАЕТ ВОЗРАЖЕНИЕ ADR 0149 §3 («второй механизм расхода номеров»). Счётчик серии — не код,
-- а строка `waybill_series.next_number` (`takeNextNumber`), и здесь берётся та же строка тем же
-- порядком: `UPDATE ... RETURNING` под блокировкой. Снимок граф не сочиняется заново, а копируется
-- с переоформляемого листа — меняются ровно те ключи, которые зависят от периода и номера:
-- `waybill_number`, `waybill_date*`, `period_*` и семь `dayN_date` (ADR 0142: число печатается
-- только у своего дня). Всё прочее в бланке — организация, машина, машинист, объект — у половин
-- недели то же самое, и пересобирать его значило бы напечатать сегодняшние справочники в
-- документе, выписанном на прошлой неделе.
--
-- ТРИ ГРАНИЦЫ ADR 0149 §4 остаются, и проверяются они до первой правки:
--   1. `period_to >= сегодня` — отработанную неделю не трогаем ни при какой дате: работа
--      состоялась, заказчик заполнил оборот. После 06.09.2026 отбор пуст, и миграция — пустышка;
--   2. горит только сам двухмесячный лист, поимённо, и ничего рядом;
--   3. если неделю уже закрывает другой действующий лист (сосед успел выписаться дверью портала),
--      заявка пропускается целиком — наполовину не переоформляем.
--
-- ПОРЯДОК БЛОКИРОВОК — КАК У ДВЕРЕЙ ПОРТАЛА, и это не педантизм: миграции накатываются, пока
-- старые контейнеры ещё обслуживают трафик (`deploy-auto` поднимает сервисы после), то есть
-- сверка ЭСМ-2 может идти параллельно. Сначала строка заявки, затем лист, и только потом счётчик
-- серии — встречный порядок дал бы взаимную блокировку, а её здесь стоимость — упавший выкат.
--
-- ЧТО ОСТАЁТСЯ В ЖУРНАЛЕ. Строка `waybill_corrections` вида `esm2` на каждый переоформленный лист:
-- причина, автор (тот, кто выписал заменяемый бланк) и связь «какой номер что заменил»
-- (`corrects_waybill_id` + `cancel_correction_id`). Заводится она всегда, а не только у бумаги
-- задним числом, как в прогоне: у миграции нет ни человека, ни двери, и исчезнувший номер строгой
-- отчётности объясняется только ею. Плюс событие `waybill.esm2_sync` по каждому заказу — с
-- пометкой `source`, чтобы через месяцы было видно: это переоформление выката, а не решение
-- диспетчера.

DO $esm2_split$
DECLARE
  v_reason  constant text := 'Разрез листа ЭСМ-2 границей месяца (ADR 0142)';
  -- День по Москве, а не `CURRENT_DATE`: контейнер выката живёт в UTC, и деплой в первом часу ночи
  -- считал бы границу отработанной недели вчерашним днём.
  v_today   date := (now() AT TIME ZONE 'Europe/Moscow')::date;
  v_series  record;
  v_stale   record;
  v_id      uuid;
  v_req     uuid;
  v_cut     date;
  v_base    bigint;
  v_corr    uuid;
  v_done    integer := 0;
  v_skipped integer := 0;
BEGIN
  -- Префикс и ширина номера — реквизиты серии, они не меняются; сам счётчик берётся ниже, под
  -- блокировкой и в свой момент.
  SELECT s.id, s.prefix, s.number_width INTO v_series
    FROM waybill_series s WHERE s.code = 'esm2';
  IF NOT FOUND THEN
    RAISE NOTICE 'ЭСМ-2: серия не заведена — переоформлять нечем';
    RETURN;
  END IF;

  FOR v_id IN
    SELECT w.id
      FROM waybills w
     WHERE w.form_code = 'esm2'
       AND w.status <> 'cancelled'
       AND w.period_from IS NOT NULL
       AND w.period_to IS NOT NULL
       -- Месяц сравнивается усечением даты, а не текстом: `date::text` зависит от `DateStyle`
       -- сессии, и на площадке с другим стилем условие сравнивало бы дни с годами.
       AND date_trunc('month', w.period_from) <> date_trunc('month', w.period_to)
       AND w.period_to >= v_today
     ORDER BY w.period_from, w.id
  LOOP
    SELECT w.source_request_id INTO v_req FROM waybills w WHERE w.id = v_id;
    CONTINUE WHEN v_req IS NULL;

    -- Строка заявки первой — тем же порядком, каким её берут все двери к бумаге.
    PERFORM 1 FROM vehicle_requests r WHERE r.id = v_req FOR UPDATE;

    -- Лист перечитывается под блокировкой и с теми же условиями: между отбором и правкой его мог
    -- тронуть работающий портал, и решение обязано опираться на то состояние, которое сейчас правят.
    SELECT w.* INTO v_stale
      FROM waybills w
     WHERE w.id = v_id
       AND w.status <> 'cancelled'
       AND date_trunc('month', w.period_from) <> date_trunc('month', w.period_to)
       AND w.period_to >= v_today
       FOR UPDATE;
    IF NOT FOUND THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    v_cut := (date_trunc('month', v_stale.period_from) + interval '1 month' - interval '1 day')::date;

    -- Граница 3: половину недели уже закрывает другой действующий лист. Такую заявку смотрит
    -- человек — иначе выписка упёрлась бы в `waybills_source_request_period_unique` и уронила выкат.
    IF EXISTS (
      SELECT 1 FROM waybills o
       WHERE o.source_request_id = v_req
         AND o.vehicle_id = v_stale.vehicle_id
         AND o.status <> 'cancelled'
         AND o.id <> v_stale.id
         AND o.period_from IN (v_stale.period_from, v_cut + 1)
    ) THEN
      RAISE NOTICE 'ЭСМ-2: лист % (% — %) пропущен: половину недели закрывает другой действующий лист',
        v_series.prefix || lpad(v_stale.number::text, v_series.number_width, '0'),
        v_stale.period_from, v_stale.period_to;
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    -- Два номера подряд из той же строки счётчика, что тратит и портал.
    UPDATE waybill_series SET next_number = next_number + 2, updated_at = now()
     WHERE id = v_series.id
     RETURNING next_number - 2 INTO v_base;

    -- Операция журнала — до бумаги: на неё ссылаются оба конца замены.
    INSERT INTO waybill_corrections (operation_id, fingerprint, kind, reason, actor_user_id)
    VALUES (gen_random_uuid(), 'esm2:month-split:0236:' || v_stale.id::text, 'esm2',
            v_reason, v_stale.issued_by)
    RETURNING id INTO v_corr;

    INSERT INTO vehicle_request_corrections (correction_id, request_id)
    VALUES (v_corr, v_req)
    ON CONFLICT DO NOTHING;

    -- Сначала гасим: «одна неделя — один действующий лист» держит частичный уникальный индекс, и
    -- выписка поверх непогашенного номера упала бы на нём.
    UPDATE waybills
       SET status = 'cancelled',
           cancelled_at = now(),
           cancelled_by = v_stale.issued_by,
           cancel_reason = v_reason,
           cancel_correction_id = v_corr,
           updated_at = now()
     WHERE id = v_stale.id;

    INSERT INTO waybills (
      series_id, number, form_code, status, organization_id, vehicle_id, driver_person_id,
      issued_for_date, route_id, source_request_id, period_from, period_to,
      with_trailer, trailer1_model, trailer1_reg_number, trailer2_model, trailer2_reg_number,
      garage_number, communication_kind, transportation_kind, data,
      issued_by, issued_at, issue_warnings, correction_id, correction_reason, corrects_waybill_id)
    SELECT
      v_series.id,
      v_base + half.ord,
      'esm2',
      'issued',
      v_stale.organization_id,
      v_stale.vehicle_id,
      v_stale.driver_person_id,
      -- Дата листа у ЭСМ-2 — первый рабочий день его периода (ADR 0037 п. 9).
      half.p_from,
      NULL,
      v_req,
      half.p_from,
      half.p_to,
      v_stale.with_trailer,
      v_stale.trailer1_model, v_stale.trailer1_reg_number,
      v_stale.trailer2_model, v_stale.trailer2_reg_number,
      v_stale.garage_number, v_stale.communication_kind, v_stale.transportation_kind,
      -- Снимок: копия граф переоформляемого листа поверх которой встают только зависящие от
      -- номера и периода. Пересобирать его из справочников нельзя — они живут своей жизнью, а
      -- выданный бланк печатается тем, чем был выписан (ADR 0037 п. 10).
      v_stale.data
        || jsonb_build_object(
             'waybill_number',
               v_series.prefix || lpad((v_base + half.ord)::text, v_series.number_width, '0'),
             'waybill_date',      to_char(half.p_from, 'DD.MM.YYYY'),
             'waybill_date_dd',   to_char(half.p_from, 'DD'),
             'waybill_date_mm',   to_char(half.p_from, 'MM'),
             'waybill_date_yyyy', to_char(half.p_from, 'YYYY'),
             'period_from_day',   to_char(half.p_from, 'DD'),
             'period_to_day',     to_char(half.p_to,   'DD'),
             -- Обе границы теперь в одном месяце — в графе «… месяца __» ровно один номер.
             'period_month',      to_char(half.p_from, 'MM'),
             'period_year',       to_char(half.p_from, 'YYYY'))
        -- Семь строк «пн…вс» впечатаны в бланк и никуда не делись, но число печатается только у
        -- своего дня: иначе два листа одной недели получили бы одинаковую сетку чисел, и часы
        -- 1 сентября вписали бы в августовский бланк (ADR 0142).
        || (SELECT jsonb_object_agg(
                     'day' || g || '_date',
                     CASE
                       WHEN date_trunc('week', half.p_from::timestamp)::date + (g - 1)
                            BETWEEN half.p_from AND half.p_to
                       THEN to_char(date_trunc('week', half.p_from::timestamp)::date + (g - 1), 'DD')
                       ELSE ''
                     END)
              FROM generate_series(1, 7) AS g),
      v_stale.issued_by,
      now(),
      -- Под какими предупреждениями выдан лист — с заменяемого: половины недели те же дни той же
      -- машины и того же машиниста, а пересчитывать годность документов в SQL значило бы завести
      -- второй ответ на вопрос, у которого уже есть первый.
      v_stale.issue_warnings,
      v_corr,
      v_reason,
      -- Связь «заменил» одна на номер (`waybills_corrects_unique`), и берёт её первая половина —
      -- та, что унаследовала день начала документа. Тем же правилом её раздаёт `esm2ScopedPlan`.
      CASE WHEN half.ord = 0 THEN v_stale.id ELSE NULL END
    FROM (VALUES
            (0, v_stale.period_from, v_cut),
            (1, v_cut + 1,           v_stale.period_to)
         ) AS half(ord, p_from, p_to);

    -- Талон заказчика: им карточка заявки и журнал находят свои листы.
    INSERT INTO waybill_requests (waybill_id, request_id, slot)
    SELECT w.id, v_req, 1 FROM waybills w WHERE w.correction_id = v_corr;

    -- Множество листов заявки изменилось — значит изменилась и отменяемость её бумаги внутри дня.
    UPDATE vehicle_requests
       SET assignment_history_dirty = true
     WHERE id = v_req AND assignment_history_dirty = false;

    -- Строгое событие сверки: исчезнувший и появившиеся номера обязаны быть названы. `source`
    -- отличает переоформление выката от решения человека — у события, писанного миграцией, автора
    -- в обычном смысле нет, и выдавать его за диспетчера нельзя.
    INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, metadata)
    SELECT v_stale.issued_by, 'waybill.esm2_sync', 'vehicle_request', v_req::text,
           jsonb_build_object(
             'reason', v_reason,
             'cancelled', jsonb_build_array(
               v_series.prefix || lpad(v_stale.number::text, v_series.number_width, '0')),
             'issued', (SELECT jsonb_agg(
                                 v_series.prefix
                                 || lpad(w.number::text, v_series.number_width, '0')
                                 ORDER BY w.period_from)
                          FROM waybills w WHERE w.correction_id = v_corr),
             'scope', jsonb_build_array(jsonb_build_object(
               'from', v_stale.period_from, 'to', v_stale.period_to)),
             'operationId', v_corr,
             'source', 'migration 0236');

    v_done := v_done + 1;
    RAISE NOTICE 'ЭСМ-2: лист % (% — %) переоформлен парой % и %',
      v_series.prefix || lpad(v_stale.number::text, v_series.number_width, '0'),
      v_stale.period_from, v_stale.period_to,
      v_series.prefix || lpad(v_base::text, v_series.number_width, '0'),
      v_series.prefix || lpad((v_base + 1)::text, v_series.number_width, '0');
  END LOOP;

  RAISE NOTICE 'ЭСМ-2: переоформлено листов %, пропущено %', v_done, v_skipped;
END
$esm2_split$;

-- Запись журнала обновлений (ADR 0077): выпуск 70.
--
-- Выпуск 68 (`0234`) об этом уже объявлял — и объявил напрасно: работа не прошла, а пункт остался
-- в журнале. Умолчать сейчас нельзя вдвойне: номера меняются только теперь, и человек, сверивший
-- прошлый пункт с бумагой и не нашедший разреза, обязан прочитать, что произошло на самом деле.
INSERT INTO app_releases (seq, version, released_on, title, adrs, items) VALUES (
  70, '0.1.61.0151', '2026-09-01', 'Путевые листы переходной недели переоформлены — на этот раз в самом деле', '{151}',
  '[
    {"kind":"fix","text":"Заказы, заведённые до разделения путевых листов по месяцам, получили правильную бумагу на текущую неделю: лист «31 августа — 6 сентября» аннулирован, вместо него выписаны два — «31 — 31 августа» и «1 — 6 сентября». В журнале путевых видно, какой номер что заменил и по какой причине. Отработанные листы прошлых недель не тронуты: их переоформляют коррекцией назначения, вручную"},
    {"kind":"fix","text":"Выпуск 68 сообщал об этом же переоформлении, но оно тогда не прошло: работа была поручена шагу выката, который выполняется не при всяком обновлении. Теперь она едет вместе со схемой и повториться не может"}
  ]'::jsonb
);
