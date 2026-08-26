-- Данные со сканов СТС: шесть седельных тягачей и шесть полуприцепов парка
-- (план `docs/vehicle-trailers-plan.md`, §2, §2.1, §2.2, §5, §11; шаг 2, этап Э2).
--
-- ЭТО НЕ СИД. Ни одной новой машины миграция не создаёт. Пять тягачей — `К336МС197`, `А060ВЕ777`,
-- `О457ВХ777`, `О403ВХ777`, `М768ЕН197` — на проде УЖЕ заведены руками через справочник: тип
-- проставлен верно, а марка, категория ТТХ и требование к категории прав пусты. Шестой,
-- `Е646СК799`, заведён сидом `0081` и потом перенесён руками в самодельный тип «полуприцеп
-- низкорамный», где потерял марку: модель принадлежит типу, и составной ключ
-- `vehicles_model_type_fk` снял её вместе со сменой типа. Сид «заведи шесть машин» на такой базе
-- либо наплодил бы дублей, либо упёрся бы в `vehicles_registration_number_unique`.
--
-- Отсюда четыре разных действия:
--   1) марки/модели тягачей в типе `tractor_trailers`;
--   2) дозаполнение пяти заведённых руками — ТОЛЬКО ПУСТЫЕ ГРАФЫ;
--   3) возврат `Е646СК799` в тип тягачей с маркой «КАМАЗ 65209-S5»;
--   4) вставка шести полуприцепов в реестр `vehicle_trailers` (`0208`) — вот это единственная
--      настоящая вставка.
--
-- ПОЧЕМУ ТРЕБОВАНИЕ КАТЕГОРИИ ПРАВ ПРОСТАВЛЯЕТ МИГРАЦИЯ (§2.1). Форма техники не спрашивает и не
-- ставит `required_qualification_category_id` — этого поля нет ни в `createVehicleSchema`, ни в
-- обработчике `routes/vehicles.ts`; категорию машинам ставили только миграции `0059` и `0081`. У
-- заведённых руками тягачей она пуста, а подъём требования «C → CE» при галочке «рейс с прицепом»
-- начинается с `if (!row.categoryCode || !withTrailer) return asIs` (`services/drivers.ts`). То
-- есть на этих пяти машинах галочка сегодня не делает ничего: сравнивать не с чем. Категория
-- берётся у типа (`vehicle_types.default_qualification_category_id`, у тягачей — CE) тем же
-- правилом, каким её ставили `0059` и `0081`.
--
-- ЗАМЕТНОЕ СЛЕДСТВИЕ: там, где портал молчал, он начнёт помечать водителя без CE. Список
-- водителей при этом не сужается — это пометка, а не запрет (ADR 0055, 0064), — но для диспетчера
-- это новое красное поле на привычном экране, и в записи выпуска о нём сказано отдельно.
--
-- РЕШЕНИЯ ПО СПОРНЫМ СТРОКАМ:
--
-- 1. Обновляются ТОЛЬКО ПУСТЫЕ ГРАФЫ (`COALESCE(v.<графа>, <из скана>)`). Человек, успевший внести
--    марку или ПТС между написанием миграции и накатом, знает о машине больше, чем скан
--    полугодовой давности, и переписывать его нельзя. Отсюда же идемпотентность: повторный накат
--    не меняет ничего, а счётчик покажет ноль — и это правда, а не молчание.
--
-- 2. Отбор — по НОРМАЛИЗОВАННОМУ госномеру (`vehicle_reg_normalize`, `0015`), как в `0081`:
--    «О403ВХ777» кириллицей и «O403BX777» латиницей — один и тот же номер, и сверка обязана их
--    схлопывать, иначе миграция «не найдёт» заведённую машину и заведёт дубль.
--
-- 3. Шесть машин — ПЯТЬ моделей: `О403ВХ777` и `О457ВХ777` — обе МАЗ 5440В5-8420-031, различаются
--    только VIN и массой. Счётчик первого действия считает модели, а не машины.
--
-- 4. Мощность (кВт/л.с.) и экологический класс со сканов НЕ ПЕРЕНОСЯТСЯ: это ТТХ категории
--    (ADR 0016), а не реквизит экземпляра, и хранить их в `vehicles` негде.
--
-- 5. VIN ложится в `serial_number`: колонка называется «заводской номер», и у автомобиля им служит
--    номер шасси/рамы, который СТС печатает вместе с VIN. Отдельной графы под VIN в `vehicles`
--    нет, и заводить её ради шести машин работа не станет — реквизит один, а имён у него два.
--
-- 6. Год выпуска записывается 1 января: `manufactured_on` — дата, а СТС называет только год. Тот
--    же приём в сидах `0028` и `0073`.
--
-- 7. МАРКА ПОЛУПРИЦЕПА — РУССКИМ НАПИСАНИЕМ СТС, латинское уходит в примечание. Так же `0081`
--    разбирался с двумя написаниями Manitou: в справочнике должно быть одно написание, иначе одна
--    серия разъедется по разным записям (`vehicle_reg_normalize` кириллицу и латиницу схлопывает,
--    а `vehicle_model_normalize` — нет). Латиница записана только там, где её называет источник
--    (§11): «KOGEL SN24» у ЕВ115877 и «SCHMITZ SPR-24» у ЕВ949577. Домысливать её для КРОНА SDP27
--    и для «ШМИТЦ SPR 24|L» миграция не станет — придуманный реквизит хуже отсутствующего.
--
-- 8. Графа СТС «Тип ТС» («полуприцеп с бортовой платформой», «полуприцеп прочее») своей колонки в
--    реестре не имеет: `kind` различает только прицеп и полуприцеп. Чтобы прочитанное со скана не
--    потерялось, она уходит в примечание — там же, где живёт латиница.
--
-- 9. СОБСТВЕННИК НЕ ЗАПОЛНЯЕТСЯ ВОВСЕ: `owner_organization_id = NULL` означает «за основной
--    организацией портала», как у всего парка. У `ЕВ115877` (КОГЕЛЬ SN24) и `М768ЕН197`
--    (КАМАЗ 6460 63) отсканирована только лицевая сторона СТС, и собственник по бумаге не
--    читался; заказчик подтвердил на контрольной точке 26.08.2026, что обе единицы за основной
--    организацией. Оговорка из примечания полуприцепа снята — вопроса больше нет.
-- 10. ПЕРСОНАЛЬНЫХ ДАННЫХ В МИГРАЦИИ НЕТ. Сканы путевых листов, с которых читалась пара
--     «тягач — полуприцеп», содержат ФИО водителей, СНИЛС, номера удостоверений; сюда перенесены
--     только реквизиты машин. Репозиторий публичный.
--
-- 11. ПРИВЯЗКА ПРИЦЕПА К ТЯГАЧУ ЗДЕСЬ НЕ СТАВИТСЯ. Путевой лист № 00000257 от 21.08.2026 показал
--     пару `О403ВХ777` + `ВХ933277`, но одна поездка не делает закрепления (§11.3): закрепление —
--     решение человека в карточке, и оно подставляется в каждый следующий рейс.
--
-- РУЧНОЙ ШАГ ЗАКАЗЧИКА И ПОРЯДОК. Тип «полуприцеп низкорамный» гасит заказчик руками, и порядок
-- обратен интуиции: сначала машина уходит из типа, потом тип удаляется (`vehicle_types` ссылается
-- `ON DELETE RESTRICT`). Миграция переживает оба исхода: сделано руками — она увидит машину уже на
-- месте и тип не тронет; не сделано — переведёт сама. Но САМ ТИП ОНА НЕ ТРОГАЕТ: гасить
-- справочную запись, которую завёл человек, миграция не вправе.
--
-- Внутри третьего действия порядок обязателен: СПЕРВА ТИП, ПОТОМ МОДЕЛЬ. Составной ключ
-- `vehicles_model_type_fk` отвергнет модель чужого типа, и попытка проставить марку до перевода
-- сорвала бы накат.
--
-- СЧЁТЧИКИ. Каждое действие печатает `RAISE NOTICE` со счётчиком, а второе вдобавок перечисляет
-- ненайденные номера. Молчаливый ноль означал бы разошедшуюся сверку номеров — миграция сделала
-- бы вид, что всё хорошо, а справочник остался бы пустым. На деве второе действие законно покажет
-- «0 из 5»: там этих пяти машин нет вовсе, дев отстаёт от прода (§9, риск 5).

-- ── 0. Данные со сканов ─────────────────────────────────────────────────────────────────────
-- Отдельными временными таблицами, а не повторяющимися VALUES: один и тот же набор читают три
-- действия, и разъехаться они не должны.

CREATE TEMP TABLE seed_tractors (
  reg        text NOT NULL,
  model_name text NOT NULL,
  vin        text NOT NULL,
  passport   text NOT NULL,
  made_year  int  NOT NULL
) ON COMMIT DROP;

INSERT INTO seed_tractors VALUES
  ('А060ВЕ777', 'МАЗ 643019-1420-021', 'Y3M643019D0000087', '50НТ926651', 2013),
  ('К336МС197', 'МАЗ 5440А5 330-030',  'Y3M5440A5B0000857', '77УН787678', 2011),
  ('О403ВХ777', 'МАЗ 5440В5-8420-031', 'Y3M5440B5E0000897', '50НТ928143', 2014),
  ('О457ВХ777', 'МАЗ 5440В5-8420-031', 'Y3M5440B5E0000954', '50НХ603272', 2014),
  ('М768ЕН197', 'КАМАЗ 6460 63',       'XTC646003A1196362', '16МТ894535', 2010),
  -- Шестой идёт третьим действием: он лежит в чужом типе, и марку ему можно ставить только после
  -- возврата.
  ('Е646СК799', 'КАМАЗ 65209-S5',      'XTC652095K2526425', '16РА269727', 2019);

CREATE TEMP TABLE seed_trailers (
  reg       text NOT NULL,
  model     text NOT NULL,
  vin       text NOT NULL,
  passport  text NOT NULL,
  made_year int  NOT NULL,
  color     text NOT NULL,
  max_mass  int  NOT NULL,
  curb_mass int  NOT NULL,
  note      text NOT NULL
) ON COMMIT DROP;

INSERT INTO seed_trailers VALUES
  ('ЕВ115877', 'КОГЕЛЬ SN24', 'WK0S0002400121992', '77УР713306', 2008, 'чёрный', 35000, 6370,
   'Тип ТС по СТС — полуприцеп с бортовой платформой. Латинское написание марки — KOGEL SN24.'),
  ('ЕС725850', 'СПЕЦПРИЦЕП 994273', 'X89994273J0BA2330', '69ОУ009584', 2018, 'оранжевый',
   42500, 10500,
   'Тип ТС по СТС — полуприцеп прочее.'),
  ('ЕН806277', 'КРОНА SDP27', 'WKESDP27061291372', '50РЕ019058', 2006, 'серый', 39000, 7790,
   'Тип ТС по СТС — полуприцеп с бортовой платформой.'),
  ('ВХ930577', 'МАЗ 938660-044', 'Y3M938660A0010685', '77УЕ430445', 2010, 'синий', 35000, 6980,
   'Тип ТС по СТС — полуприцеп прочее.'),
  ('ВХ933277', 'ШМИТЦ SPR 24|L', 'WSM00000003061491', '77ТУ095144', 2007, 'серый', 35000, 7000,
   'Тип ТС по СТС — полуприцеп с бортовой платформой.'),
  ('ЕВ949577', 'ШМИТЦ SPR-24', 'WSM00000003076044', '77УА994414', 2007, 'серый', 35000, 6772,
   'Тип ТС по СТС — полуприцеп с бортовой платформой. Латинское написание марки — SCHMITZ SPR-24.');

-- ── 1. Марки/модели тягачей ─────────────────────────────────────────────────────────────────
-- Изготовитель не заполняется: в СТС он назван строкой «ОАО МАЗ»/«ПАО КАМАЗ» вместе с юрформой и
-- страной, а выводить его из марки — то же придумывание реквизита, о котором говорит `0081`.
DO $$
DECLARE
  affected int;
  expected int;
BEGIN
  INSERT INTO vehicle_models (vehicle_type_id, name)
  SELECT t.id, s.model_name
  FROM (SELECT DISTINCT model_name FROM seed_tractors) s
  JOIN vehicle_types t ON t.code = 'tractor_trailers'
  ON CONFLICT (vehicle_type_id, normalized_name) DO NOTHING;
  GET DIAGNOSTICS affected = ROW_COUNT;

  SELECT count(DISTINCT model_name) INTO expected FROM seed_tractors;
  -- Шесть машин — пять моделей: О403ВХ777 и О457ВХ777 обе МАЗ 5440В5-8420-031.
  RAISE NOTICE 'Марок/моделей тягачей заведено: % из % (остальные уже были)', affected, expected;
END $$;

-- ── 2. Дозаполнение пяти заведённых руками тягачей ──────────────────────────────────────────
-- Только пустые графы и только среди живых машин типа `tractor_trailers`. Ограничение по типу —
-- не перестраховка: проставить модель тягача машине, лежащей в чужом типе, значит сорвать накат
-- составным ключом `vehicles_model_type_fk`, а требование категории прав берётся у типа и для
-- чужого типа означало бы другую категорию. Машина, оказавшаяся не там, попадёт в перечень
-- ненайденных — разбирается она руками, как `Е646СК799`.
DO $$
DECLARE
  affected int;
  missing  text;
BEGIN
  UPDATE vehicles v
     SET vehicle_model_id                   = COALESCE(v.vehicle_model_id, m.id),
         serial_number                      = COALESCE(v.serial_number, s.vin),
         passport_number                    = COALESCE(v.passport_number, s.passport),
         manufactured_on                    = COALESCE(v.manufactured_on,
                                                       make_date(s.made_year, 1, 1)),
         required_qualification_category_id = COALESCE(v.required_qualification_category_id,
                                                       t.default_qualification_category_id),
         updated_at                         = now()
    FROM seed_tractors s
    JOIN vehicle_types t ON t.code = 'tractor_trailers'
    LEFT JOIN vehicle_models m
      ON m.vehicle_type_id = t.id AND m.normalized_name = vehicle_model_normalize(s.model_name)
   WHERE s.reg <> 'Е646СК799'
     AND v.registration_number_normalized = vehicle_reg_normalize(s.reg)
     AND v.vehicle_type_id = t.id
     AND v.deleted_at IS NULL
     -- Без этого условия счётчик считал бы и строки, в которых ничего не изменилось.
     AND (v.vehicle_model_id IS NULL OR v.serial_number IS NULL OR v.passport_number IS NULL
          OR v.manufactured_on IS NULL OR v.required_qualification_category_id IS NULL);
  GET DIAGNOSTICS affected = ROW_COUNT;

  RAISE NOTICE 'Дозаполнено тягачей: % из 5', affected;

  SELECT string_agg(s.reg, ', ' ORDER BY s.reg) INTO missing
  FROM seed_tractors s
  JOIN vehicle_types t ON t.code = 'tractor_trailers'
  WHERE s.reg <> 'Е646СК799'
    AND NOT EXISTS (
      SELECT 1 FROM vehicles v
      WHERE v.registration_number_normalized = vehicle_reg_normalize(s.reg)
        AND v.vehicle_type_id = t.id
        AND v.deleted_at IS NULL
    );
  IF missing IS NOT NULL THEN
    RAISE NOTICE 'Не найдены среди живых тягачей (заводятся или разбираются руками): %', missing;
  END IF;
END $$;

-- ── 3. Возврат `Е646СК799` в тип тягачей ────────────────────────────────────────────────────
DO $$
DECLARE
  moved      int;
  marked     int;
  filled     int;
  target_reg constant text := 'Е646СК799';
BEGIN
  -- 3а. Тип. Модель и категория ТТХ принадлежат типу (составные ключи `vehicles_model_type_fk` и
  -- `vehicles_category_type_fk`), пережить перенос они не могут и снимаются здесь же — иначе
  -- перенос машины, которой руками успели проставить марку чужого типа, сорвал бы накат. На проде
  -- обе графы и так пусты: их сняла смена типа через портал.
  UPDATE vehicles v
     SET vehicle_type_id = t.id, vehicle_model_id = NULL, vehicle_category_id = NULL,
         updated_at = now()
    FROM vehicle_types t
   WHERE t.code = 'tractor_trailers'
     AND v.registration_number_normalized = vehicle_reg_normalize(target_reg)
     AND v.vehicle_type_id <> t.id
     AND v.deleted_at IS NULL;
  GET DIAGNOSTICS moved = ROW_COUNT;
  -- Ноль здесь законен: заказчик мог перевести машину руками до наката (ручной шаг §5).
  RAISE NOTICE 'Возвращено в тип «Тягачи с полуприцепами»: %', moved;

  -- 3б. Марка — только после типа. Проставляется пустой графе, а заодно вытесняет «КАМАЗ» одним
  -- словом: так эту машину завёл сид `0081`, и он же оговорил, что индекс списка не называет и его
  -- «уточнят по ПТС». ПТС теперь прочитан. Любая другая марка, проставленная человеком, остаётся
  -- нетронутой.
  UPDATE vehicles v
     SET vehicle_model_id = m.id, updated_at = now()
    FROM vehicle_types t
    JOIN vehicle_models m
      ON m.vehicle_type_id = t.id AND m.normalized_name = vehicle_model_normalize('КАМАЗ 65209-S5')
    LEFT JOIN vehicle_models prev
      ON prev.vehicle_type_id = t.id AND prev.normalized_name = vehicle_model_normalize('КАМАЗ')
   WHERE t.code = 'tractor_trailers'
     AND v.registration_number_normalized = vehicle_reg_normalize(target_reg)
     AND v.vehicle_type_id = t.id
     AND v.deleted_at IS NULL
     AND (v.vehicle_model_id IS NULL OR v.vehicle_model_id = prev.id);
  GET DIAGNOSTICS marked = ROW_COUNT;
  RAISE NOTICE 'Марка «КАМАЗ 65209-S5» проставлена: %', marked;

  -- 3в. Остальные реквизиты со скана — тем же правилом «только пустые графы», что и у пятерых
  -- (план §7: марка, VIN, ПТС и год появляются у ШЕСТИ тягачей).
  UPDATE vehicles v
     SET serial_number                      = COALESCE(v.serial_number, s.vin),
         passport_number                    = COALESCE(v.passport_number, s.passport),
         manufactured_on                    = COALESCE(v.manufactured_on,
                                                       make_date(s.made_year, 1, 1)),
         required_qualification_category_id = COALESCE(v.required_qualification_category_id,
                                                       t.default_qualification_category_id),
         updated_at                         = now()
    FROM seed_tractors s
    JOIN vehicle_types t ON t.code = 'tractor_trailers'
   WHERE s.reg = target_reg
     AND v.registration_number_normalized = vehicle_reg_normalize(s.reg)
     AND v.vehicle_type_id = t.id
     AND v.deleted_at IS NULL
     AND (v.serial_number IS NULL OR v.passport_number IS NULL OR v.manufactured_on IS NULL
          OR v.required_qualification_category_id IS NULL);
  GET DIAGNOSTICS filled = ROW_COUNT;
  RAISE NOTICE 'Реквизиты Е646СК799 (VIN, ПТС, год, категория прав) дозаполнены: %', filled;
END $$;

-- ── 4. Полуприцепы в реестр ─────────────────────────────────────────────────────────────────
-- Единственная настоящая вставка. Идемпотентна по нормализованному госномеру среди живых записей:
-- заведённый руками полуприцеп повторный накат не задваивает и не переписывает. Состояние — по
-- умолчанию `active`, собственник — NULL (решение 9), привязки к тягачу нет (решение 11).
DO $$
DECLARE
  affected int;
  expected int;
BEGIN
  INSERT INTO vehicle_trailers (
    kind, model, registration_number, vin, passport_number, manufactured_year, color,
    max_mass_kg, curb_mass_kg, note, source_name
  )
  SELECT 'semi_trailer', s.model, s.reg, s.vin, s.passport, s.made_year, s.color,
         s.max_mass, s.curb_mass, s.note, 'СТС полуприцепов, сканы от 26.08.2026'
  FROM seed_trailers s
  WHERE NOT EXISTS (
    SELECT 1 FROM vehicle_trailers vt
    WHERE vt.registration_number_normalized = vehicle_reg_normalize(s.reg)
      AND vt.deleted_at IS NULL
  );
  GET DIAGNOSTICS affected = ROW_COUNT;

  SELECT count(*) INTO expected FROM seed_trailers;
  RAISE NOTICE 'Полуприцепов заведено: % из %', affected, expected;
END $$;
