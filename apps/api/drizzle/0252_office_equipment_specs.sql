-- Характеристики моделей оргтехники: цветность печати второй строкой в колонке «Тип»
-- (план `docs/office-equipment-specs-plan.md`, этап Э1; решения Р1–Р5).
--
-- ОТКУДА НОМЕР. Проверено `ls apps/api/drizzle/*.sql` непосредственно перед созданием файла
-- (03.09.2026): последняя миграция в дереве — `0251_mech_requests_model_ref.sql`. Номера миграций
-- и ADR идут параллельными потоками, поэтому сверка сделана заново, а не взята из шапки плана.
--
-- ЗАЧЕМ. Заказчик просит показывать в списке техники, цветной аппарат или чёрно-белый, и прямо
-- сказал две границы: отдельным ВИДОМ техники «цветное МФУ» не заводится (МФУ остаётся одним
-- типом), и колонкой в `office_equipment` цветность не будет — большинство типов таким свойством
-- не обладает вовсе.
--
-- ПОЧЕМУ НЕ КОЛОНКА У МОДЕЛИ (Р1). Колонка `color_mode` в `office_equipment_models` дешевле на
-- один день. Но она не умеет отличить «у монитора цветности не бывает» от «у этого МФУ не
-- заполнено», а на этом различии стоит вся постановка: «н/д» показывается там, где вопрос законен,
-- и не показывается там, где он бессмыслен. Ответить на это колонка может только вторым
-- источником правды — списком «печатающих» типов, зашитым в код портала. Здесь такой список
-- заведён данными: `office_equipment_type_specs`.
--
-- ПОЧЕМУ ЗНАЧЕНИЕ У МОДЕЛИ, А НЕ У КАРТОЧКИ (Р6). Ricoh Aficio MP C2011SP цветной во всех 33
-- карточках парка. Свойство карточки означало бы 33 места, где одно и то же может разойтись, и
-- ровно поэтому к модели привязаны и расходники (миграция 0172).
--
-- «Н/Д» НЕ ХРАНИТСЯ (Р3). Отсутствие строки в `office_equipment_model_specs` и означает «нет
-- данных». Третье значение перечня завело бы два способа сказать одно, и первый же отбор, забывший
-- про один из них, соврал бы.
--
-- ПРЕЦЕДЕНТ. Конструкция для репозитория не новая: ровно так устроены ТТХ спецтехники (ADR 0016) —
-- `vehicle_specs` (характеристика) → `vehicle_type_specs` (у каких типов спрашивается) →
-- `vehicle_category_spec_values` (значение) с той же парой составных ключей. Отличие одно и оно в
-- виде значения: у ТТХ значение числовое (`value_kind = 'number'`), здесь — выбор из заведённого
-- перечня, поэтому у характеристики появляется таблица допустимых значений.
--
-- ТОЛЬКО ПЕРЕЧЕНЬ ЗНАЧЕНИЙ (Р2). Ни текста, ни числа, ни «да/нет»: спрошена одна характеристика с
-- двумя значениями, а четыре вида значений — это четыре ветки в контракте, в форме, в обмене
-- файлом и в показе, написанные ради того, чего не просили. Колонки `value_kind` тоже нет: сегодня
-- она врала бы одинаковым значением во всех строках.
--
-- ОБРАТИМОСТЬ. Миграция аддитивная — четыре новые таблицы, ни одной правки существующих. Протокол
-- выката необратимых миграций (`docs/schema-cutover-protocol.md`) к ней не применяется: откат —
-- `DROP TABLE` четырёх таблиц, и он ничего не уносит с собой.

-- ── Характеристика ──
CREATE TABLE office_equipment_specs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Системный ключ: по нему характеристику находят миграции и обмен файлом. Человеку не виден.
  code text NOT NULL,
  -- Как характеристика называется в карточке и в форме: «Цветность печати».
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 100,
  -- Идёт ли характеристика второй строкой в колонке «Тип» (Р8, Р14). Флаг, а не «показывать все»:
  -- в строке списка помещается одна-две пометки, а характеристик у модели со временем станет
  -- больше — и решать, какие из них видны в списке, должны данные, а не длина строки.
  show_in_list boolean NOT NULL DEFAULT true,
  -- Гашение вместо удаления: погашенную характеристику не спрашивают у новых моделей, но у тех,
  -- кто на неё уже сослался, значение остаётся.
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT office_equipment_specs_code_not_blank_check CHECK (btrim(code) <> ''),
  CONSTRAINT office_equipment_specs_name_not_blank_check CHECK (btrim(name) <> '')
);

CREATE UNIQUE INDEX office_equipment_specs_code_unique ON office_equipment_specs (code);

-- ── Допустимые значения характеристики ──
CREATE TABLE office_equipment_spec_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spec_id uuid NOT NULL REFERENCES office_equipment_specs (id) ON DELETE CASCADE,
  code text NOT NULL,
  -- Полное написание: им значение показывают в карточке единицы и пишут в файл обмена.
  name text NOT NULL,
  -- Сокращение для строки списка: «цв.», «ч/б». Хранится рядом со значением, а не собирается в
  -- портале (Р8): «как это называется коротко» — свойство значения, и второе место, где оно
  -- записано, рано или поздно разойдётся с первым.
  short_name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT office_equipment_spec_values_code_not_blank_check CHECK (btrim(code) <> ''),
  CONSTRAINT office_equipment_spec_values_name_not_blank_check CHECK (btrim(name) <> ''),
  CONSTRAINT office_equipment_spec_values_short_not_blank_check CHECK (btrim(short_name) <> ''),
  CONSTRAINT office_equipment_spec_values_code_unique UNIQUE (spec_id, code),
  -- Цель составного ключа — замок значения в `office_equipment_model_specs` (Р5): без него
  -- «цветная» подставлялась бы в характеристику «формат», и заметить это можно было бы только
  -- глазами в списке.
  CONSTRAINT office_equipment_spec_values_id_spec_unique UNIQUE (id, spec_id)
);

-- ── У каких типов техники характеристика спрашивается (Р4) ──
--
-- Эта таблица и есть ответ на вопрос «показывать ли здесь вторую строку». Есть строка — у модели
-- такого типа цветность спрашивают, и незаполненное значение показывается как «н/д». Нет строки —
-- второй строки нет вовсе: у монитора не «н/д», у монитора вопроса нет.
CREATE TABLE office_equipment_type_specs (
  -- Обе стороны `restrict`, как у `vehicle_type_specs` (ADR 0016, тот же приём): каскад унёс бы
  -- привязку молча, а вместе с ней — и ответ на вопрос «спрашивается ли здесь цветность».
  equipment_type_id uuid NOT NULL REFERENCES office_equipment_types (id) ON DELETE RESTRICT,
  spec_id uuid NOT NULL REFERENCES office_equipment_specs (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (equipment_type_id, spec_id)
);

-- Обратный проход «у каких типов спрашивается эта характеристика» — тот же индекс, что у
-- `vehicle_type_specs` (ADR 0016).
CREATE INDEX office_equipment_type_specs_spec_idx ON office_equipment_type_specs (spec_id);

-- ── Значение характеристики у модели ──
--
-- ДВА ЗАМКА ДЕРЖИТ БАЗА, А НЕ МАРШРУТ (Р5), тем же приёмом, что `office_equipment_model_type_fk`
-- (0171): составной ключ, вторая колонка которого и есть проверка.
--
--   * `(value_id, spec_id)` → значение принадлежит своей характеристике;
--   * `(equipment_type_id, spec_id)` → характеристика спрашивается у этого типа,
--     `(model_id, equipment_type_id)` → модель действительно этого типа.
--
-- Тип модели неизменяем (Р1 плана расходников), поэтому денормализованная колонка типа здесь не
-- расходится с моделью: поменять его нельзя ни правкой модели, ни правкой этой строки.
-- Проверки на стороне маршрута всё равно пишутся — ради слов человеку вместо кода `23503`, — но
-- правилом остаётся база: маршрут, забывший проверку, здесь ничего не сломает.
CREATE TABLE office_equipment_model_specs (
  model_id uuid NOT NULL,
  equipment_type_id uuid NOT NULL,
  spec_id uuid NOT NULL,
  value_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model_id, spec_id),
  -- Удаление модели уносит её значения: справочник характеристик без модели смысла не имеет, а
  -- модель, на которую хоть кто-то ссылается, не удаляется вовсе — её гасят (Р11 плана расходников).
  CONSTRAINT office_equipment_model_specs_model_type_fk
    FOREIGN KEY (model_id, equipment_type_id)
    REFERENCES office_equipment_models (id, equipment_type_id) ON DELETE CASCADE,
  -- `restrict`: снять характеристику с типа, пока у моделей этого типа есть значения, нельзя —
  -- иначе заполненное человеком исчезло бы одной строкой в другой таблице.
  CONSTRAINT office_equipment_model_specs_type_spec_fk
    FOREIGN KEY (equipment_type_id, spec_id)
    REFERENCES office_equipment_type_specs (equipment_type_id, spec_id) ON DELETE RESTRICT,
  CONSTRAINT office_equipment_model_specs_value_fk
    FOREIGN KEY (value_id, spec_id)
    REFERENCES office_equipment_spec_values (id, spec_id) ON DELETE RESTRICT
);

-- Обе стороны ссылок нуждаются в индексе: без них удаление значения и снятие характеристики с типа
-- читали бы таблицу целиком, а проверка ссылок — часть каждой такой операции.
CREATE INDEX office_equipment_model_specs_value_idx
  ON office_equipment_model_specs (value_id, spec_id);
CREATE INDEX office_equipment_model_specs_type_spec_idx
  ON office_equipment_model_specs (equipment_type_id, spec_id);

-- ── Сид: цветность печати ──
--
-- ПОЧЕМУ «ПЕЧАТИ», А НЕ ПРОСТО «ЦВЕТНОСТЬ» (Р7). Ricoh Aficio MP 201SPF — 68 карточек, самая
-- массовая модель парка — печатает чёрно-белым, а сканирует в цвете. Считай «цветным» всякий
-- аппарат, работающий с цветом хоть как-нибудь, — и цветным станет почти весь парк, а строка
-- перестанет отвечать на вопрос, ради которого заведена: куда нести цветной документ. Цветность
-- сканера — отдельная характеристика, и движок её позволяет; сегодня её не спрашивают.
INSERT INTO office_equipment_specs (code, name, sort_order, show_in_list) VALUES
  ('print_color', 'Цветность печати', 10, true);

INSERT INTO office_equipment_spec_values (spec_id, code, name, short_name, sort_order)
SELECT s.id, v.code, v.name, v.short_name, v.sort_order
FROM office_equipment_specs s
CROSS JOIN (VALUES
  ('color', 'Цветная',      'цв.', 10),
  ('mono',  'Чёрно-белая',  'ч/б', 20)
) AS v(code, name, short_name, sort_order)
WHERE s.code = 'print_color';

-- Спрашивается у МФУ и у принтеров. Принтеров в портале сегодня нет ни одного, и это не
-- опережение: тип заведён с самого первого сида (0104), парк заведут при первой же инвентаризации,
-- а миграция ради одной строки — лишний выкат. У сканеров цветность не спрашивается: там вопрос
-- про сканирование, а это другая характеристика (Р7).
INSERT INTO office_equipment_type_specs (equipment_type_id, spec_id)
SELECT t.id, s.id
FROM office_equipment_types t
CROSS JOIN office_equipment_specs s
WHERE t.code IN ('mfp', 'printer') AND s.code = 'print_color';
