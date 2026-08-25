# План: цикл заявок оргтехники, должностные полномочия и заявки на расходники

Все решения приняты и обоснованы в
[набросках](office-equipment-requests-rework-draft.md): постановка заказчика, опрос 21.08.2026
(развилки В3–В22), ревью того же дня (восемь противоречий) и ответы В23–В25 с двумя техническими
уточнениями. Здесь — **как это делается**: модель данных, миграции по выпускам, матрица прав,
этапы, волны, тесты и порядок выката. Обоснования не повторяются, а называются ссылкой на решение
набросков (Н1–Н13, Р1–Р11).

Модуль — [ADR 0085](adr/0085-office-equipment-module.md); последняя переделка цикла —
[ADR 0125](adr/0125-service-request-cycle-changes.md); справочник расходников — отдельный
[план](office-equipment-consumables-plan.md).

---

## 1. Что делает этот план

1. Сводит оба вида заявок к **одному словарю статусов** и переносит визу ИТ со входа на смету.
2. Заводит **поимённых исполнителей** рядом с исполнителем-контрагентом.
3. Заводит **автоматическое закрытие** «Решена» → «Закрыта» с явным автором-системой.
4. Переносит планку закрывающего документа на «Решена» — **только для сервисного ремонта**.
5. Заводит **вид заявки** и, отдельным выпуском, **заявки на расходники** со списанием со склада.
6. Перебирает **должностные полномочия**: три набора, пять новых прав, своё правило удаления.
7. Показывает в карточке **подразделение заявителя**.

Чего план **не** делает: не создаёт справочник расходников (это его собственный план, §2), не
трогает вывоз мусора и заказ техники, не заводит складской учёт операциями, не удаляет мёртвые
значения enum и колонку `due_date`.

---

## 2. Зависимости

### 2.1. Три правки в план расходников — до начала его реализации

**Статус: сделано 21.08.2026.** Правки внесены и в текст плана расходников, и в его незакоммиченную
реализацию — миграцию `0172`, схему, контракты, маршрут и портал. Таблица ниже остаётся описанием
того, что именно требовалось.

Справочник моделей и таблицы расходников лежат в дереве незакоммиченными (миграции `0171` и `0172`).
Правки внесены до того, как `0172` уехала в main, — в этом и был их смысл; таблица ниже описывает,
что именно требовалось и почему:

| Что | Куда | Почему |
| --- | --- | --- |
| Цвет — свойство позиции (свой код, свой остаток), «комплект» — отдельная позиция | Р5, §7 | автосписание списывает позицию; цвет пометкой в заявке делает остаток по цветам неизвестным (Р9 набросков) |
| Три колонки журнала: `entry_kind`, `service_request_id` (с FK), `service_request_consumable_id` — **nullable uuid без внешнего ключа** — и `CHECK`и к ним | §5, Р7 | связь «списано по заявке» нельзя восстанавливать разбором текста причины (Р4 набросков); ключ на строку заявки достраивается в M12, когда таблица строк появится (§5, выпуск 3) |
| Права `officeEquipmentConsumables.manage` и `officeEquipmentConsumables.stock` вместо общего `officeEquipment.write` | Р10 | иначе набор «Номенклатура» выдаётся вместе с ведением всего парка техники (Р8 набросков) |

### 2.2. Порядок выпусков

**Решение заказчика 24.08.2026: выпуски 1 и 3 катятся вместе, одним деплоем.** Работа перемешана со
справочником расходников — он уезжает тем же выкатом, и разносить их по времени незачем: всё, что
делает выпуск 3, **аддитивно** (новая таблица строк, ключ в журнале, новые ручки) и ничего не
запрещает старому коду.

- **Выпуски 1 + 3 «Цикл, полномочия и заявки на расходники»** — один выкат вместе со справочником
  расходников.
- **Выпуск 2 «Contract»** — **слить с ними нельзя**, и это не осторожность, а механика деплоя (§3):
  он ставит жёсткие связки (`acceptance_source` ровно у принятой, триггер ревизионной визы, `CHECK`
  на мёртвые статусы) и переводит живые заявки. Миграции накатываются **до** перезапуска, и в этом
  окне на новой схеме работает ещё старый код — он пишет приёмку без источника, ставит визу без
  ревизии и заводит заявки в `it_approved`. Одним выкатом это уронило бы заявки на всё окно, а
  перевод статусов пришлось бы повторять. Катится отдельно, при выполненном условии §11.3.

---

## 3. Главное правило этого плана: окно выката

Штатный деплой **накатывает миграции до перезапуска сервисов**
([протокол §1](schema-cutover-protocol.md)). Значит между накатом и перезапуском **старый код
работает на новой схеме**. Из этого следуют пять решений, и без них план был бы неисполним:

1. **Ни одно новое ограничение выпуска 1 не запрещает того, что делает старый код.** Все жёсткие
   проверки — в выпуске 2, когда старого кода уже нет.
2. **Колонка `acceptance_source` в выпуске 1 nullable и не связана с `accepted_at`.** Старый код
   принимает заявку, не зная про источник; связка «источник есть ровно у принятой» встаёт в
   выпуске 2.
3. **Триггер ревизионной визы ставится в выпуске 2, а не в первом.** Старый код в окне выката ещё
   ставит входную визу и ревизии не знает — триггер выпуска 1 ронял бы визирование.
4. **Снятие ограничения — не то же, что установка.** `service_requests_accepted_check` и
   `service_requests_executor_check` снимаются уже в выпуске 1: старому коду они не нужны — он
   писал приёмку парой и назначал контрагента, — а новому мешают (автозакрытие пишет дату без
   автора, свой исполнитель работает без контрагента).
5. **Перевод заявок из мёртвых статусов — в выпуске 2.** Сделай его выпуск 1 — старый код за
   оставшееся до перезапуска время завёл бы новые заявки в `it_approved`, и перевод пришлось бы
   повторять. Поэтому код выпуска 1 **умеет работать с заявками в `it_approved` и `diagnostics`**
   (§7.3), а выпуск 2 переводит остаток, когда новых поступлений быть уже не может.

---

## 4. Модель данных

### 4.1. `service_requests` — новые колонки

| Колонка | Тип | Выпуск | Смысл |
| --- | --- | --- | --- |
| `kind` | `text NOT NULL DEFAULT 'repair'` | 1 | вид заявки: `repair` \| `consumable` (Н1) |
| `it_approved_estimate_revision` | `integer` | 1 | ревизия сметы, к которой относится виза ИТ (Н3) |
| `acceptance_source` | `text` | 1 | `human` \| `auto` — кто закрыл заявку (Н7). У `auto` автор приёмки обязан быть пустым: «автоматически, но кем-то» — состояние, которое никто не объяснит |
| `replacement_recommended` | `boolean NOT NULL DEFAULT false` | 1 | «ремонт нецелесообразен, аппарат под замену» (Н3, В21) |
| `requester_department_id` | `uuid NULL → departments` | 1 | подразделение заявителя (Н11) |
| `requester_object_id` | `uuid NULL → construction_objects` | 1 | площадка заявителя, если отдела нет (Н11) |
| `requester_department_name` | `text NOT NULL DEFAULT ''` | 1 | снимок названия отдела на момент заведения |
| `requester_object_name` | `text NOT NULL DEFAULT ''` | 1 | снимок названия площадки |

`DEFAULT 'repair'` у `kind` остаётся навсегда: снятие умолчания сломало бы окно выката, а «вид по
умолчанию — ремонт» верно и после него.

### 4.2. `service_request_executors` — новая таблица (выпуск 1)

Поимённые исполнители (Н5). Ключ — пара «заявка + учётка»; `assigned_by` хранит, кто назначил.
Исполнитель-контрагент остаётся колонкой `service_counterparty_id` в заявке: сервисная компания
назначается целиком, её сотрудники поимённо не выбираются.

**Отсюда — правило отказа, и оно разное у двух слоёв** (правка после ревью). «Снять только
отказавшегося» применимо лишь к поимённым: у сервиса поимённых строк нет, и снимать нечего.
Поэтому:

- **свой сотрудник** отказом снимает **свою строку** — остальные назначенные продолжают вести
  заявку;
- **оператор сервисной компании** отказом снимает **всю компанию** (`service_counterparty_id`
  обнуляется): назначена была она, а не человек, и «часть подрядчика» отказаться не может;
- если после отказа не осталось **ни строк, ни контрагента**, заявка возвращается в «Новую» и ждёт
  распределения. Если остался хоть один исполнитель — статус не меняется.

Смешанное назначение «свой сисадмин + сервис» — обычный случай постановки, и его поведение
проверяется отдельным тестом (§8, тест 4): отказ сервиса оставляет заявку у своего и не двигает
статус, отказ своего оставляет её у сервиса.

### 4.3. `service_request_consumables` — новая таблица (выпуск 3)

Строки заявки на расходники (Н9): позиция справочника, `requested_quantity`, `issued_quantity`,
`issue_note` — причина **любого** расхождения факта с запрошенным (В9а, В9б). Своей таблицей, а не в
`service_request_items`: там цена, сумма и гарантия, то есть смета ремонта. Событие журнала остатка
ссылается на строку **составным ключом** «строка + заявка + позиция», чтобы списание не могло
указывать на строку другой заявки (§5, M12).

### 4.4. `service_request_status_history` (выпуск 1)

`changed_by` становится nullable, рядом встаёт `actor_source` (`user` | `system`) — иначе
автоматическое закрытие нечем записать (Н7).

### 4.5. Что снимается

- `service_requests_executor_check` — инвариант «в рабочем статусе есть исполнитель» уезжает в
  отложенный триггер: `CHECK` не видит другую таблицу (Н5);
- `service_requests_accepted_check` («автор и дата приёмки заполнены вместе или никак») — снимается
  уже в выпуске 1 (M2, §3 п. 4): автозакрытие пишет дату без автора, и при живом ограничении первая
  же автоматически закрытая заявка упёрлась бы в него;
- `service_requests_open_per_equipment_unique` — заменяется двумя частичными индексами, по одному на
  вид (В12).

---

## 5. Миграции

Их **четырнадцать**: восемь в выпуске 1, четыре в выпуске 2, две в выпуске 3. Номера — **ориентиры на
21.08.2026**; поток расходников держит `0171`–`0177`. Номер сверяется в момент создания каждого
файла, а не берётся отсюда: за время написания плана расходников нумерация уходила вперёд дважды.

Каждая миграция идёт **одной транзакцией**
([migration-journal.ts](../apps/api/src/db/migration-journal.ts)) — поэтому `CREATE INDEX
CONCURRENTLY` в них невозможен; обычное построение индекса на таблице заявок допустимо, она
измеряется тысячами строк.

### Выпуск 1

**M1 — `0175_service_request_it_revision.sql`** *(номер по факту создания)*

```sql
ALTER TABLE service_requests ADD COLUMN it_approved_estimate_revision integer;

-- Ревизия без подписи не значит ничего; ревизия не может опережать саму смету.
-- Пустая ревизия при заполненной подписи ЗАКОННА: так выглядит входная виза старого образца,
-- и запрет на неё встаёт триггером в выпуске 2 (M10), когда старый код уже не работает.
ALTER TABLE service_requests ADD CONSTRAINT service_requests_it_revision_check CHECK (
  it_approved_estimate_revision IS NULL
  OR (it_approved_by IS NOT NULL AND it_approved_estimate_revision <= estimate_revision)
);
```

Обратимость: аддитивна. Существующие строки проходят проверку — у них новая колонка пуста.

**Замечание на будущее** (найдено в В2): `it_approved_by IS NOT NULL` в этом `CHECK` сегодня новой
двери не открывает — пару «кто + когда» уже держит `service_requests_it_approval_check` из `0119`,
и удалить учётку визирующего база не даст и без M1. Но если когда-нибудь будут ослаблять `0119`,
ослаблять придётся **обе** проверки разом: иначе послабление окажется половинчатым и упрётся сюда.

**M2 — `0176_service_request_auto_acceptance.sql`**

```sql
ALTER TABLE service_requests ADD COLUMN acceptance_source text;

-- Порядок обязателен: сначала колонка, потом backfill, потом ограничение. Поставь ограничение
-- раньше backfill — оно упадёт на уже принятых заявках.
UPDATE service_requests SET acceptance_source = 'human' WHERE accepted_at IS NOT NULL;

-- Старое `service_requests_accepted_check` («автор и дата заполнены вместе или никак») снимается
-- ЗДЕСЬ, а не в выпуске 2: автозакрытие приезжает уже в выпуске 1 и пишет `accepted_at` без автора —
-- при живом ограничении первая же автоматически закрытая заявка упёрлась бы в него. Старому коду
-- снятие ограничения не мешает: он по-прежнему пишет пару целиком.
ALTER TABLE service_requests DROP CONSTRAINT service_requests_accepted_check;

-- «Человек» НЕ требует непустого `accepted_by`: ссылка объявлена `ON DELETE SET NULL`, и удаление
-- уволенного сотрудника обнулило бы её — с требованием автора такое удаление упёрлось бы в это
-- ограничение. Источник отвечает на вопрос «человек или портал», имя — отдельная и теряемая
-- вместе с учёткой подробность.
--
-- Связки «источник есть ровно у принятой» здесь НЕТ, и это не забывчивость (§3, п. 2): старый код
-- откатывает приёмку, очищая `accepted_by/at` и не зная про источник, — связка уронила бы откат.
-- Она встаёт в M9.
ALTER TABLE service_requests ADD CONSTRAINT service_requests_acceptance_source_check CHECK (
  acceptance_source IS NULL
  OR (acceptance_source IN ('human','auto')
      AND (acceptance_source <> 'auto' OR accepted_by IS NULL))
);

ALTER TABLE service_request_status_history ALTER COLUMN changed_by DROP NOT NULL;
ALTER TABLE service_request_status_history ADD COLUMN actor_source text NOT NULL DEFAULT 'user';
ALTER TABLE service_request_status_history
  ADD CONSTRAINT service_request_status_history_actor_check CHECK (
    actor_source IN ('user','system') AND (actor_source = 'user') = (changed_by IS NOT NULL)
  );
```

Существующие строки истории имеют автора и получают `user` по умолчанию — ограничение проходит.
`DROP NOT NULL` и `ADD COLUMN … DEFAULT` не переписывают таблицу (PostgreSQL 11+).

**Код выпуска 1 обязан читать пустой источник как «принято человеком».** Заявка, принятая старым
кодом после наката M2 и до перезапуска, остаётся с `accepted_at` и пустым `acceptance_source` — и
живёт так до M9, то есть **неделю**. Поэтому DTO объявляет источник как `'human' | 'auto' | null`,
портал показывает `null` так же, как `human` (без пометки «автоматически»), и ни одна ветка кода не
считает пустой источник ошибкой. После M9 такого значения у принятой заявки не остаётся, но тип
поля не меняется: у непринятой он пуст всегда.

**Код выпуска 1 обязан очищать источник при откате приёмки.** Ветка `reset.acceptance` в
[`routes/service-requests.ts`](../apps/api/src/routes/service-requests.ts#L783) сегодня обнуляет
`accepted_by` и `accepted_at`; к ним дописывается `acceptance_source`. Без этого откат оставляет
источник у непринятой заявки, и M9 упадёт.

**M3 — `0177_service_request_kind.sql`**

```sql
ALTER TABLE service_requests ADD COLUMN kind text NOT NULL DEFAULT 'repair';
ALTER TABLE service_requests ADD CONSTRAINT service_requests_kind_check
  CHECK (kind IN ('repair','consumable'));

-- Одна открытая заявка НА ВИД (В12): ремонт и расходники по одному аппарату не мешают друг другу,
-- но два открытых ремонта или две открытых заявки на картриджи по-прежнему невозможны.
DROP INDEX service_requests_open_per_equipment_unique;
CREATE UNIQUE INDEX service_requests_open_repair_unique ON service_requests (office_equipment_id)
  WHERE deleted_at IS NULL AND kind = 'repair' AND status NOT IN ('accepted','cancelled');
CREATE UNIQUE INDEX service_requests_open_consumable_unique ON service_requests (office_equipment_id)
  WHERE deleted_at IS NULL AND kind = 'consumable' AND status NOT IN ('accepted','cancelled');
```

Старый код вставляет заявку без `kind` и получает `repair` — то есть попадает ровно под тот индекс,
который его и ограничивал.

**Схема разрешает `consumable` с этой миграции, а API — нет** (§7.3): до выпуска 3 у такой заявки
нет ни строк номенклатуры, ни формы, ни списания, и заведённая раньше времени она была бы заявкой
без предмета. Запрет снимается вместе с M12.

**M4 — `0178_service_request_executors.sql`**

```sql
CREATE TABLE service_request_executors (
  request_id  uuid NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, user_id)
);
CREATE INDEX service_request_executors_user_idx ON service_request_executors (user_id);

-- Старый инвариант снимается: он требовал КОНТРАГЕНТА, а исполнителем теперь бывает свой сотрудник.
ALTER TABLE service_requests DROP CONSTRAINT service_requests_executor_check;

-- Ядро инварианта: «в рабочем статусе у заявки есть исполнитель — контрагент или поимённый».
-- CHECK здесь невозможен: он видит только собственную строку. Прецедент приёма — миграция
-- `0035_vehicle_categories.sql` (не ADR того же номера: тот про факт вывоза объёмом).
CREATE FUNCTION service_request_executor_present(p_request_id uuid) RETURNS void AS $$
DECLARE r record; n integer;
BEGIN
  SELECT status, held_from_status, service_counterparty_id INTO r
    FROM service_requests WHERE id = p_request_id FOR UPDATE;
  -- Заявку удалили в этой же транзакции — проверять нечего (тот же выход, что в миграции 0035).
  IF NOT FOUND THEN RETURN; END IF;
  -- Статусы без исполнителя. `it_approved` перечислен намеренно: он мёртв в новом коде, но в окне
  -- выката старый код ещё заводит в него заявки, а после выпуска 2 строк с ним не остаётся вовсе.
  IF COALESCE(r.held_from_status, r.status) IN ('new','it_approved','cancelled') THEN RETURN; END IF;
  IF r.service_counterparty_id IS NOT NULL THEN RETURN; END IF;
  SELECT count(*) INTO n FROM service_request_executors WHERE request_id = p_request_id;
  IF n = 0 THEN
    RAISE EXCEPTION 'Заявка % в рабочем статусе осталась без исполнителя', p_request_id;
  END IF;
END $$ LANGUAGE plpgsql;

-- Две обёртки, потому что стороны две и вход у них разный. Объявляются явно: `CREATE TRIGGER`
-- принимает только функцию `RETURNS trigger`, и «функция по идентификатору» сама триггером быть
-- не может.
CREATE FUNCTION service_requests_executor_present_trg() RETURNS trigger AS $$
BEGIN
  PERFORM service_request_executor_present(NEW.id);
  RETURN NULL;                                   -- AFTER-триггер: значение не используется
END $$ LANGUAGE plpgsql;

-- Слушает и UPDATE: прямой `UPDATE … SET request_id = …` перевесил бы исполнителя на другую заявку
-- и оставил прежнюю без единого — проверяются ОБЕ стороны. Через маршрут такого пути нет, но
-- инвариант обязан держаться и против скрипта.
CREATE FUNCTION service_request_executors_present_trg() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN PERFORM service_request_executor_present(OLD.request_id); END IF;
  IF TG_OP <> 'DELETE' THEN PERFORM service_request_executor_present(NEW.request_id); END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER service_requests_executor_present
  AFTER INSERT OR UPDATE OF status, held_from_status, service_counterparty_id ON service_requests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION service_requests_executor_present_trg();

CREATE CONSTRAINT TRIGGER service_request_executors_present
  AFTER INSERT OR UPDATE OR DELETE ON service_request_executors
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION service_request_executors_present_trg();

ALTER TABLE service_requests           ENABLE ALWAYS TRIGGER service_requests_executor_present;
ALTER TABLE service_request_executors  ENABLE ALWAYS TRIGGER service_request_executors_present;
```

Отложенные, а не немедленные: «сняли последнего исполнителя и вернули статус в „Новую“» — законная
операция, и немедленная проверка отбила бы её на первом шаге.

**M5 — `0179_service_request_requester_and_replacement.sql`**

```sql
ALTER TABLE service_requests
  ADD COLUMN requester_department_id   uuid REFERENCES departments(id)          ON DELETE RESTRICT,
  ADD COLUMN requester_object_id       uuid REFERENCES construction_objects(id) ON DELETE RESTRICT,
  ADD COLUMN requester_department_name text NOT NULL DEFAULT '',
  ADD COLUMN requester_object_name     text NOT NULL DEFAULT '',
  ADD COLUMN replacement_recommended   boolean NOT NULL DEFAULT false;

-- Подразделение заявителя — ЛИБО отдел, ЛИБО площадка, и ссылка со снимком названия ходят парой:
-- заполненный идентификатор без названия означал бы снимок, который ничего не помнит (Н11).
-- Обе пары пустые тоже законны — так выглядят заявки, заведённые до этого выпуска и в его окне.
ALTER TABLE service_requests ADD CONSTRAINT service_requests_requester_place_check CHECK (
  NOT (requester_department_id IS NOT NULL AND requester_object_id IS NOT NULL)
  AND (requester_department_id IS NOT NULL) = (btrim(requester_department_name) <> '')
  AND (requester_object_id     IS NOT NULL) = (btrim(requester_object_name)     <> '')
);

-- Пометка «рекомендована замена» существует только у отменённой заявки: она объясняет,
-- почему заявку закрыли без ремонта (Н3). Возврат отменённой в «Новую» снимает пометку —
-- это делает матрица сброса `serviceResetOnTransition`, и без неё откат упрётся в это ограничение.
ALTER TABLE service_requests ADD CONSTRAINT service_requests_replacement_check
  CHECK (NOT replacement_recommended OR status = 'cancelled');
```

**Что к этой миграции обязан сделать код** (правка после ревью; без этого новые заявки будут
писаться с обеими пустыми парами и станут неотличимы от заявок до выпуска):

- **подразделение проставляет сервер, а не клиент.** Источник — учётка `created_by` (В25): её отдел,
  а если отделов у неё нет — её площадка. Клиент прислать чужое подразделение не может;
- **если привязок несколько** (у учётки два отдела или две площадки), контракт создания требует
  выбор — поле `requesterDepartmentId` либо `requesterObjectId`, — и сервер **проверяет
  принадлежность** выбранного самому заявителю, отвечая 422 на чужое. Единственная привязка
  подставляется без вопроса;
- **привязок нет вовсе** (роль без отдела и без площадки — например, администратор портала): обе
  пары остаются пустыми, и это законно. Такой случай в тесте назван явно, чтобы «пусто» не читалось
  как дефект;
- **названия пишутся снимком** в той же транзакции, из справочника, а не из тела запроса.

**M5а — `0180_service_request_assigned_mail_kind.sql`** *(в первой редакции плана её не было —
дыра, найденная волной В3)*

Значение `service_request_assigned` в pg-enum `mail_kind`. Отдельной миграцией и без использования в
той же транзакции: раннер применяет файл целиком одной транзакцией, а PostgreSQL не разрешает
пользоваться новым значением enum до её фиксации (приём миграций `0142`, `0122`, `0114`, `0103`).
Без неё письмо о назначении не вставляется в журнал — `mail_messages.kind` этого вида не знает.

**M6 — `0183_office_equipment_grants_catalog.sql`** *(номер по факту создания)*

Каталог полномочий: переименование и пересборка состава двух существующих наборов, заведение
третьего (§7.2). Пишется по образцу
[`0153_role_grants_catalog.sql`](../apps/api/drizzle/0153_role_grants_catalog.sql): `INSERT` в
`grants`, состав через `grant_permissions`, совместимые роли через `grant_roles`. Коды существующих
наборов не трогаются ни при каких условиях. Назначений (`user_grants`) миграция не создаёт.

**M7 — `0184_releases_service_desk.sql`** — запись выпуска 1 в `app_releases` (ADR 0077): `seq` и
версия берутся по факту на момент коммита, как в `0170`.

### Выпуск 2 (contract)

**Номера в именах ниже намеренно не проставлены.** Ориентир, стоявший здесь при написании плана
(`0185`–`0187`), устарел к 24.08.2026 весь: `0185` занял поток вывоза, `0186` — наша же M12
выпуска 3, `0187` — автозапчасти. Номер берётся свободным на момент создания файла и сверяется
прямо перед ним — это правило, а не пожелание (§13).

**M8 — `<номер>_service_request_dead_statuses.sql`**

```sql
-- Перевод остатка. Выполняется, когда старого кода в проде уже нет (§11.3).
UPDATE service_requests SET status = 'new'     WHERE status = 'it_approved';
UPDATE service_requests SET status = 'in_work' WHERE status = 'diagnostics';

-- Заморозка: значения ПРЕОБРАЗУЮТСЯ, а не очищаются. `service_requests_hold_check` требует
-- непустой `held_from_status` у заявки в `on_hold`, и NULL здесь уронил бы миграцию.
UPDATE service_requests SET held_from_status = 'new'     WHERE held_from_status = 'it_approved';
UPDATE service_requests SET held_from_status = 'in_work' WHERE held_from_status = 'diagnostics';

-- Перевод без запрета — половина работы: значения остаются в типе, и любой прямой `UPDATE`,
-- скрипт или забытая legacy-ветка вернут заявку в мёртвый статус. Ограничение закрывает дверь.
ALTER TABLE service_requests ADD CONSTRAINT service_requests_dead_status_check CHECK (
  status NOT IN ('it_approved','diagnostics')
  AND (held_from_status IS NULL OR held_from_status NOT IN ('it_approved','diagnostics'))
);
```

Значения enum остаются в типе: удаление значения означает пересоздание типа со всеми зависимостями
(колонки, `CHECK`и, индексы) при нулевом выигрыше. Прецедент — `due_date` после ADR 0125. Дверь
закрывает `CHECK`, а не отсутствие значения.

**M9 — `<номер>_service_request_acceptance_contract.sql`**

```sql
-- Принятые в окне выката выпуска 1 — источник у них не проставлен.
UPDATE service_requests SET acceptance_source = 'human'
 WHERE accepted_at IS NOT NULL AND acceptance_source IS NULL;

-- Откаченные в окне выката выпуска 1 — старый код очистил `accepted_by/at`, но не знал про
-- источник, и он остался от прежней приёмки. Без этой строки ограничение ниже упадёт на накате.
UPDATE service_requests SET acceptance_source = NULL WHERE accepted_at IS NULL;

ALTER TABLE service_requests DROP CONSTRAINT service_requests_acceptance_source_check;
ALTER TABLE service_requests ADD CONSTRAINT service_requests_acceptance_source_check CHECK (
  (accepted_at IS NULL) = (acceptance_source IS NULL)
  AND (acceptance_source IS NULL OR acceptance_source IN ('human','auto'))
  AND (acceptance_source <> 'auto' OR accepted_by IS NULL)
  -- Автор без приёмки невозможен. Обратное направление старой парной проверки сохраняется: она
  -- запрещала «кто-то принял, но когда — неизвестно», и это по-прежнему бессмыслица. Ослаблено
  -- ровно одно направление — принятая заявка без автора (уволенный сотрудник, автозакрытие).
  AND (accepted_by IS NULL OR accepted_at IS NOT NULL)
);
```

Ограничение только **дополняется** связкой «источник есть ровно у принятой» — то, что нельзя было
поставить в выпуске 1 (§3, п. 2). Требования «у принятой человеком есть автор» здесь нет по той же
причине, что в M2: ссылка на автора обнуляется при удалении учётки.

**M10 — `<номер>_service_request_it_signature_guard.sql`**

```sql
-- Подпись ИТ, которую ЗАПИСЫВАЮТ или МЕНЯЮТ после этого выпуска, обязана нести ревизию — и ту
-- самую, на которой её ставят. Старые строки не затрагиваются: правило сформулировано про
-- изменение, а не про состояние (Н3).
CREATE FUNCTION service_requests_it_signature_guard() RETURNS trigger AS $$
DECLARE signature_changed boolean;
BEGIN
  signature_changed := TG_OP = 'INSERT'
    OR NEW.it_approved_at IS DISTINCT FROM OLD.it_approved_at
    OR NEW.it_approved_by IS DISTINCT FROM OLD.it_approved_by;

  -- 1. Ревизию НЕЛЬЗЯ подвинуть в одиночку. Без этой ветки старую визу можно было бы сделать
  --    действующей одним `UPDATE … SET it_approved_estimate_revision = estimate_revision`: подпись
  --    та же, ревизия непустая — и все прежние проверки её пропускали.
  IF TG_OP = 'UPDATE'
     AND NEW.it_approved_estimate_revision IS DISTINCT FROM OLD.it_approved_estimate_revision
     AND NOT signature_changed THEN
    RAISE EXCEPTION 'Ревизия визы ИТ меняется только вместе с самой подписью';
  END IF;

  IF NEW.it_approved_at IS NOT NULL AND signature_changed THEN
    -- 2. Подпись без ревизии — «входная виза старого образца», и завести такую после cutover
    --    нельзя.
    IF NEW.it_approved_estimate_revision IS NULL THEN
      RAISE EXCEPTION 'Виза ИТ записывается только вместе с ревизией сметы';
    END IF;
    -- 3. Подписывают ТЕКУЩУЮ смету, а не любую прошлую: равенство, а не «не больше». Ослабнет оно
    --    до `<=` — и подпись можно будет поставить на позапрошлую ревизию, оставив нынешнюю
    --    несогласованной.
    IF NEW.it_approved_estimate_revision <> NEW.estimate_revision THEN
      RAISE EXCEPTION 'Виза ИТ ставится на текущую ревизию сметы';
    END IF;
  END IF;

  -- 4. Снятие подписи чистит и ревизию: «ревизия без подписи» ничего не означает (это же требует
  --    `CHECK` из M1, здесь — на пути записи).
  IF NEW.it_approved_at IS NULL AND NEW.it_approved_estimate_revision IS NOT NULL THEN
    RAISE EXCEPTION 'Ревизия визы ИТ остаётся без подписи';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER service_requests_it_signature_guard
  BEFORE INSERT OR UPDATE ON service_requests
  FOR EACH ROW EXECUTE FUNCTION service_requests_it_signature_guard();
ALTER TABLE service_requests ENABLE ALWAYS TRIGGER service_requests_it_signature_guard;
```

`ENABLE ALWAYS` — отдельной командой: в `CREATE TRIGGER` такого слова нет, а на реплике-приёмнике
обычный триггер не срабатывает. То же относится ко всем триггерам этого плана.

**M11** — запись выпуска 2.

### Выпуск 3 (заявки на расходники)

Порядок здесь связан с планом расходников, и его нельзя переставить. Ссылка журнала на строку
заявки не может быть внешним ключом в момент, когда таблицы строк ещё нет, — поэтому она приезжает
в два приёма:

1. **миграция справочника** (правка §2.1) заводит в журнале `entry_kind`, `service_request_id` с
   `FK` на заявки (эта таблица уже существует) и `service_request_consumable_id` — **nullable uuid
   без внешнего ключа**;
2. **M12** создаёт таблицу строк и **достраивает** ключ.

**M12 — `service_request_consumables` и ключ журнала**

```sql
CREATE TABLE service_request_consumables (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id         uuid NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  consumable_id      uuid NOT NULL REFERENCES office_equipment_consumables(id) ON DELETE RESTRICT,
  requested_quantity integer NOT NULL,
  -- Сколько числится выданным. NULL — работу ещё не закрывали; 0 — закрыли, но не выдали (В9б).
  issued_quantity    integer,
  issue_note         text NOT NULL DEFAULT '',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_request_consumables_requested_check CHECK (requested_quantity > 0),
  CONSTRAINT service_request_consumables_issued_check    CHECK (issued_quantity IS NULL OR issued_quantity >= 0),
  -- Любое расхождение факта с запрошенным объясняется причиной — и выдача сверх заявки (В9а), и
  -- недодача, и ноль («съездили, тонер оказался цел», В9б). Совпал факт с заявкой — объяснять
  -- нечего.
  CONSTRAINT service_request_consumables_note_check CHECK (
    issued_quantity IS NULL OR issued_quantity = requested_quantity OR btrim(issue_note) <> ''
  ),
  CONSTRAINT service_request_consumables_unique UNIQUE (request_id, consumable_id),
  -- Цель ключа: адресат составного FK журнала (ниже).
  CONSTRAINT service_request_consumables_row_unique UNIQUE (id, request_id, consumable_id)
);
CREATE INDEX service_request_consumables_request_idx ON service_request_consumables (request_id);

-- Событие журнала ссылается на строку заявки — и ключ СОСТАВНОЙ, чтобы «списано по заявке СО-1234,
-- позиция Ricoh 201» не могло указывать на строку другой заявки или другого расходника. Копии
-- реквизитов родителя в дочерней строке — приём ADR 0007 §2; режим `ON UPDATE` — «замок»
-- (умолчание): ни идентификатор строки, ни её заявка, ни её позиция не меняются никогда.
ALTER TABLE office_equipment_consumable_stock_entries
  ADD CONSTRAINT office_equipment_consumable_stock_row_fk
  FOREIGN KEY (service_request_consumable_id, service_request_id, consumable_id)
  REFERENCES service_request_consumables (id, request_id, consumable_id)
  ON DELETE RESTRICT;
```

**Симметрия со складом: `issued_quantity` тоже не правится мимо события** (правка после ревью).
Остаток расходника уже закрыт от прямого `UPDATE` отложенным триггером `…stock_covered`
([0172](../apps/api/drizzle/0172_office_equipment_consumables.sql)); оставить строку заявки без
такой же двери значило бы завести асимметрию, где одна половина учёта защищена схемой, а вторая —
вежливостью маршрута.

Поэтому M12 ставит **два отложенных constraint-триггера на одну функцию** — приём M4, и по той же
причине: у инварианта две стороны, и односторонний триггер закрывает только половину дверей.

- на `service_request_consumables` (`AFTER INSERT OR UPDATE OF issued_quantity`) — ловит прямую
  правку факта без события;
- на `office_equipment_consumable_stock_entries` (`AFTER INSERT`, по `NEW.service_request_consumable_id`,
  когда он не пуст) — ловит обратное: транзакцию, которая **подвинула склад законным `issue`, но не
  изменила факт** в строке заявки. Без этой стороны триггер строки просто не сработал бы — её никто
  не трогал.

Проверка одна на оба входа: к концу транзакции `issued_quantity` строки равно сумме `issue` минус
`return` по её событиям (пустой набор событий законен только при `NULL` или нуле). Функция читает
состояние по идентификатору строки, а не по снимку ряда, — тот же приём и та же причина, что у
покрытия остатка: две правки факта в одной транзакции иначе дают ложный отказ.

Составной ключ дописывается в `EXPECTED` теста
[schema-copy-keys.test.ts](../apps/api/test/schema-copy-keys.test.ts) с режимом «замок» — иначе тест
упадёт, требуя назвать род копии.

Ключ срабатывает только у событий, порождённых заявкой. У ручной правки остатка `consumable_id`
заполнен всегда — это же событие склада, — а обе ссылки на заявку пусты; составной внешний ключ в
режиме `MATCH SIMPLE` (умолчание Postgres) при `NULL` в **любой** своей части не проверяется вовсе,
и ручная правка проходит мимо него. Это ровно то поведение, которое здесь нужно, и держится оно
умолчанием — `MATCH FULL` в этом ключе означал бы обратное и его писать нельзя.

**M13** — запись выпуска 3.

## 6. Матрица «вид × статус × субъект × действие»

Субъекты: **З** — заявитель (роль с правами заказчика модуля), **В** — «Оргтехника: ведение»,
**И** — «Оргтехника: ИТ-служба», **С** — сервисная компания (оператор контрагента), **А** —
администратор портала (`requests.rollbackStatus`).

Две пометки значат разное, и в обеих матрицах применяются одинаково:

- **И\*** — учётка **назначена поимённо** (строка в `service_request_executors`) **и** имеет
  `serviceRequests.execute` (§7.1);
- **С\*** — заявка назначена **контрагенту**, оператором которого является этот пользователь;
  поимённой строки и `execute` у него нет и не требуется.

Матрица строится на трёх основаниях, и их нельзя путать:

1. **право** — что субъекту вообще позволено (`serviceRequests.status`, `.assign`, `.approveIt`, …);
2. **факт назначения** — ходы исполнителя (принять в работу, отказаться, предъявить смету, закрыть
   работы) открывает **назначение на эту заявку**, а не право само по себе: ни `status`, ни
   `execute` в одиночку ходов не дают. У поимённого исполнителя назначение работает **в паре с**
   `serviceRequests.execute` (§7.1), у сервисной компании — само по себе, потому что назначена она
   целиком. Поэтому свой сисадмин и подрядчик делают одно и то же одними и теми же ручками;
3. **статус** — коридор, из которого ход вообще возможен.

### 6.1. Ремонт (`kind = 'repair'`)

| Статус | Действие | Кто | Результат |
| --- | --- | --- | --- |
| Новая | править заявку | З, В | остаётся «Новой» |
| Новая | удалить (в архив) | З, В | архив; у заказчика право `serviceRequests.delete` есть с ADR 0085 |
| Новая | назначить исполнителей | В, И | «Назначена» |
| Новая | срочность | В | флаг |
| Новая | отменить (причина) | В | «Отменена»; заказчик просит отменить, но сам ход не делает — у него нет `serviceRequests.status` |
| Новая | отложить (причина) | В, И | «Отложена» |
| Назначена | принять в работу | И\*, С\* | «В работе» |
| Назначена | отказаться (причина) | И\* | снимается строка отказавшегося; исполнителей не осталось → «Новая» |
| Назначена | отказаться (причина) | С\* | снимается **вся компания**: поимённых строк у сервиса нет (§4.2) |
| Назначена | переназначить (причина) | В, И | «Назначена», возраст статуса обнуляется |
| Назначена | удалить (в архив) | В | архив (В20); заказчику на этом шаге удаление уже недоступно |
| Назначена | отменить | В | «Отменена» |
| Назначена | отложить · возобновить | В, И | «Отложена» → прежний статус; у ИТ-службы своё право `serviceRequests.hold` |
| В работе | предъявить смету | И\*, С\* | «Смета на согласовании», ревизия +1 |
| В работе | закрыть работы | И\*, С\* | «Решена»; сервису — только с закрывающим документом |
| В работе | переназначить · отложить · возобновить | В, И | см. выше |
| В работе | отменить | В | «Отменена» |
| Смета на согласовании | виза ИТ «чинить» | И | подпись с ревизией; статус не меняется |
| Смета на согласовании | «менять аппарат» (причина) | И | «Отменена» + `replacement_recommended`; это **второй исход той же ручки визы**, а не общее право отменять |
| Смета на согласовании | согласовать сумму | В | «В работе» — только после визы ИТ текущей ревизии |
| Смета на согласовании | отклонить смету (причина) | В | «В работе», подписи текущей ревизии обесценены |
| Решена | принять | В | «Закрыта», `acceptance_source = 'human'` |
| Решена | автозакрытие через сутки | система | «Закрыта», `acceptance_source = 'auto'` |
| Решена | вернуть на доработку (причина) | В | «В работе» |
| Решена | отложить · возобновить | В, И | «Отложена»; снимает заявку с автозакрытия, пока идёт разбирательство (Р106 ADR 0125) |
| Отложена | возобновить | В, И | статус из `held_from_status` |
| Отложена | отменить | В | «Отменена» |
| В работе · Решена · Закрыта | подшить закрывающий документ | И\*, С\*, В | файл добавляется, статус не меняется; в «В работе» это путь к «Решена» у сервиса, в «Решена» — досылка бумаги по заявке-наследию |
| любой рабочий | комментарий | З, В, И, С\* | запись в истории |
| Отменена, Закрыта | откат на шаг назад | А | по таблице откатов |

### 6.2. Расходники (`kind = 'consumable'`)

Та же таблица без строк сметы и без визы ИТ. Отличия:

| Статус | Действие | Кто | Результат |
| --- | --- | --- | --- |
| Новая | завести заявку | любой, у кого есть техника в области (В15) | строки номенклатуры обязательны |
| В работе | правка «выдано» | И\*, С\*, В | событие журнала на разницу (Р6) |
| В работе | закрыть работы | И\*, С\* | «Решена», списание по факту; закрывающий документ не требуется (предикат §7.1 требует `kind = 'repair'`) |
| Решена | автозакрытие через сутки | система | «Закрыта» |
| Решена | правка «выдано» | И\*, С\*, В | разрешена до «Закрыта» (Р6) |
| Закрыта | правка «выдано» | никто | склад правится только вручную, с правом `…stock` |

**Два статуса в этой таблице — это ровно то, что спрашивает сервер.** Ручка правки выдачи перечисляет `in_work` и `done` поимённо, а не проверяет «лишь бы не закрыта»: последнее пускало ход из «Новой» и «Назначена» и списывало со склада по заявке, которую ещё никто не взял в работу (держателю `serviceRequests.status` назначение не требуется). Отложенная закрыта тем же правилом, что и правка состава — Р110. Сметный круг у расходников заперт с обратной стороны: все пять ручек сметы отбивают `kind = 'consumable'` — «та же таблица без строк сметы» держится сервером, а не тем, что портал не рисует кнопку.

**Коридор `serviceRequests.hold`** (правка после ревью и уточнение после В1): право открывает
заморозку и возобновление из **любого рабочего статуса**, включая **«Решена»**, и не открывает
ничего в «Закрыта» и «Отменена».

«Решена» в этом списке — не небрежность: Р106 ADR 0125 разрешил откладывать её прямо («ждём акт от
сервиса»), и сужение было бы изменением сегодняшнего поведения, которого никто не просил (§3, п. 1).
Вдобавок это **единственный способ остановить автозакрытие руками**: у отложенной заявки статус
`on_hold`, а отбор берёт только `done`, — заморозка снимает её с очереди, пока идёт разбирательство.
Держатели — «Ведение» и «ИТ-служба», и в матрице выше это должно читаться одинаково в каждой строке;
контрактный тест перечисляет **все** разрешённые статусы поимённо, а не проверяет один и
предполагает остальные.

### 6.3. Что запрещено всем

- **Сервис** не ставит срочность (нет `serviceRequests.urgency`), не заводит и не правит заявки, не
  видит чужие.
- **ИТ-служба** не удаляет заявки, не принимает работу и не отменяет заявки произвольно: у неё нет
  `serviceRequests.status`. Единственная её отмена — исход визы «менять аппарат», и он приходит
  правом `serviceRequests.approveIt`, как сегодня приходит отказ ИТ на входе.
- **Заявитель** статусов не двигает вовсе: у роли заказчика нет `serviceRequests.status`. Он заводит,
  правит и удаляет свою «Новую» заявку.
- **Строки журнала остатка** не правит никто — они неизменяемы (Р11 плана расходников).

---

## 7. Контракты и код

### 7.1. `packages/contracts`

- `service-requests.ts`: подписи статусов (`assigned` → «Назначена», `done` → «Решена», `accepted` →
  «Закрыта»); четыре коридора переписаны под единый цикл; `serviceWaitingOn` принимает **строку
  заявки**, а не статус (Н3) — от неё зависят очередь «Ждут меня», подпись «Вам: …», бейдж раздела и
  адресаты писем; `isServiceRequestDeletable(status)` заводится отдельно от
  `isServiceRequestEditable` (В20); предикат `serviceRequestNeedsClosingDocument(request)` —
  единственное место, где живёт правило `kind = 'repair' AND service_counterparty_id IS NOT NULL`.
- `permission-catalog.ts` / `permissions.ts`: **пять** новых прав — `serviceRequests.urgency`,
  `serviceRequests.hold`, `serviceRequests.execute`, `officeEquipmentConsumables.manage`,
  `officeEquipmentConsumables.stock`.
- `grants.ts`, `PERMISSION_REQUIRES`: `serviceRequests.execute` объявляется зависимым от
  `serviceRequests.read`. Во встроенном наборе ИТ-службы чтение и так есть, но набор собирает
  администратор — и без этой строки барьер выдачи пропустил бы набор, которым человека можно
  назначить на заявку, невидимую ему самому. Права номенклатуры объявлены там же и по той же
  причине (§2.1).

  Почему `hold` отдельным правом, а не «даём ИТ-службе `serviceRequests.status`»: право `status`
  открывает **весь операторский коридор** — приёмку работы, отмену из любого статуса, согласование
  сметы. ИТ-службе по матрице (§6) положены только заморозка и возобновление, поэтому заморозка
  выносится в своё право, а `status` остаётся у «Ведения».

  **Ходы исполнителя не открываются правом в одиночку** — их открывает факт назначения на заявку
  (§6, п. 2), а у поимённого исполнителя — назначение вместе с `serviceRequests.execute`. Это то,
  что позволяет одному коду обслуживать и своего сисадмина, и сервисную компанию.

  **Кого можно назначить поимённо — отдельный вопрос, и у него должен быть однозначный ответ**
  (правка после ревью). Ручка `PUT /:id/executors` принимает список учёток, а назначение само
  открывает статусные действия: без ограничения администратор мог бы назначить исполнителем
  заказчика и тем выдать ему ходы, которых нет ни в одном наборе. Поэтому заводится **пятое право —
  `serviceRequests.execute`**: «может быть назначен исполнителем заявки оргтехники». Оно входит в
  набор «Оргтехника: ИТ-служба» и проверяется сервером при назначении: учётка без него — 422 с
  именем человека.

  **Право относится только к поимённому слою, и сервису оно не выдаётся** — это выбор, а не
  умолчание. У сервисной компании назначается **не человек, а контрагент**, и критерий выбора там
  другой: активная компания типа `service`. Учётки её сотрудников портал не перечисляет вовсе (Н5),
  поэтому требовать от них право, которого нет в `COUNTERPARTY_TYPE_PERMISSIONS.service`, значило бы
  либо отобрать у подрядчика ходы, либо дописать ему право ради проверки, которая для него не
  выполняется ни при каком назначении.

  Отсюда предикат хода исполнителя — **дизъюнкция двух признаков**, и записывается он в одном месте:

  > ход исполнителя доступен, если **заявка назначена моей компании** (оператор контрагента типа
  > `service`) **либо** я значусь в `service_request_executors` **и** имею `serviceRequests.execute`.

  Вторая половина даёт то, ради чего право заводилось: у переведённого сотрудника снятие набора
  закрывает ходы, не трогая историю назначений. Первая оставляет подрядчику ровно сегодняшнее
  поведение.
- `grants.ts`: четвёртый список кодов — `MODULE_GRANT_CODES` — рядом с `SYSTEM_GRANT_CODES`,
  `ADMIN_GRANT_CODES` и `ROLE_GRANT_CODES`, и включение его в `ALL_SYSTEM_GRANT_CODES`. В
  `SYSTEM_GRANT_CODES` новый код добавить **нельзя**: тот список объявлен
  `satisfies readonly RoleAddon[]` и принимает только коды перенесённых надстроек.
- `office-equipment-consumables.ts` (создаётся планом расходников): строки заявки и отчёт по расходу.

### 7.2. Состав наборов полномочий

Коды существующих наборов **не меняются ни при каких условиях**: по коду набор находят миграции
каталога и таблица сквозной области `GRANT_MODULE_WIDE_SCOPE`. Меняются название, описание и состав.

| Код (неизменяем) | Новое название | Состав |
| --- | --- | --- |
| `office_equipment_operator` | Оргтехника: ведение | `officeEquipment.read`, `officeEquipment.write`, `serviceRequests.read`, `.create`, `.update`, `.delete`, `.assign`, `.approveEstimate`, `.status`, `.hold`, `.urgency`, `.files` |
| `office_equipment_it_approver` | Оргтехника: ИТ-служба | `serviceRequests.read`, `.approveIt`, `.assign`, `.hold`, `.execute`, `.files` |
| `office_equipment_consumables` (новый) | Оргтехника: номенклатура | `officeEquipmentConsumables.manage`, `officeEquipmentConsumables.stock` |

Сквозная область модуля остаётся за `office_equipment_it_approver` — она нужна для визы и держится
кодом набора, а не его составом.

**Совместимые роли (`grant_roles`) — их миграция обязана вставить, и по правам они не выводятся**
(правка после ревью). У двух существующих наборов в базе стоят `shtab` и `department`
([0145](../apps/api/drizzle/0145_permission_grants.sql)); реформа доступа добавила к ним `site`
(ADR 0113), и новый набор получает тот же список: **`shtab`, `site`, `department`**. Список — **бизнес-решение**: номенклатуру ведут там же, где оргтехнику, — на площадке и в отделе.
Ролей с `officeEquipment.read` в портале больше (менеджер, диспетчер, руководитель строительства,
руководитель отдела, наблюдатель), и требование чтения их не отсеивает — оно лишь проверяет, что
**каждая из перечисленных** ему удовлетворяет: выдать набор роли без чтения барьер не даст, и такая
строка `grant_roles` означала бы обещание, которого проверка выдачи не выполнит.

**Где сегодня живёт состав двух существующих наборов — и почему это меняет порядок волн** (найдено
при реализации В1). Для кодов `office_equipment_operator` и `office_equipment_it_approver`
объявленный состав лежит **не** в `grants.ts`, а в `ROLE_ADDON_PERMISSIONS`; название — в
`roleAddonLabels`, совместимые роли — в `ROLE_ADDON_BASE_ROLES` (`role-addons.ts`). Оттуда же строит
ожидание страж `grants-catalog.db.test.ts`. Причина историческая: надстройки на шагах 1a–1d реформы
доступа (ADR 0106) остаются **живым источником доступа**, и набор в базе — их отражение.

Отсюда два следствия, и оба обязательны:

1. **Состав расширяется синхронно** — `ROLE_ADDON_PERMISSIONS` и каталог правятся одной волной,
   вместе со стражем. Разъехавшись, они дали бы одному человеку разные права в зависимости от того,
   пришёл к нему доступ надстройкой или набором.
2. **Каталог едет после ручек, а не до них.** Дописать ИТ-службе `hold`, `execute` и остальное
   раньше, чем появятся сами ручки (В3, В4), значит выдать право, открывающее маршрут, которого ещё
   нет. Поэтому волна В5 идёт **после** В3 и В4 — в §9 и §10 это закреплено зависимостью, хотя
   раньше этап 6 значился независимым.

Новый код заводится **четвёртым списком** `MODULE_GRANT_CODES` (§7.1) и включается в
`ALL_SYSTEM_GRANT_CODES`. Миграция каталога пишется по образцу
[`0153_role_grants_catalog.sql`](../apps/api/drizzle/0153_role_grants_catalog.sql): `INSERT` в
`grants`, состав через `grant_permissions`, совместимые роли через `grant_roles`. Назначений
(`user_grants`) миграция не создаёт — набор выдаёт администратор портала поимённо, и выдача остаётся
строкой с автором и временем.

### 7.3. `apps/api`

Ручки, которые появляются:

| Ручка | Право | Что делает |
| --- | --- | --- |
| `PUT /service-requests/:id/executors` | `serviceRequests.assign` | назначает исполнителей: список учёток + контрагент; заменяет `PATCH /:id/service` |
| `PATCH /service-requests/:id/urgency` | `serviceRequests.urgency` | было `serviceRequests.update` |
| `PATCH /service-requests/:id/hold` · `/resume` | `serviceRequests.hold` **или** `serviceRequests.status` — предикатом контрактов `canHoldService`, а не проверкой права в маршруте | было только `serviceRequests.status` |
| `PATCH /service-requests/:id/it-approval` | `serviceRequests.approveIt` | два исхода: виза с ревизией либо «менять аппарат» (отмена с пометкой) |
| `PUT /service-requests/:id/consumables` | `serviceRequests.update` | строки заявки (выпуск 3) |
| `PATCH /service-requests/:id/consumables/issued` | назначенный исполнитель **либо** `serviceRequests.status` | правка факта выдачи (выпуск 3) |
| `POST /internal/service-requests/auto-close` | внутренний токен | пакет автозакрытия |
| `GET /office-equipment-consumables/usage-report` | `officeEquipment.read` | расход за период с выгрузкой |
| `GET /service-requests/executor-candidates` | `serviceRequests.assign` | кандидаты в поимённые исполнители (заведена в В6: `GET /users` закрыт `users.manage`, которого нет ни у «Ведения», ни у ИТ-службы — поле выбора заполнялось бы только у администратора портала) |

**Текст ошибки у отката приёмки поменяется** (найдено в В2): откат `accepted → done` невозможен,
если по тому же аппарату уже висит другая открытая заявка того же вида, — поведение прежнее
(предикат индекса не менялся), но `23505` теперь называет `service_requests_open_repair_unique` или
`…_open_consumable_unique` вместо снятого общего. Если маршрут отката где-то разбирает имя индекса
или показывает его человеку, В3 обязана это поправить.

**`/estimate/reopen` сохраняет свою роль, а не «становится повторным предъявлением»** (уточнение
после В3: прежняя формулировка была неисполнима буквально). Повторное предъявление — это и есть
`/estimate/submit` из «В работе», второй дуги в «Смету на согласовании» контракты не допускают. А
оставить `PUT /estimate` открытым в «В работе» безусловно нельзя: состав согласованной ревизии
правился бы под уже стоящими подписями, и закрытие пропустило бы изменённые строки как
согласованные. Поэтому `PUT /estimate` отвечает 409, пока текущая ревизия согласована, а
`/estimate/reopen` **снимает снимок согласования, не меняя статуса** — остаётся единственным путём
изменить согласованную смету. Путь и тело ручки прежние, портал не ломается.

**Планка закрывающего документа снята с приёмки** (Н8 говорит «переезжает», а не «дублируется»).
Следствие: заявку-наследие, стоящую в «Решена» без бумаги, человек примет вручную — автозакрытие её
по-прежнему не берёт. **Портал обязан снять её тем же движением** (найдено в В6): окно приёмки
держало кнопку запертой без документа, и заявка-наследие оставалась без выхода — сервер пропускал,
портал нет. Предупреждение в окне осталось: бумага — повод спросить её у исполнителя, а не повод
запретить приёмку.

**`kind = 'consumable'` API не принимает не запретом, а отсутствием поля** (уточнение после В3):
контракт заведения заявки поля `kind` не имеет вовсе, поэтому отрицательного теста на него до
выпуска 3 не написать — он появится вместе с полем.

**`kind` заводится в `ServiceRequestDto` волной В3, а не В1** (уточнение после В1): контракты
объявили вид заявки и предикат закрывающего документа, но само поле в DTO не завели намеренно —
обязательное поле уронило бы компиляцию API и портала до правки маршрута. Без него портал предикат
вызвать не может, поэтому поле едет вместе с маршрутом, в одной волне с `replacementRecommended`,
`acceptanceSource`, подразделением заявителя и списком исполнителей.

`FILE_KIND_STATUSES` дополняется: `warranty_card` разрешается и в `in_work` — иначе планка Н8
замыкает круг у заявки, чей единственный документ гарантийный талон (§ Н8). Портал считает то же
самое своим `attachableKinds`, и обе стороны обязаны уехать **одним выпуском** — по раскладке волн
API правится в В3, портал в В6, и до конца выпуска 1 они просто не расходятся наружу.

Ручка `PATCH /service-requests/:id/service` **остаётся на выпуск 1 совместимым адаптером** и
удаляется в выпуске 2 (правка после ревью). Причина не в старом коде сервера, а в старом коде
**браузера**: вкладка, открытая до выката, продолжает жить с загруженным JS и звать прежний адрес —
удалив ручку сразу, мы получим 404 на назначении у всех, кто не перезагрузил страницу. Адаптер
принимает прежнее тело (`serviceCounterpartyId`, причина, версия) и меняет **только контрагента**,
не трогая строки поимённых исполнителей: у старой ручки ровно такая семантика, и трактовать её как
«назначить компанию и пустой список людей» нельзя — заявка «свой сисадмин + КопиЛайт», переназначенная
из вчерашней вкладки, молча лишилась бы своего сотрудника. Строка манифеста у адаптера остаётся
прежней; новый портал зовёт только `PUT /:id/executors`, а сам адаптер уходит в выпуске 2.

Каждая новая ручка дописывается в [`lib/access-manifest.ts`](../apps/api/src/lib/access-manifest.ts)
и в фикстуры `test/access-conditions.test.ts` — без этого падают два сквозных теста (грабли ADR 0125).
Внутренняя ручка автозакрытия описывается там же условием `kind: 'internalToken'`, как обе ручки
почтового планировщика.

**Совместимость выпуска 1** (§3, п. 4): коридоры принимают заявки в `it_approved` и `diagnostics` —
из первого доступно то же, что из «Новой», из второго то же, что из «В работе». Ветки помечаются
`// legacy: снимается выпуском 2` и удаляются вместе с M8.

**Причину события журнала пишет сервер, и текст задан здесь.** `reason` в журнале обязателен всегда
(`CHECK` в `0172`), а `issue_note` строки заявки объясняет расхождение факта с запрошенным и при
обычной выдаче пуст — это разные поля, и подставлять одно вместо другого нельзя. Тексты:

- выдача — `Выдано по заявке СО-<num>`;
- возврат — `Возврат по заявке СО-<num>`;
- при непустом `issue_note` он дописывается через двоеточие: `Выдано по заявке СО-1234: привезли
  три вместо двух`.

Номер берётся тот же, что показывает портал (`formatServiceRequestNumber`), — журнал склада читают
рядом с заявкой, и «по заявке 1234» без префикса заставило бы гадать, какого она модуля.

**Ручки исполнителя закрывает страж «одно из прав»** (блокер, найденный в В3). `/start`, `/decline`,
`/estimate`, `/estimate/submit`, `/estimate/reopen`, `/complete`, `/service-comment` исторически
закрыты `serviceRequests.status` либо `.estimate`. Ни того, ни другого у набора «Оргтехника:
ИТ-служба» нет и быть не должно: `.status` открывает весь операторский коридор, `.estimate` — ведение
сметы. Значит поимённый исполнитель упирался бы в стража **раньше**, чем коридор успеет разрешить
ему дугу, и строки матрицы §6 для него не работали бы ни при каком `execute`.

Поэтому заводится седьмой вид условия манифеста — «хотя бы одно из перечисленных прав», и на этих
ручках список становится «то, что было, плюс `serviceRequests.execute`». Страж отвечает только на
вопрос «может ли субъект вообще работать с этой ручкой»; **какая дуга ему доступна, решает коридор**
(`isServiceExecutor`): держатель `execute`, не назначенный на заявку, получает отказ — на шаг позже,
от коридора, а не от стража.

**Заморозку маршрут спрашивает предикатом, а не правом** (уточнение после В1). До выката каталога
наборов (M6, волна В5) «Ведение» приходит носителям **надстройки** `office_equipment_operator`, а в
ней права `hold` нет и появиться не может — надстройка правится той же волной В5. Проверь маршрут
право напрямую — и заморозка отвалится у тех, кто ею пользуется сегодня, на весь промежуток между В3
и В5. Поэтому обе ручки зовут `canHoldService` из контрактов: «есть `hold` **или** есть `status`».
Портал спрашивает ту же функцию — разойдись они, кнопка вела бы в 403.

**Кто правит факт выдачи.** Предикат тот же, что у хода исполнителя (§7.1), и записывается он один
раз на оба случая: *«оператор назначенного контрагента, **либо** поимённый исполнитель с
`serviceRequests.execute`, **либо** обладатель `serviceRequests.status`»*. Первые две ветки — тот,
кто картриджи и вёз; третья — «Ведение», которое разбирает ошибки и доводит заявку за любую сторону
(§6.2). Двух разных ответов на вопрос «чей это ход» быть не должно: ручка, матрица и коридор
исполнителя описывают один предикат, и живёт он одной функцией контрактов.

**Запрет `kind = 'consumable'` в выпуске 1.** Схема принимает вид с M3, но контракт создания заявки
до выпуска 3 не даёт его выбрать: без строк номенклатуры, формы и списания такая заявка была бы
заявкой без предмета. Запрет снимается в выпуске 3 вместе с M12; отрицательный тест держит его до
тех пор.

**Транзакция закрытия заявки на расходники** (Р5): `SELECT … FOR UPDATE` заявки → **строки
складских позиций `office_equipment_consumables` `FOR UPDATE` в порядке возрастания
`consumable_id`** → проверка остатков → `UPDATE` количества и `INSERT` событий журнала на разницу →
смена статуса, история, письма.

**Сортировка идёт по `consumable_id`, а не по `id` строки заявки** (правка после ревью). Первая
редакция сортировала строки заявки — то есть случайные UUID, у каждой заявки свои. Две заявки,
содержащие одни и те же позиции X и Y, при таком порядке спокойно берут их в противоположной
последовательности: конфликт возникает **не на строках заявки, а на карточках склада**, которые
берёт `FOR UPDATE` ещё и триггер цепочки
([0172](../apps/api/drizzle/0172_office_equipment_consumables.sql)). Общий порядок обязан быть у
того, за что дерутся, — у позиции склада, и захватываться она должна маршрутом заранее, до первой
вставки события.

**Письмо о назначении** (Н13): сегодня письма модуля адресуются ящику канала и настроенным копиям
(`module_mail_recipients`), а это письмо адресовано **конкретным учёткам** — назначенным
исполнителям. Значит событие `service_request_assigned` заводится в `MODULE_MAIL_EVENTS`, но список
адресатов у него строится не из таблицы копий, а из строк `service_request_executors` и адреса
оператора контрагента, если назначена сервисная компания. Копии из таблицы работают как у остальных
событий — поверх, а не вместо; если ни одного адресата-исполнителя нет, письмо не уходит вовсе
(исход `no_recipients`), а не превращается в письмо службе.

**Письмо уходит только тем, кого назначили этим действием** (решение принято в В3): маршрут передаёт
дельту, а не весь состав. Иначе при каждом переназначении сервиса свои сисадмины, давно работающие
по заявке, получают повторное «вам назначено».

**Автозакрытие** (Н7): worker раз в 5 минут зовёт внутреннюю ручку; ручка отбирает заявки в «Решена»
пачкой с `FOR UPDATE SKIP LOCKED`, проверяет условия на момент вызова и закрывает. Размер пачки —
параметр конфигурации; на первом прогоне ставится уменьшенным.

Уточнения после В4:

- **пачка ограничивает нагрузку на базу и журнал аудита, а не рассылку** — письма о закрытии в
  модуле нет вовсе, и прежняя формулировка про «всплеск писем» была неверной;
- **пачка обязана переживать негодную строку**: инвариант исполнителя (M4) — отложенный
  constraint-триггер, он срабатывает на `COMMIT`, и одна не проходящая проверку заявка уронила бы
  `COMMIT` всей пачки — снова и снова, потому что отбор идёт от самых старых. Поэтому транзакция
  начинается с `SET CONSTRAINTS ALL IMMEDIATE`, а каждая заявка закрывается под своей точкой
  сохранения. Без этого автозакрытие встало бы навсегда и молча;
- **«сутки» — ровно 24 часа**, а не «следующий календарный день по Москве»: разница видна на
  границе, и тест её проверяет;
- **`updated_by` у автоматически закрытой заявки пуст**, как и `accepted_by`: оставить там прежнего
  человека значило бы записать закрытие на того, кто последним правил заявку.

**Срок считается по-разному у тех, кому документ обязателен, и у остальных:**

```sql
CASE WHEN kind = 'repair' AND service_counterparty_id IS NOT NULL   -- предикат Н8, один на текст
     THEN GREATEST(completed_at, <MIN(attached_at) по закрывающим документам заявки>)
     ELSE completed_at
END
```

Безусловный `GREATEST` был бы ошибкой (правка после ревью): к инхаус-ремонту или к заявке на
картриджи документ **не требуется**, но подшить его никто не мешает — и приложенный после «Решена»
счёт отодвинул бы закрытие заявки, которой бумага вообще не нужна. Сдвиг уместен ровно там, где
документ и держал переход.

**Первого документа, а не последнего.** Доплатный счёт, присланный через неделю после акта, сдвигал
бы `MAX` и отодвигал закрытие каждый раз заново — заявка, по которой всё привезли и приняли, висела
бы открытой из-за бумажного хвоста.
`completed_at` ставит переход в «Решена» и переписывает на **каждом** таком переходе: возврат на
доработку и повторное закрытие отсчитывают сутки заново — окно на возражение открывается после
последнего предъявления работы, а не после первого.

Второе слагаемое — не украшение и не противоречие первому, хотя у **новых** заявок оно никогда не
срабатывает: у сервисного ремонта документ обязан лежать до «Решена» (Н8), а остальным он не нужен,
и позднейшим всегда оказывается сам переход. Живёт правило ради **наследия**: заявка сервиса,
уехавшая в «Решена» без бумаги до выпуска 1, отбором не берётся (ниже), но, как только акт по ней
подошьют, она станет закрываемой — и закрыть её той же секундой значило бы отдать сутки на
возражение, которых никто не видел. Отсюда тест на этот единственный случай (§8, тест 2).

**Заявки без обязательного документа отсекаются условием отбора, а не проверкой после выборки**
(правка после ревью). Такие строки существуют: до выпуска 1 планка стояла только на приёмке, и
внешний ремонт мог уехать в «Решена» без бумаги. Возьми их отбор в пачку и отсей потом — они займут
её целиком и будут вытеснять законные заявки каждый прогон, а закрытия не случится ни у кого.
Предикат отбора поэтому повторяет `serviceRequestNeedsClosingDocument` на SQL: «либо документ не
требуется, либо он есть».

### 7.4. `apps/web`

Поле «Исполнители» с множественным выбором в окне заявки и колонкой списка (Н6); форма заявки на
расходники с подстановкой позиций по модели аппарата; подразделение заявителя в карточке; «Закрыта
автоматически» в карточке и ленте; список «рекомендована замена»; отчёт по расходу.

Бюджет качества фронта (`apps/web/quality-budget.json`) валит сборку при росте файлов — форма и
действия заявки уже делились по этой причине; после правок бюджет пересчитывается
(`node scripts/quality.mjs update`).

---

## 8. Тесты

**Контрактные** (`service-requests-contracts.test.ts`, `service-corridors.test.ts`): единый цикл по
обоим видам; `serviceWaitingOn` по строке заявки во всех четырёх состояниях сметы; предикат
закрывающего документа; коридор исполнителя «назначен / не назначен»; правило удаления.

**db-тесты** (`service-request-flow.db.test.ts` и новые):

1. виза ИТ обесценивается новой ревизией сметы; старая заявка с пустой ревизией визой сметы не
   считается; после M10 запись подписи без ревизии отбивается базой;
2. автозакрытие: заявка закрывается с `acceptance_source = 'auto'` и строкой истории без автора;
   **границы срока** — за минуту до суток от `completed_at` не закрывается, ровно в сутки
   закрывается; возврат на доработку и повторное «Решена» отсчитывают сутки заново; заявка сервиса,
   стоящая в «Решена» без документа (наследие до выпуска 1), **не попадает в пачку отбора** и не
   вытесняет законные, а после подшивки акта закрывается **через сутки от подшивки**, а не сразу
   (единственный случай, где второе слагаемое срока работает); **второй документ срок не двигает** —
   счёт, досланный после акта, оставляет отсчёт на первом; **у заявки без обязательного документа
   срок считается только от `completed_at`** — приложенный к инхаус-ремонту или к расходникам счёт
   закрытие не отодвигает; заявка сервиса без документа до «Решена» не доходит вовсе;
2а. **гарантийный талон как единственный документ** — сквозной сценарий (пишется после того, как В3
   правит `FILE_KIND_STATUSES`: до этого талон не принимают в «В работе» и первый же шаг сценария
   невыполним): талон подшивается в «В
   работе» (правка `FILE_KIND_STATUSES`), переход в «Решена» проходит, автозакрытие срабатывает
   через сутки. Без правки первый же шаг упирается в отказ, и планка Н8 становится невыполнимой;
3. инвариант исполнителя: перевод в «В работе» без единого исполнителя отбивается триггером; снятие
   последнего исполнителя вместе с возвратом в «Новую» в одной транзакции проходит;
4. **смешанное назначение «свой + сервис»** (§4.2): отказ сервиса снимает компанию и оставляет
   заявку у своего, статус не меняется; отказ своего оставляет её у сервиса; отказ последнего —
   кем бы он ни был — возвращает заявку в «Новую»;
5. списание: **обычная выдача ровно запрошенного** проходит и пишет событие с серверной причиной
   (`issue_note` при этом пуст, и `CHECK` причины журнала не падает); причина расхождения
   обязательна во всех трёх случаях — больше, меньше, ноль; нехватка остатка даёт 422; возврат
   заявки на доработку склад не двигает; правка факта вниз пишет `return` на разницу; прямой
   `UPDATE issued_quantity` мимо события отбивается отложенным триггером (M12), и **обратный
   случай тоже** — транзакция, вставившая законное `issue` и не изменившая факт строки, отбивается
   вторым триггером той же пары;
6. два одновременных закрытия **разных** заявок с одними и теми же позициями не дают `40P01`.
   Сцена ставится намеренно: строки заявок заводятся так, чтобы порядок их `id` был **обратным**
   порядку `consumable_id` (сортируй маршрут по строкам заявки — и клинч случился бы), транзакции
   синхронизируются на первой блокировке, как в `assignment-lock-order.db.test.ts`. Контрольный
   прогон с сортировкой по `id` строки обязан этот клинч показывать — иначе тест не доказывает
   ничего;
7. миграция M8: заявка в `on_hold` с `held_from_status = 'diagnostics'` после перевода возвращается
   в «В работе»;
8. **отрицательные и положительные, по границам полномочий**: ИТ-служба не принимает работу и не
   отменяет заявку произвольно (нет `serviceRequests.status`); сервис не ставит срочность; заявитель
   не двигает статусы; ИТ-служба не удаляет заявку; **заморозка ИТ-службой разрешена из каждого
   рабочего статуса поимённо** (`hold`); **назначить исполнителем учётку без
   `serviceRequests.execute` нельзя** — 422 с именем. Обе половины предиката хода проверяются
   порознь и на двух действиях (статусный ход и правка факта выдачи): оператор сервиса делает их
   без всякого `execute`, поимённый исполнитель — делает, пока право есть, и перестаёт сразу после
   его отзыва, оставаясь при этом в списке назначенных;
9. отказ визы ИТ закрывает заявку отменой с `replacement_recommended`, а откат отмены в «Новую»
   снимает пометку (иначе ограничение M5 не пропустит откат);
9а. **подразделение заявителя**: заявка от учётки с одним отделом получает ссылку и снимок названия;
   переименование отдела снимок не меняет; учётка с двумя отделами без выбора получает 422, с чужим
   отделом — 422, со своим — успех; учётка без отдела и площадки заводит заявку с обеими пустыми
   парами;
10. **окно выката, три случая**: (а) заявка, **принятая старым кодом после M2** — с датой и без
    источника, — читается порталом и API как принятая человеком и не ломает ни один экран; (б) она
    же проходит накат M9 и получает `human`; (в) заявка, принятая до выпуска 1 и откаченная —
    неважно, кодом выпуска 1 или «старым» путём с прямым `UPDATE`, — накат M9 проходит: остаток
    убирает строка `SET acceptance_source = NULL WHERE accepted_at IS NULL`;
11. **обходы, закрытые схемой**: `UPDATE` мёртвого статуса после M8 отбивается `CHECK`;
    `UPDATE service_request_executors SET request_id = …` отбивается инвариантом исполнителя с обеих
    сторон; и **три обхода визы** после M10 — обнуление ревизии у существующей подписи,
    **проставление ревизии старой подписи в одиночку** (`SET it_approved_estimate_revision =
    estimate_revision` на legacy-строке) и подпись на прошлой ревизии при выросшей текущей;
12. **legacy-адаптер**: `PATCH /:id/service` из старой вкладки меняет контрагента и **сохраняет**
    строки поимённых исполнителей у заявки «свой + сервис»; заявка при этом не меняет статус, а
    новый портал ту же операцию делает через `PUT /:id/executors`;
13. **составной ключ журнала**: событие списания нельзя привязать к строке чужой заявки или к
    строке с другим расходником; ручная правка остатка — с заполненным `consumable_id` и обеими
    пустыми ссылками на заявку — проходит.

**Портал**: назначение мультивыбором, форма расходников, «Закрыта автоматически», очередь «Ждут
меня» в двух состояниях сметы.

**Стражи, которые упадут, если о них забыть**: `access-manifest.test.ts` (новые ручки),
`access-conditions.test.ts` (фикстуры), `grants-catalog.db.test.ts` (состав наборов),
`schema-copy-keys.test.ts` (выпуск 3 добавляет составной ключ журнала — его род называется в
`EXPECTED`, иначе тест падает).

---

## 9. Этапы работ

| Этап | Что | Зависит от | Критерий готовности |
| --- | --- | --- | --- |
| **0** | три правки в план расходников (§2.1) | — | **выполнен 21.08.2026**: правки внесены в текст плана и доведены до кода (права `manage`/`stock`, цвет свойством позиции, три колонки журнала с `CHECK`'ами; накат проверен на чистой базе) |
| **1** | контракты единого цикла: статусы, коридоры, `serviceWaitingOn`, предикаты | 0 | `pnpm typecheck` чист, контрактные тесты зелёные |
| **2** | миграции M1–M5 | 1 | накат на локальную базу, повторный накат идемпотентен |
| **3** | API цикла: виза по ревизии, две подписи, третий исход сметы, legacy-ветки | 2 | db-тесты 1 и 9 зелёные |
| **4** | исполнители: таблица, ручка, коридор «назначен ли», порядок блокировок | 2 | db-тесты 3 и 4 зелёные |
| **5** | автозакрытие: модель автодействия, внутренняя ручка, worker, пачки, `warranty_card` в `in_work` | 2 | db-тесты 2 и 2а зелёные, ручной прогон на стенде |
| **6** | полномочия: три набора, миграция каталога M6, синхронная правка `ROLE_ADDON_*` (§7.2) | 1, **3, 4** | `grants-catalog.db.test.ts` зелёный; **страж каталога дополнен модульной частью** — без этого состав нового набора не сверялся ни с чем |
| **7** | портал выпуска 1: исполнители полем, подписи, подразделение, «закрыта автоматически» | 3–6 | тесты портала зелёные, бюджет качества пересчитан |
| **8** | ADR, запись выпуска (M7), `docs/database-schema.md` | 3–7 | `db:migrate:check` чист |
| **9** | **выкат выпуска 1** | 8 | §11 |
| **10** | выпуск 2: M8–M11, удаление legacy-веток | 9 + условие §11.3 | накат проходит, db-тесты 7 и 11 зелёные |
| **11** | выпуск 3: M12–M13, строки заявки, списание, отчёт, форма, снятие запрета `kind='consumable'` | 9 + выкат справочника расходников | db-тесты 5, 6, 13 зелёные, `schema-copy-keys` знает новый ключ |

Этапы 3, 4, 5 независимы друг от друга и идут параллельно. **Этап 6 зависит от 3 и 4** (правка после
В1): он расширяет состав наборов, а расширенный набор открывает маршруты — значит маршруты должны
существовать раньше. Права как словарь заводятся в этапе 1 и никому доступа не дают, пока их не
включили в набор.

---

## 10. Волны реализации

**Состояние на 24.08.2026: волны В1–В7 закрыты, идёт В9 (этот абзац — её работа).** Выпуск 1 собран
целиком — контракты, схема (миграции `0175`–`0180`), маршруты цикла и исполнителей, автозакрытие с
внутренней ручкой и тиком worker, каталог полномочий (`0183`), портал и тесты. Номера разошлись с
ориентирами плана ровно так, как он и предупреждал: M6 занял `0183` (а не `0184`), M7 — `0184`, ADR
получил `0133`, запись выпуска — `seq 45`, версия `0.1.38.0133`. Волны В10 и В11 остаются выпускам 2
и 3 и своих условий (§11.3, §11.4) пока не выполнили.

Правила те же, что в плане расходников, и они важнее раскладки: **зоны не пересекаются** (один файл
— один агент), **никто не коммитит** (дерево общее с человеком), **барьер после каждой волны**
(`pnpm -r typecheck` → затронутые тесты → обзор диффа), **номер миграции сверяется в момент создания
файла**, **db-тесты идут на локальном dev-postgres** (порт 5433, база `technic_archive_test`).

| Волна | Зоны | Барьер |
| --- | --- | --- |
| **В1** | 1. `contracts/service-requests.ts` (статусы, коридоры, предикаты)<br>2. `contracts/permission-catalog.ts` + `permissions.ts` + `grants.ts` | typecheck, контрактные тесты |
| **В2** | 1. `db/schema.ts`<br>2. миграции M1–M3<br>3. миграции M4–M5 | накат, идемпотентность, `schema-copy-keys` |
| **В3** | 1. `routes/service-requests.ts` — виза и смета<br>2. `routes/service-requests.ts` — исполнители, адаптер старой ручки, подразделение заявителя **(последовательно после первой зоны, файл один)**<br>3. `services/service-request-mail.ts` + событие назначения | typecheck, api-тесты модуля |
| **В4** | 1. `routes/internal-service-requests.ts` + `app.ts`<br>2. `apps/worker/src/index.ts`<br>3. `lib/access-manifest.ts` + фикстуры тестов | typecheck, db-тесты 2 и 2а (автозакрытие и сквозной сценарий талона) |
| **В5** *(после В3 и В4)* | 1. миграция каталога наборов M6<br>2. `ROLE_ADDON_PERMISSIONS`, `roleAddonLabels`, `ROLE_ADDON_BASE_ROLES` — синхронно с каталогом (§7.2)<br>3. `services/grant-catalog.ts`, если требуется | `grants-catalog.db.test.ts` |
| **В6** | 1. форма и окно заявки<br>2. список и колонка исполнителей<br>3. карточка: подразделение, «закрыта автоматически» | тесты портала, бюджет качества |
| **В7** | 0. вычистить ссылки на снятые имена в комментариях уже существующих тестов: `service-request-flow.db.test.ts` (`service_requests_executor_check`), `file-linkage.db.test.ts` (`service_requests_open_per_equipment_unique`)<br>1. db-тесты 1, 3, 4, 8, 9, 9а, 10, 12 (виза по ревизии, исполнители и смешанное назначение, границы полномочий, подразделение заявителя, окно приёмки, legacy-адаптер)<br>2. тесты портала, включая пустой источник у принятой заявки и подшивку талона в «В работе» | `pnpm test` |
| **В8** | 1. ревью против §4–§7: сверка кода с решениями, проверка, что тесты ловят гонки, а не счастливый путь | правки той же волной |
| **В9** | ADR, запись выпуска, `database-schema.md`, `.env.example` и runbook (`SERVICE_REQUEST_AUTO_CLOSE_BATCH`, `SERVICE_AUTO_CLOSE_TICK_INTERVAL_MS`; первый прогон — с уменьшенной пачкой)<br>ADR обязан назвать: согласие и отклонение сметы ведут **в один статус** `in_work` и различаются не парой «откуда → куда», а телом действия; подписи обесценивает подъём ревизии, а не матрица сброса | обзор текста, `db:migrate:check` |
| **В10** | выпуск 2: M8–M11 + снятие legacy-веток<br>+ db-тесты 7 и 11 (перевод заморозки, `CHECK` мёртвых статусов, барьер визы) | условие §11.3 |
| **В11** | выпуск 3: M12–M13, строки, списание, отчёт, форма расходников<br>+ db-тесты 5, 6 и 13, `EXPECTED` в `schema-copy-keys` под составной ключ журнала | `pnpm test`, `schema-copy-keys` зелёный |

**Между В1 и В3 дерево красное, и это ожидаемое состояние.** Контракты уже описывают новый цикл, а
маршруты ещё старые, поэтому после В1 падают `access-matrix.test.ts` (четыре случая: `/it-approval`,
`/start`, `/decline`, `/estimate/reopen` — дуг `new → it_approved`, `assigned → diagnostics`,
`assigned → it_approved`, `in_work → diagnostics` больше нет), одна фикстура
`access-conditions.test.ts` и восемь случаев `service-requests-list.test.tsx` на портале. Чинит их
В3 и В6 — правкой маршрутов и экранов, а не подгонкой ожиданий. Зелёными эти файлы обязаны стать к
барьеру В7; если к тому времени они всё ещё красные, значит какая-то дуга не переехала.

**Матрица §6 до волны В5 выполняется у ИТ-службы наполовину.** Право `.assign` приходит ей составом
набора, а состав правится в В5 (§7.2): виза и «менять аппарат» работают сразу после В3, назначение
исполнителей — только после каталога. Проверять эту строку матрицы раньше В5 бессмысленно.

Одновременно работают **не более трёх** агентов: дерево общее, и разбор конфликтов съедает больше,
чем даёт параллельность. Зона `routes/service-requests.ts` в волне В3 делится по времени, а не по
агентам — файл один.

---

## 11. Выкат

### 11.1. Порядок

Выпуск 1 катится [штатным runbook](runbook.md): миграции M1–M7, затем перезапуск. Протокол выката
необратимых миграций не применяется — все миграции выпуска 1 аддитивны, кроме двух снятых
ограничений и одного индекса, заменённого двумя.

### 11.2. Что сверить после выпуска 1

1. Заявка заводится, назначается двум исполнителям сразу, каждый видит её в «Ждут меня».
2. Смета: виза ИТ и согласование суммы идут в этом порядке; повторное предъявление обесценивает обе.
3. «Менять аппарат» закрывает заявку отменой с пометкой; пометка видна в списке.
4. Заявка сервиса не переводится в «Решена» без закрывающего документа; инхаус-заявка переводится.
5. Автозакрытие: заявка, простоявшая сутки в «Решена», закрыта с пометкой «автоматически», в ленте
   истории — «Портал (автоматически)».
6. Первый прогон автозакрытия прошёл уменьшенной пачкой; база и журнал аудита нагрузку выдержали.
7. Заявки, оставшиеся в `it_approved` и `diagnostics` после окна выката, открываются и двигаются.
8. Срочность недоступна ИТ-службе и сервису, доступна «Ведению».

### 11.3. Условие выпуска 2

Код выпуска 1 отработал в проде **не менее недели**, и за эту неделю **ни одна заявка не переходила**
в `it_approved` или `diagnostics`. Проверяется по журналу переходов, а не по возрасту заявки:

```sql
SELECT count(*) FROM service_request_status_history
 WHERE to_status IN ('it_approved','diagnostics') AND changed_at > <cutoff>;
```

Отбор по `created_at` заявки здесь не годится — он не поймает старую заявку, переведённую в
`diagnostics` вчера.

**Что такое `cutoff` — и почему не «момент выката»** (правка после ревью). Момент наката миграций
на эту роль не годится: между ним и остановкой последнего старого экземпляра работает ровно тот
код, ради которого legacy-ветки и оставлены, и один его переход в `it_approved` навсегда обнулил бы
шанс когда-либо выполнить условие. Поэтому:

- `cutoff` — **момент остановки последнего старого экземпляра приложения** (конец окна выката), а
  не начало наката;
- критерий — «ни одного перехода за **последнюю стабильную неделю**», то есть окно считается от
  `cutoff` и **перезаписывается**, если находится и исправляется дефект, породивший такой переход:
  новый `cutoff` — момент выката исправления, и неделя отсчитывается заново;
- каждое такое смещение записывается в отчёт о выпуске. Условие обязано быть выполнимым, иначе
  contract-выпуск не уедет никогда — а с ним останутся и мёртвые статусы, и legacy-ветки кода.

### 11.4. Условие выпуска 3

Справочник расходников выкачен, позиции заведены, и в план внесены правки §2.1. Заявки на расходники
без наполненного справочника бессмысленны: подставлять в форму будет нечего.

### 11.5. Что сверить после выпуска 3

Список короче, чем у выпуска 1, и составлен по одному признаку: сюда попало то, что **на живых
данных может пойти иначе, чем на тестовых**. Остальное закрыто db-тестами 5, 6 и 13 и повторной
проверки руками не требует.

1. **Подстановка позиций по модели.** Завести заявку на расходники по МФУ, у которого модель
   проставлена, — картридж встаёт в строку сам. Затем по аппарату **без модели** и по аппарату,
   к модели которого не привязано ни одной позиции: в обоих случаях форма говорит об этом словами,
   и работает переключатель «показать все позиции».

   Второй случай — не редкость, а большинство: на 24.08.2026 модель проставлена у **всех** 353
   карточек, но позиции привязаны к **15 моделям из 39**, и покрывают они **264 карточки**. То есть
   почти у сотни аппаратов список подставится пустым, и переключатель «показать все позиции» для
   них — не запасной путь, а основной, пока ИТ-служба не довычитает остаток таблицы (её вычитка —
   свой хвост, см. план расходников). Случай «аппарат без модели» проверять на этих данных негде,
   и это тоже результат: нечего и ловить.
2. **Остаток в подписи позиции.** Число рядом с наименованием совпадает с карточкой справочника.
   Сид `0192` завёл позиции с нулевым остатком (Р7: остаток меняется только событием с автором и
   причиной) — значит на первых заявках «на складе 0» будет нормой, и закрыть такую заявку выдачей
   не выйдет, пока кладовщик не проведёт приход. Это ожидаемое поведение, а не сбой; проверить
   стоит именно связку «провели приход → цифра в форме изменилась».
3. **Закрытие с расхождением.** Выдать меньше запрошенного и убедиться, что портал требует причину,
   а склад уменьшился на **выданное**, а не на запрошенное. Затем поправить выданное вниз — в
   журнале позиции появляется `return` на разницу, а не второе списание.
4. **Заявка на картриджи по технике, которая уже в ремонте.** Обе заявки открыты одновременно:
   частичные индексы разведены по видам (решение 9 ADR 0133). До выпуска 3 вторая заявка любого
   вида упиралась в первую, и это первое, что заметит оператор.
5. **Журнал позиции.** У движения по заявке стоит её номер ссылкой, и ссылка ведёт в заявку. Ручные
   правки остатка остаются без ссылки — они и не должны её иметь.
6. **Заявка на расходники не показывает сметы.** Ни вкладки, ни кнопок сметы, ни визы ИТ; вместо
   сметы — «Номенклатура». Сервер отвечает 422 на любую из пяти ручек сметного круга, если позвать
   их по такой заявке мимо портала.

---

## 12. Риски

| Риск | Как закрыт |
| --- | --- |
| Новое ограничение роняет старый код в окне выката | все жёсткие проверки вынесены в выпуск 2 (§3) |
| Виза ИТ старого образца считается визой сметы | ревизионная подпись, `NULL` = «старая» (M1), барьер записи (M10) |
| Автозакрытие некому записать | `acceptance_source` + nullable автор истории (M2) |
| `CHECK` не может проверить таблицу исполнителей | отложенные constraint-триггеры (M4) |
| Взаимные блокировки при списании и назначении | фиксированный порядок: заявка → **складские позиции по возрастанию `consumable_id`** (§7.3); у назначения — заявка, потом строки исполнителей (M4) |
| Автозакрыватель встал за транзакцией человека | пачка с `FOR UPDATE SKIP LOCKED` (§7.3) |
| Всплеск закрытий в день выката | уменьшенный размер пачки на первом прогоне (§11.2, п. 6) |
| Одна негодная заявка вешает автозакрытие навсегда | `SET CONSTRAINTS ALL IMMEDIATE` + точка сохранения на заявку (§7.3) |
| Склад расходится с реальностью | склад двигает только правка факта, событием на разницу (Р6) |
| Набор «Номенклатура» выдаёт ведение всего парка | два своих права вместо `officeEquipment.write` (§2.1) |
| Номера миграций разъехались с параллельным потоком | номер сверяется в момент создания файла (§5) |
| Откат приёмки в окне выката оставляет источник у непринятой заявки | код выпуска 1 чистит источник вместе с `accepted_by/at`; M9 доубирает остаток строкой `SET acceptance_source = NULL` |
| Мёртвый статус возвращается прямым `UPDATE` после выпуска 2 | `CHECK` на `status` и `held_from_status` в M8 |
| «Старая» виза изготавливается обнулением ревизии | изменение ревизии входит в условие триггера M10 |
| Событие журнала указывает на строку чужой заявки | составной FK «строка + заявка + позиция» (M12) |
| Заявка на расходники заведена до выпуска 3 | контракт создания не принимает `kind = 'consumable'` до M12 (§7.3) |

---

## 13. Нумерация

- **Миграции**: тринадцать. **M1–M5 созданы волной В2 и заняли `0175`–`0179`** — прежний ориентир
  `0178`–`0182` устарел за сутки, как план и предупреждал (поток расходников занял `0171`–`0174`).
  **M5а заняла `0180`, M6 (каталог) — `0183`, M7 (запись выпуска 1) — `0184`**: между ними чужой
  поток занял `0181` и `0182`. **Выпуск 3 занял `0186` (M12, строки заявки и составной ключ журнала) и `0193`
  (M13, запись выпуска 48, версия `0.1.41.0133`)** — между ними прошли семь чужих миграций,
  включая `0192` с сидом самого справочника расходников. Номера выпуска 2 (M8–M11) по-прежнему не
  проставлены и берутся свободными на момент создания. Сверять перед созданием каждого файла —
  правило, а не пожелание.
- **ADR**: `0133` — **занят волной В9**:
  [ADR 0133](adr/0133-service-request-unified-cycle.md) «Заявки оргтехники: единый цикл, ревизионная
  виза и поимённые исполнители». Один ADR на всё решение; он отменяет решения 1, 2 и 4 ADR 0096
  (момент и природа визы ИТ) и решение 8 ADR 0125 (место планки закрывающего документа).
- **Версии**: продолжают счётчик, занятый планом расходников; хвост версии — номер ADR. Выпуск 1
  получил `seq 45` и версию `0.1.38.0133` (запись — `0184`, следом за `0.1.37.0132` из `0174`).
