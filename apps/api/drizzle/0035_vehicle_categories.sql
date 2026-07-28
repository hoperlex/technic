-- ТТХ типов ТС — Фаза 2: категории (условные подтипы) как кортежи значений ТТХ.
-- См. docs/adr/0016-vehicle-type-specs-and-categories.md.
-- Таблицы создаются ПУСТЫМИ: категории заводит человек в справочнике либо приносит seed-миграция
-- из выверенных данных. Генерации комбинаций перебором нет намеренно (ADR 0016 §7).

-- 1. Канонизация набора значений — IMMUTABLE-функция, единственный источник истины (приём из 0015
--    и 0022: приложение не дублирует канонизацию, а вызывает функцию в запросах — иначе смысл
--    уникального индекса разошёлся бы с кодом). payload — {код ТТХ: значение}, результат —
--    «boom_length=21;lift_capacity=25»: отсортировано по коду, число через trim_scale, поэтому
--    21.0 и 21 дают одну сигнатуру и ловятся как дубль.
CREATE FUNCTION vehicle_category_signature(payload jsonb) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT coalesce(
    string_agg(e.key || '=' || trim_scale(e.value::numeric)::text, ';' ORDER BY e.key),
    ''
  )
  FROM jsonb_each_text(payload) AS e(key, value)
$$;

-- 2. Категории. Идентичность — набор значений, а не наименование: её материализует spec_signature
--    под UNIQUE (vehicle_type_id, spec_signature) — «одна комбинация значений = одна категория».
--    Пустая сигнатура запрещена: у типа без ТТХ категорий нет вовсе, тип сам является конечной
--    классификацией. Уникальности имени в БД нет намеренно (ADR 0016 §11): имя производно и
--    массово перезаписывается при смене состава ТТХ, индекс ловил бы мнимые конфликты.
CREATE TABLE vehicle_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_type_id uuid NOT NULL REFERENCES vehicle_types (id) ON DELETE RESTRICT,
  name text NOT NULL,
  -- false — имя правил человек, автогенерация его больше не перезаписывает.
  is_auto_name boolean NOT NULL DEFAULT true,
  spec_signature text NOT NULL,
  sort_order integer NOT NULL DEFAULT 100,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vehicle_categories_name_not_blank_check CHECK (btrim(name) <> ''),
  CONSTRAINT vehicle_categories_signature_not_blank_check CHECK (btrim(spec_signature) <> ''),
  -- Цель составного FK из значений (приём vehicles_model_type_fk, ADR 0007 §4).
  CONSTRAINT vehicle_categories_id_type_unique UNIQUE (id, vehicle_type_id)
);
CREATE UNIQUE INDEX vehicle_categories_type_signature_unique
  ON vehicle_categories (vehicle_type_id, spec_signature);
CREATE INDEX vehicle_categories_type_active_sort_idx
  ON vehicle_categories (vehicle_type_id, is_active, sort_order);

-- 3. Значения ТТХ у категории. Пара составных FK физически запрещает:
--    - значение по ТТХ, не привязанному к типу этой категории;
--    - значение, «переехавшее» к категории чужого типа;
--    - отвязку ТТХ от типа, пока по нему есть значения (RESTRICT → осознанный разбор в сервисе).
--    Денормализованный vehicle_type_id рассинхронизироваться не может — его держит первый FK.
CREATE TABLE vehicle_category_spec_values (
  category_id uuid NOT NULL,
  vehicle_type_id uuid NOT NULL,
  spec_id uuid NOT NULL,
  value_num numeric(14, 4) NOT NULL,
  CONSTRAINT vehicle_category_spec_values_pkey PRIMARY KEY (category_id, spec_id),
  CONSTRAINT vehicle_category_spec_values_category_fk
    FOREIGN KEY (category_id, vehicle_type_id)
    REFERENCES vehicle_categories (id, vehicle_type_id) ON DELETE CASCADE,
  CONSTRAINT vehicle_category_spec_values_type_spec_fk
    FOREIGN KEY (vehicle_type_id, spec_id)
    REFERENCES vehicle_type_specs (vehicle_type_id, spec_id) ON DELETE RESTRICT
);
-- Отбор техники по характеристике («г/п ≥ 20 т») — ради него значения лежат таблицей, а не jsonb.
CREATE INDEX vehicle_category_spec_values_spec_value_idx
  ON vehicle_category_spec_values (spec_id, value_num);

-- 4. Инвариант полноты. Ключи закрывают «нет лишних и чужих значений», но не «нет пропущенных»:
--    это единственная проверка, которую нельзя выразить ключом. Пользовательские ошибки ловит и
--    объясняет сервис (транзакция с SELECT … FOR UPDATE строки типа), функция ниже — страховка от
--    прямого SQL мимо API. Вызывается отложенными constraint-триггерами: на COMMIT, чтобы
--    «вставить категорию → вставить значения» внутри одной транзакции было допустимо.
CREATE FUNCTION vehicle_category_assert_consistent(p_category_id uuid) RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  v_type_id uuid;
  v_stored text;
  v_actual text;
  v_specs integer;
  v_values integer;
BEGIN
  SELECT vehicle_type_id, spec_signature INTO v_type_id, v_stored
  FROM vehicle_categories WHERE id = p_category_id;
  -- Категорию удалили в этой же транзакции (её значения ушли по CASCADE) — проверять нечего.
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT count(*) INTO v_specs FROM vehicle_type_specs WHERE vehicle_type_id = v_type_id;
  SELECT count(*) INTO v_values FROM vehicle_category_spec_values WHERE category_id = p_category_id;
  IF v_specs = 0 OR v_values <> v_specs THEN
    RAISE EXCEPTION
      'Категория % неполна: значений %, ТТХ у типа %', p_category_id, v_values, v_specs
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT vehicle_category_signature(jsonb_object_agg(s.code, v.value_num)) INTO v_actual
  FROM vehicle_category_spec_values v
  JOIN vehicle_specs s ON s.id = v.spec_id
  WHERE v.category_id = p_category_id;

  IF v_actual IS DISTINCT FROM v_stored THEN
    RAISE EXCEPTION
      'Сигнатура категории % расходится со значениями: в строке «%», по значениям «%»',
      p_category_id, v_stored, v_actual
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

CREATE FUNCTION vehicle_categories_consistency_trg() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  PERFORM vehicle_category_assert_consistent(NEW.id);
  RETURN NULL;
END
$$;

CREATE FUNCTION vehicle_category_values_consistency_trg() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM vehicle_category_assert_consistent(OLD.category_id);
  ELSE
    PERFORM vehicle_category_assert_consistent(NEW.category_id);
    IF TG_OP = 'UPDATE' AND OLD.category_id <> NEW.category_id THEN
      PERFORM vehicle_category_assert_consistent(OLD.category_id);
    END IF;
  END IF;
  RETURN NULL;
END
$$;

-- Смена состава ТТХ у типа обесценивает ВСЕ его категории разом: добавленный ТТХ делает их
-- неполными, отвязанный — меняет их сигнатуры. Проверяем каждую.
CREATE FUNCTION vehicle_type_specs_consistency_trg() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_type_id uuid;
  r record;
BEGIN
  v_type_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.vehicle_type_id ELSE NEW.vehicle_type_id END;
  FOR r IN SELECT id FROM vehicle_categories WHERE vehicle_type_id = v_type_id LOOP
    PERFORM vehicle_category_assert_consistent(r.id);
  END LOOP;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER vehicle_categories_consistency
  AFTER INSERT OR UPDATE ON vehicle_categories
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION vehicle_categories_consistency_trg();

CREATE CONSTRAINT TRIGGER vehicle_category_values_consistency
  AFTER INSERT OR UPDATE OR DELETE ON vehicle_category_spec_values
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION vehicle_category_values_consistency_trg();

CREATE CONSTRAINT TRIGGER vehicle_type_specs_consistency
  AFTER INSERT OR DELETE ON vehicle_type_specs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION vehicle_type_specs_consistency_trg();
