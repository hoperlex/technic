-- Дополнение снимков листов ЭСМ-2, выданных с пустой графой «Машинист» (ADR 0164).
--
-- ЧТО ПРОИЗОШЛО. Графу ФИО в снимок клал `findMachinist`, а он до ADR 0164 требовал у человека
-- действующей на неделю листа специализации `driver`. Машинистом заявки портал ставит любого
-- человека справочника (назначение спрашивает существование карточки, а не допуск), и сверка —
-- та, которой листы рождаются сами, — выписывала такому человеку бланк молча и без фамилии. В
-- журнале путевых имя при этом стоит: список берёт его связью `driver_person_id → persons`.
--
-- ПОЧЕМУ ЭТО ПРАВКА СНИМКА, А НЕ ПЕРЕОФОРМЛЕНИЕ. ADR 0037 п. 10 («лист печатается как выдан»)
-- защищает содержание документа от сегодняшних справочников — и здесь оно не меняется ни на букву:
-- человек у листа тот же самый, его идентификатор в строке не трогается, восстанавливается только
-- то, что этот же снимок обязан был напечатать в день выдачи. Переоформление сожгло бы номер
-- строгой отчётности ради опечатки в собственной бумаге портала — там, где в бланке не меняется
-- ничего, кроме появившейся фамилии.
--
-- ГРАНИЦА — ТА ЖЕ, ЧТО У `0236`: `period_to >= сегодня`. Отработанную неделю не трогаем ни при
-- какой дате: её бланк уже ходил по рукам, заказчик заполнил оборот и, скорее всего, вписал
-- фамилию от руки — правка снимка развела бы повторную печать с экземпляром на руках. Такие листы
-- называются в NOTICE поимённо: их переоформляют коррекцией назначения, вручную и глазами.
--
-- Аннулированные листы не трогаются вовсе: их не печатают, а номер уже погашен.
--
-- ЧТО ЗАПОЛНЯЕТСЯ. `driver_fio` — из карточки человека (`persons.full_name`, считает БД);
-- `driver_short_name` — тем же правилом, каким его пишет портал (`formatNameWithInitials`:
-- «Фамилия И.О.» ровно у трёхсловного имени без точек, иначе имя как есть); `driver_personnel_no`
-- — трудовым отношением на дату листа, тем же односторонним окном, каким его читает выписка. Ключи
-- удостоверения (`driver_license_*`) не восстанавливаются: их выбирает `waybillDocumentOf` —
-- правило про вид документа по должности и годность на дату, которое в SQL пришлось бы написать
-- второй раз и разойтись с первым. Бланк ЭСМ-2 этих граф не содержит (форма Госкомстата), так что
-- на бумаге их отсутствие ничего не меняет.
--
-- УДАЛЁННАЯ КАРТОЧКА ФАМИЛИЮ НЕ ОТНИМАЕТ. `findMachinist` удалённого человека не отдаёт — но это
-- правило о том, кого можно назвать в **новом** листе. Здесь лист уже выдан, человек в нём уже
-- назван, и печатать его без фамилии значит хранить недействительный бланк ради формальности.
--
-- ЧТО ОСТАЁТСЯ В ЖУРНАЛЕ. Строка `audit_log` на каждый дополненный лист: что заполнено, каким
-- значением и чем это вызвано. Автор — тот, кто выписал лист (`issued_by`): у миграции человека
-- нет, а выдавать правку за диспетчера нельзя, поэтому в `metadata` стоит `source`.

DO $esm2_fio$
DECLARE
  v_reason  constant text := 'Восстановление графы «Машинист» в снимке листа (ADR 0164)';
  -- День по Москве, а не `CURRENT_DATE`: контейнер выката живёт в UTC, и деплой в первом часу ночи
  -- считал бы границу отработанной недели вчерашним днём.
  v_today   date := (now() AT TIME ZONE 'Europe/Moscow')::date;
  v_sheet   record;
  v_parts   text[];
  v_short   text;
  v_tab     text;
  v_number  text;
  v_done    integer := 0;
  v_skipped integer := 0;
BEGIN
  FOR v_sheet IN
    SELECT w.id, w.number, w.issued_by, w.issued_for_date, w.period_from, w.period_to,
           w.driver_person_id, s.prefix, s.number_width,
           btrim(p.full_name) AS full_name,
           coalesce(w.data->>'driver_personnel_no', '') AS personnel_no
      FROM waybills w
      JOIN waybill_series s ON s.id = w.series_id
      JOIN persons p ON p.id = w.driver_person_id
     WHERE w.form_code = 'esm2'
       AND w.status = 'issued'
       AND coalesce(w.data->>'driver_fio', '') = ''
     ORDER BY w.issued_for_date, w.number
  LOOP
    v_number := v_sheet.prefix || lpad(v_sheet.number::text, v_sheet.number_width, '0');

    -- Отработанная неделя — мимо: см. границу в шапке. Считаем и называем, чтобы работа руками
    -- была видна тому, кто читает вывод выката, а не обнаруживалась через месяц по жалобе.
    IF v_sheet.period_to < v_today THEN
      v_skipped := v_skipped + 1;
      RAISE NOTICE 'ЭСМ-2: лист % (% — %) отработан — графа «Машинист» (%) не дополняется, нужна коррекция',
        v_number, v_sheet.period_from, v_sheet.period_to, v_sheet.full_name;
      CONTINUE;
    END IF;

    -- Пустого имени в карточке не бывает (`full_name` считает БД из фамилии и имени), но если
    -- строка всё же пуста — дополнять нечем, и молча писать пустоту поверх пустоты незачем.
    IF v_sheet.full_name = '' THEN
      v_skipped := v_skipped + 1;
      RAISE NOTICE 'ЭСМ-2: лист % — у карточки % пустое ФИО, дополнять нечем',
        v_number, v_sheet.driver_person_id;
      CONTINUE;
    END IF;

    -- Расшифровка подписи — тем же правилом, что и в портале (`formatNameWithInitials`): инициалы
    -- ставятся только у трёхсловного имени, все части которого начинаются с буквы и не содержат
    -- точки; иначе имя печатается как есть. Второе правило здесь означало бы, что один и тот же
    -- человек в двух соседних листах подписан по-разному.
    v_parts := regexp_split_to_array(v_sheet.full_name, '\s+');
    IF array_length(v_parts, 1) = 3
       AND v_parts[1] ~ '^[[:alpha:]]' AND v_parts[1] !~ '\.'
       AND v_parts[2] ~ '^[[:alpha:]]' AND v_parts[2] !~ '\.'
       AND v_parts[3] ~ '^[[:alpha:]]' AND v_parts[3] !~ '\.'
    THEN
      v_short := v_parts[1] || ' ' || upper(left(v_parts[2], 1)) || '.'
                            || upper(left(v_parts[3], 1)) || '.';
    ELSE
      v_short := v_sheet.full_name;
    END IF;

    -- Табельный номер — трудовым отношением на дату листа и односторонним окном (ADR 0101 п. 15):
    -- уволенный после своей недели табельного номера в этом листе не теряет. Отношений у человека
    -- бывает несколько — берётся самое позднее из попавших в окно, как это делает выписка.
    SELECT e.personnel_no INTO v_tab
      FROM person_employments e
     WHERE e.person_id = v_sheet.driver_person_id
       AND (e.ended_on IS NULL OR e.ended_on >= v_sheet.issued_for_date)
     ORDER BY e.started_on DESC
     LIMIT 1;

    -- Условие по пустой графе повторено в самом `UPDATE`: миграции накатываются, пока старые
    -- контейнеры ещё обслуживают трафик, и сверка ЭСМ-2 может идти параллельно. Лист, у которого
    -- фамилия появилась между чтением и правкой, эта работа перезаписывать не должна.
    UPDATE waybills w
       SET data = w.data
                  || jsonb_build_object('driver_fio', v_sheet.full_name,
                                        'driver_short_name', v_short)
                  -- Табельный номер дописывается только в пустую графу: непустая пришла из
                  -- выписки и правды о ней знает больше, чем сегодняшняя кадровая запись.
                  || CASE
                       WHEN v_sheet.personnel_no = '' AND coalesce(v_tab, '') <> ''
                         THEN jsonb_build_object('driver_personnel_no', v_tab)
                       ELSE '{}'::jsonb
                     END,
           updated_at = now()
     WHERE w.id = v_sheet.id
       AND coalesce(w.data->>'driver_fio', '') = '';

    IF NOT FOUND THEN
      RAISE NOTICE 'ЭСМ-2: лист % дополнен кем-то другим, пока шла эта работа — пропуск', v_number;
      CONTINUE;
    END IF;

    INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, metadata)
    VALUES (v_sheet.issued_by, 'waybill.machinist_backfill', 'waybill', v_sheet.id::text,
            jsonb_build_object(
              'reason', v_reason,
              'number', v_number,
              'period', jsonb_build_object('from', v_sheet.period_from, 'to', v_sheet.period_to),
              'personId', v_sheet.driver_person_id,
              'driverFio', v_sheet.full_name,
              'driverShortName', v_short,
              'driverPersonnelNo', coalesce(v_tab, ''),
              'source', 'migration 0271'));

    v_done := v_done + 1;
    RAISE NOTICE 'ЭСМ-2: лист % (% — %) получил машиниста %',
      v_number, v_sheet.period_from, v_sheet.period_to, v_sheet.full_name;
  END LOOP;

  RAISE NOTICE 'ЭСМ-2: дополнено листов %, пропущено %', v_done, v_skipped;
END
$esm2_fio$;
