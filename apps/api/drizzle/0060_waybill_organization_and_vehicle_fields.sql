-- Реквизиты владельца транспорта и поля машины для путевого листа (ADR 0037).
--
-- Шапка бланка 4-П начинается с того, чего в портале не было вовсе: наименование, адрес и
-- телефон организации, коды ОКПО и ОКУД. До сих пор своя организация существовала только как
-- умолчание — «пустой employer_name в person_employments = основная организация портала».
--
-- Таблица, а не строка настроек: техника может числиться за разными юрлицами, и путевой лист
-- выписывает то из них, за которым числится машина. Пока юрлицо одно, `vehicles` на него не
-- ссылаются вовсе — лист берёт основную организацию, и это ровно тот случай, когда расширение
-- не потребует переписывать выданные листы.

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Как организация называется в шапке листа: «АО "Служба механизации"».
  name text NOT NULL,
  -- Юридический адрес и телефон печатаются одной строкой под наименованием.
  address text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  -- Коды из правого верхнего угла бланка. ОКПО — 8 знаков у организации, 10 у обособленного
  -- подразделения; ОГРН — 13 у юрлица, 15 у ИП. Пустая строка = реквизит не заполнен: лист
  -- печатается и без него, а требовать то, чего у бухгалтерии сейчас нет, значит не дать
  -- завести организацию вовсе.
  okpo text NOT NULL DEFAULT '',
  ogrn text NOT NULL DEFAULT '',
  inn text NOT NULL DEFAULT '',
  -- Основная организация портала: ею подписан лист на машину, за которой юрлицо не закреплено.
  is_primary boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  comment text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organizations_name_not_blank CHECK (btrim(name) <> ''),
  -- Контрольные суммы проверяет сервис — приём ИНН контрагента (0022): формат ловит длину,
  -- контрольная сумма ловит опечатку в одной цифре, и в CHECK её не выразить.
  CONSTRAINT organizations_inn_format_check CHECK (inn = '' OR inn ~ '^([0-9]{10}|[0-9]{12})$'),
  CONSTRAINT organizations_okpo_format_check CHECK (okpo = '' OR okpo ~ '^([0-9]{8}|[0-9]{10})$'),
  CONSTRAINT organizations_ogrn_format_check CHECK (ogrn = '' OR ogrn ~ '^([0-9]{13}|[0-9]{15})$')
);

-- Основная — не более одной: «чей это лист по умолчанию» обязано иметь единственный ответ.
CREATE UNIQUE INDEX organizations_primary_unique ON organizations (is_primary)
  WHERE is_primary;
CREATE UNIQUE INDEX organizations_inn_unique ON organizations (inn) WHERE inn <> '';

-- Таблица создаётся пустой: реквизиты заводит администратор. Без организации путевой лист не
-- выписывается — это шаг настройки, а не данные, которые можно угадать миграцией.

-- ── Реквизиты машины для бланка ──

-- Гаражный номер — своя графа бланка, отдельная от инвентарного номера (тот из 1С и печатается
-- в форме № 3 своей строкой). NULL = не присвоен; пустую строку не храним — приём соседних
-- номеров машины (0017).
ALTER TABLE vehicles
  ADD COLUMN garage_number text,
  ADD COLUMN owner_organization_id uuid REFERENCES organizations (id) ON DELETE RESTRICT,
  ADD CONSTRAINT vehicles_garage_number_not_blank_check
    CHECK (garage_number IS NULL OR btrim(garage_number) <> '');

CREATE INDEX vehicles_owner_organization_idx ON vehicles (owner_organization_id)
  WHERE owner_organization_id IS NOT NULL;

-- ── Какой бланк выписывается на машины этого типа ──
-- Код формы, а не флаг «выписывать/нет»: легковые (форма № 3) и спецтехника (ЭСМ) добавятся
-- значением в этой колонке, а не второй схемой. NULL = лист не выписывается — так сейчас
-- обстоит дело со всей спецтехникой и с легковыми: на служебную машину заявок не заводят,
-- а лист рождается переводом заявки в работу (ADR 0037).
ALTER TABLE vehicle_types
  ADD COLUMN waybill_form_code text,
  ADD CONSTRAINT vehicle_types_waybill_form_check
    CHECK (waybill_form_code IS NULL OR waybill_form_code IN ('4p', 'leg3', 'esm2'));

UPDATE vehicle_types
SET waybill_form_code = '4p'
WHERE code IN (
  'light_trucks', 'dump_trucks', 'heavy_manipulators', 'tractor_trailers', 'flatbed_trucks'
);
