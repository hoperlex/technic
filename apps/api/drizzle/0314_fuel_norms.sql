-- Нормы расхода топлива и настройки сверки (план `docs/fuel-norms-plan.md`, этап Э1).
--
-- ОТКУДА НОМЕР ФАЙЛА. `ls apps/api/drizzle` непосредственно перед созданием (16.09.2026): последней
-- закоммиченной в дереве стоит `0313_releases_waste_stats.sql`, свободен `0314`. Соседняя ветка
-- держит в рабочем дереве незакоммиченную `0310`, номер занят ею же — пересечения нет.
--
-- ЧТО ЗАВОДИТСЯ. Три таблицы и ни одной правки существующих данных:
--
--   1. `vehicle_fuel_norms` — норма машины версиями. Приказ адресован госномеру (план, Р1), а не
--      модели, поэтому строка висит на карточке техники; правка заводит новую версию, старая
--      остаётся (Р6) — иначе всякая правка молча переписывала бы уже показанные отчёты.
--   2. `fuel_norm_settings` — одиночка: границы зимы и допуск в процентах, одни на весь портал
--      (Р8). Версий у неё нет осознанно (Р8а).
--   3. `mech_equipment_fuel_norms` — заготовка под нормы собственного оборудования механизации
--      (Р22). Пустая и без внешнего ключа: сущности «единица оборудования» в базе ещё нет, а
--      ссылаться на каталог АРЕНДЫ `mech_models` нельзя — это другой предмет.
--
-- ЕДИНИЦА — `text` С CHECK, А НЕ ENUM. У значения enum в PostgreSQL нет снятия (`ALTER TYPE …
-- DROP VALUE` не существует), и проект на этом уже обжигался — 0197 и 0218. Набор здесь может
-- пополниться третьей единицей, поэтому приём тот же, что у `feature_flags`.
--
-- АВТОРСКИЕ КОЛОНКИ НУЛЕВЫЕ, И ЭТО НЕ НЕБРЕЖНОСТЬ. Пустой автор означает «завёл выкат»: у миграции
-- актора нет вовсе, а сид норм по приказу (этап Э8) пишет строки от имени портала. Тот же приём
-- держит сид оргтехники (0143), где `created_by IS NULL` прямо служит признаком «заведено сидом».
--
-- УНИКАЛЬНОСТЬ ЧАСТИЧНАЯ — по живым строкам. Снятую версию можно перекрыть новой на ту же дату;
-- цена приёма названа в плане (Р7б): вернуть снятую после этого нельзя.
--
-- ПОРЯДОК ВЫКАТА. Схема аддитивная, ничего не переписывает: катится первой, до сервера и клиента.
-- Старый код этих таблиц не знает и не замечает.
--
-- ОБРАТИМОСТЬ: три `DROP TABLE`. Данные при этом теряются — восстанавливать их из приказа заново.

CREATE TABLE IF NOT EXISTS vehicle_fuel_norms (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id     uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  -- «Действует с»: норма смены — живая версия с наибольшей датой из наступивших (план, Р6).
  effective_from date NOT NULL,
  unit           text NOT NULL,
  -- Ставки строго положительны: ноль обратил бы норму смены в ноль, а любое сожжённое топливо — в
  -- бесконечный процент (Р3). Потолок — защита от опечатки на порядок.
  winter_rate    numeric(7,2) NOT NULL,
  summer_rate    numeric(7,2) NOT NULL,
  -- Вид топлива справочно (Р4): в сверке не участвует, расход считается в литрах. Пусто, а не
  -- NULL — два пустых значения на одно состояние развели бы проверку надвое.
  fuel_type      text NOT NULL DEFAULT '',
  note           text NOT NULL DEFAULT '',
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  deleted_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT vehicle_fuel_norms_unit_check
    CHECK (unit IN ('l_per_100km', 'l_per_hour')),
  CONSTRAINT vehicle_fuel_norms_winter_rate_check CHECK (winter_rate > 0 AND winter_rate <= 999),
  CONSTRAINT vehicle_fuel_norms_summer_rate_check CHECK (summer_rate > 0 AND summer_rate <= 999)
);

COMMENT ON TABLE vehicle_fuel_norms IS
  'Нормы расхода топлива по машинам версиями (docs/fuel-norms-plan.md §2): зимняя и летняя ставки, '
  'единица и дата начала действия. Правка заводит новую версию, старая остаётся — отчёты прошлых '
  'периодов считаются прежней ставкой.';

-- Одна живая версия на пару «машина + дата». Повтор даты — это правка приказа того же дня, и она
-- перезаписывает версию, а не заводит вторую (план, Р7а).
CREATE UNIQUE INDEX IF NOT EXISTS vehicle_fuel_norms_vehicle_date_unique
  ON vehicle_fuel_norms (vehicle_id, effective_from)
  WHERE deleted_at IS NULL;

-- Рабочий поиск расчёта: действующая версия ищется на КАЖДУЮ смену периода, то есть тысячами раз
-- за один запрос сводки. Порядок по убыванию даты — чтобы первая же строка была ответом.
CREATE INDEX IF NOT EXISTS vehicle_fuel_norms_vehicle_effective_idx
  ON vehicle_fuel_norms (vehicle_id, effective_from DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS fuel_norm_settings (
  -- Одиночка: строка ровно одна, вторую запрещает первичный ключ с CHECK (приём 0164).
  id                boolean PRIMARY KEY DEFAULT true CHECK (id),
  -- Границы зимнего сезона парой «месяц-день»: период переходит через Новый год, и это норма, а не
  -- особый случай. Выражение ловит мусор и тринадцатый месяц; календарность (30 февраля) закрывает
  -- форма — 29 февраля здесь законно намеренно.
  winter_from_md    text NOT NULL,
  winter_to_md      text NOT NULL,
  tolerance_percent numeric(5,2) NOT NULL,
  updated_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fuel_norm_settings_winter_from_check
    CHECK (winter_from_md ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
  CONSTRAINT fuel_norm_settings_winter_to_check
    CHECK (winter_to_md ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
  CONSTRAINT fuel_norm_settings_tolerance_check
    CHECK (tolerance_percent >= 0 AND tolerance_percent <= 100)
);

COMMENT ON TABLE fuel_norm_settings IS
  'Настройки сверки расхода с нормой (docs/fuel-norms-plan.md §2.3): границы зимнего сезона и '
  'допуск в процентах. Строка одна на портал, версий нет — правка меняет и уже показанные отчёты.';

-- Строка умолчаний нужна сразу: без неё расчёт подставлял бы значения из контрактов, а окно
-- показывало бы пустоту. Уже заведённую настройку не трогаем — у неё выверенные числа.
INSERT INTO fuel_norm_settings (winter_from_md, winter_to_md, tolerance_percent)
VALUES ('11-01', '03-31', 5)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS mech_equipment_fuel_norms (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Инвентарный номер оборудования из приказа. Ссылки на единицу нет: самой сущности в базе ещё
  -- нет, а `mech_models` — каталог аренды, не собственное оборудование (план, Р22).
  equipment_ref  text NOT NULL,
  effective_from date NOT NULL,
  unit           text NOT NULL,
  winter_rate    numeric(7,2) NOT NULL,
  summer_rate    numeric(7,2) NOT NULL,
  fuel_type      text NOT NULL DEFAULT '',
  note           text NOT NULL DEFAULT '',
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mech_equipment_fuel_norms_unit_check
    CHECK (unit IN ('l_per_100km', 'l_per_hour')),
  CONSTRAINT mech_equipment_fuel_norms_winter_rate_check
    CHECK (winter_rate > 0 AND winter_rate <= 999),
  CONSTRAINT mech_equipment_fuel_norms_summer_rate_check
    CHECK (summer_rate > 0 AND summer_rate <= 999)
);

COMMENT ON TABLE mech_equipment_fuel_norms IS
  'Заготовка: нормы расхода собственного оборудования механизации (docs/fuel-norms-plan.md §7). '
  'Пуста до появления сущности «единица оборудования механизации» — тогда же получит ссылку на неё '
  'и свой экран. Мягкого удаления и уникальности нет: вешать их не на что, пока нет ключа единицы.';
