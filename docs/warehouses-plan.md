# План: поставщики и справочник складов

Рабочий план, не ADR. Решения, принятые при постановке, помечены **Р**; их обоснование переехало
в [ADR 0051](adr/0051-suppliers-and-warehouses.md). **Реализовано целиком** — все четыре этапа §8,
миграции `0076` и `0077`.

Задача: завести новый вид контрагента — **Поставщик**, и новую сущность — **Склад**. Склад
принадлежит поставщику (один поставщик — много складов) и состоит из привязки к поставщику и
адреса. Склады ведутся отдельным справочником с фильтром по поставщику.

---

## 1. Что уже есть

Задача ложится на готовую механику — новых приёмов не требуется.

- **Контрагенты — одна таблица на все роли** (ADR 0010 §1): генподрядчик, подрядчик, оператор
  вывоза, арендодатель ТС различаются колонкой `type`. Арендодатель заводился ровно этим же
  ходом — значением enum, а не таблицей (ADR 0010 §13, миграция `0032`).
- **Права следуют из типа контрагента** (ADR 0038): `COUNTERPARTY_TYPE_PERMISSIONS` — `Record` по
  всем типам, поэтому новый тип обязан ответить «а этот что исполняет» строкой матрицы, и
  компилятор об этом напомнит.
- **Справочники устроены одинаково**: `directories.read`/`directories.write`, список с поиском и
  сортировкой (`pageParams`/`orderByFrom`/`searchCondition`), удаление деактивацией, карточка на
  телефоне (ADR 0042). Ближайшие образцы — [ObjectsTab.tsx](../apps/web/src/pages/directories/ObjectsTab.tsx)
  (адрес + `AddressAutoComplete`) и [CounterpartiesTab.tsx](../apps/web/src/pages/directories/CounterpartiesTab.tsx)
  (фильтр-селект над таблицей + тот же фильтр в шите).
- FSD-рефакторинг фронта ([frontend-fsd-plan.md](frontend-fsd-plan.md)) **не начат** — код пишется
  в текущей структуре `pages/directories/`, слайс `warehouse` появится в общем переезде.

Нумерация: миграции — `0076`, `0077` (последняя в дереве — `0075`), ADR — `0051` (последний —
`0050`; `0060+` зарезервированы под фронтенд). Перед коммитом номера перепроверить: параллельные
задачи занимают их независимо.

---

## 2. Принятые решения

**Р1. «Поставщик» — значение `counterparty_type`, а не отдельная сущность.** Набор полей у него тот
же, что у остальных ролей (наименование, ИНН, синонимы, комментарий, активность), и различает его
роль в проекте — ровно случай ADR 0010 §13. ИНН остаётся обязательным (§14): поставщик — сторона
договора, и опознаётся он по ИНН, а не по написанию названия.

**Р2. Учётных записей у поставщика нет.** Строка в матрице — пустая:
`COUNTERPARTY_TYPE_PERMISSIONS.supplier = []`, как у генподрядчика и подрядчика. Следствия
бесплатны: `COUNTERPARTY_TYPES_WITH_ACCOUNTS` не меняется, `ACCESS_PROFILES` не растёт, привязать
учётку оператора к поставщику API не даст, в форме регистрации нового пожелания не появляется.
Появится у поставщика свой модуль в портале — это будет строка в той же матрице, а не переделка.

**Р3. Склад — своя таблица `warehouses`.** Складов у поставщика много, и колонкой в
`counterparties` это не выражается. Связь — обычный FK, без промежуточной таблицы: склад
принадлежит ровно одному поставщику.

**Р4. Идентичность склада — пара «поставщик + адрес».** UNIQUE по
`(supplier_counterparty_id, normalized_address)`. Нормализацию считает БД
GENERATED-колонкой — приём ADR 0007/0010 §4; берётся существующая `counterparty_name_normalize`
(регистр, ё→е, кавычки и разделители схлопываются): «ул. Ленина, д. 1» и «ул Ленина д.1» дают одно
значение. Своя функция `address_normalize` не заводится — правила те же, а вторая функция с той же
логикой разошлась бы с первой при первой же правке.

**Р5. Опознаётся склад адресом; метка — необязательное дополнение к нему.** Колонка `name`
(«Основной», «Склад №2») заводится сразу — добавлять её потом означало бы править уже набранные
строки, — но в таблицу справочника **столбцом не выводится**: узнают склад по адресу, а лишний
столбец сужает адрес, ради которого справочник и заведён. Метка вводится в форме и видна в
карточке на телефоне; станет ли она столбцом — решается по тому, начнут ли её заполнять.
Для пометок вроде «ворота 3» остаётся `comment` — тот же, что у контрагента.

**Р6. «Тип контрагента = поставщик» держит сервис, а не составной FK.** Это прямой прецедент
ADR 0010 §6 и §10 — так же проверяются `waste_requests.operator_counterparty_id` и
`construction_object_operators`. Физический вариант (как `vehicles_lessor_fk`) потребовал бы
вернуть UNIQUE `(id, type)`, снятый миграцией `0038`, и денормализовать тип в каждую строку склада
— ради инварианта, который здесь держит одна проверка в одном месте (склад заводится и правится
только своим маршрутом).

**Р7. Смена типа у контрагента с живыми складами — 409.** Проверка встаёт в
`assertTypeChangeAllowed` ([counterparties.ts](../apps/api/src/routes/counterparties.ts)) рядом с
позициями прайса и предложениями аренды: «сначала удалите склады — потом меняйте тип». Причина та
же, что у соседей: склад заводил другой человек и по другому поводу, и снимать его побочным
эффектом правки карточки нельзя.

**Р8. Удаление поставщика со складами — тоже 409, а не тихая деактивация складов.** Отличие от
арендодателя (ADR 0018 §15, где удаление гасит технику) намеренное: там гашение держал CHECK — от
активности арендодателя зависела цена в заявке. Здесь такой связи нет, и «удалил контрагента —
исчезли адреса, которые заводило снабжение» это потеря чужой работы без предупреждения.

**Р9. Деактивация поставщика складов не касается.** Склад — адрес, он не перестаёт существовать
оттого, что с поставщиком приостановили работу. Выборки «куда везти», когда появятся, отберут
склады активных поставщиков сами — это правило выборки, а не состояние строки.

**Р10. Склад удаляется строкой, а не гасится.** Осознанное отступление от «удаления нет» — то же,
что у категорий ТС (ADR 0016 §13): справочник наполняется руками, и ошибочный адрес нужно
вычищать, а не держать неактивным мусором в списках. Переключатель «Активен» при этом остаётся и
значит другое — «работаем с этим складом, но не сейчас». Ссылающихся сущностей пока нет; с их
появлением на месте удаления встанет проверка ссылок и 409, а само удаление станет мягким.

Без этого Р7 и Р8 упирались бы в тупик: «сначала уберите склады» невыполнимо, если склад можно
только погасить, — и тип поставщика со складами не сменился бы никогда.

**Р11. Поставщика у склада можно сменить.** Это исправление ошибки ввода; ссылок на склад пока нет,
и запрещать нечего. Проверка типа при этом та же, что при заведении (Р6).

**Р12. Права — общие справочниковые: `directories.read` на чтение, `directories.write` на запись**
(администратор, менеджер, диспетчер). Своего права, как у водителей (ADR 0037), склад не требует:
персональных данных в карточке нет. Оговорка про снабжение — в §10.

**Р13. Фильтр по поставщику — один параметр `supplierId` на оба представления:** селект над
таблицей на десктопе и тот же фильтр описанием в шите на телефоне (ADR 0030/0042) — как фильтр
типа в карточке контрагентов.

**Р14. Контакт склада — контактное лицо и телефон, оба необязательные.** Кто принимает машину на
складе, знают не всегда, и требовать контакт за возможность записать адрес не за что: правило то
же, что у телефона учётки (ADR 0043). Обязательность держат контракты, а не CHECK, — как у
`responsible_phone` в заявках (миграция `0062`). В таблице это **один столбец «Контактное лицо»**:
ФИО, второй строкой телефон, — две графы под пару, которую всегда читают вместе, растащили бы
таблицу вширь.

---

## 3. Модель данных

### Миграция `0076_counterparty_supplier.sql`

```sql
-- Поставщик как роль контрагента (ADR 0010 §1, §13).
-- Значение enum используется только со следующей миграции: применить его в той же транзакции,
-- где оно добавлено, Postgres не даёт (приём 0022/0023, 0032/0033 — раннер выполняет файл
-- целиком в одной транзакции).
ALTER TYPE counterparty_type ADD VALUE IF NOT EXISTS 'supplier';
```

### Миграция `0077_warehouses.sql`

```sql
-- Склады поставщиков: один поставщик — много складов, склад это адрес приёмки/отгрузки.
CREATE TABLE warehouses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Имя колонки называет роль контрагента — приём waste_requests.operator_counterparty_id.
  -- Требование «тип = supplier» держит сервис (Р6).
  supplier_counterparty_id uuid NOT NULL REFERENCES counterparties (id) ON DELETE RESTRICT,
  address text NOT NULL,
  -- Нормализованная форма — та же функция, что у наименований контрагента: правила совпадают,
  -- а вторая такая же функция разошлась бы с первой при первой правке.
  normalized_address text GENERATED ALWAYS AS (counterparty_name_normalize(address)) STORED,
  -- Метка склада (Р5): пустая строка — «не задана», узнают склад по адресу.
  name text NOT NULL DEFAULT '',
  -- Контакт склада (Р14): пустая строка — «не указан», обязательности нет ни здесь, ни в CHECK.
  contact_person text NOT NULL DEFAULT '',
  contact_phone text NOT NULL DEFAULT '',
  comment text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT warehouses_address_not_blank_check CHECK (btrim(address) <> '')
);

-- Идентичность склада (Р4). Индекс покрывает и проход «склады этого поставщика» —
-- отдельный индекс по supplier_counterparty_id был бы его префиксом.
CREATE UNIQUE INDEX warehouses_supplier_address_unique
  ON warehouses (supplier_counterparty_id, normalized_address);
-- Поиск по адресу — тем же способом, что в остальных справочниках.
CREATE INDEX warehouses_address_trgm ON warehouses USING gin (address gin_trgm_ops);
```

Сида нет: поставщиков и их адреса заводит заказчик — своими реквизитами, как `organizations`.

### `apps/api/src/db/schema.ts`

```ts
export const warehouses = pgTable(
  'warehouses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    supplierCounterpartyId: uuid('supplier_counterparty_id')
      .notNull()
      .references(() => counterparties.id, { onDelete: 'restrict' }),
    address: text('address').notNull(),
    normalizedAddress: text('normalized_address').generatedAlwaysAs(
      sql`counterparty_name_normalize(address)`,
    ),
    name: text('name').notNull().default(''),
    contactPerson: text('contact_person').notNull().default(''),
    contactPhone: text('contact_phone').notNull().default(''),
    comment: text('comment').notNull().default(''),
    isActive: boolean('is_active').notNull().default(true),
    createdBy: uuid('created_by'),
    updatedBy: uuid('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    supplierAddressUnique: uniqueIndex('warehouses_supplier_address_unique').on(
      t.supplierCounterpartyId,
      t.normalizedAddress,
    ),
    addressTrgm: index('warehouses_address_trgm').using('gin', sql`${t.address} gin_trgm_ops`),
  }),
);
export type WarehouseRow = typeof warehouses.$inferSelect;
```

---

## 4. Контракты (`packages/contracts/src`)

### `counterparties.ts` — новый тип

```ts
export const COUNTERPARTY_TYPES = [
  'general_contractor',
  'contractor',
  'operator',
  'vehicle_lessor',
  'supplier',
] as const;

counterpartyTypeLabels.supplier = 'Поставщик';
counterpartyTypeColors.supplier = 'cyan'; // свободный цвет: purple/blue/green/orange заняты
```

### `permissions.ts` — строка матрицы (Р2)

```ts
export const COUNTERPARTY_TYPE_PERMISSIONS: Record<CounterpartyType, readonly Permission[]> = {
  …,
  // Поставщик (ADR 0051) — сторона договора поставки: его склады ведёт снабжение внутри портала,
  // сам поставщик в портале не работает. Пустой список, как у генподрядчика и подрядчика.
  supplier: [],
};
```

### `warehouses.ts` — новый файл

```ts
export const WAREHOUSE_SORT_FIELDS = ['address', 'supplier', 'isActive', 'createdAt'] as const;

export const warehouseListQuerySchema = baseListQuery(WAREHOUSE_SORT_FIELDS).extend({
  /** Фильтр справочника: чьи склады показывать (Р13). */
  supplierId: uuidSchema.optional(),
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

const addressSchema = z.string().trim().min(3).max(500);

export const createWarehouseSchema = z.object({
  supplierId: uuidSchema,
  address: addressSchema,
  /** Метка склада (Р5); пустая строка — «не задана». */
  name: z.string().trim().max(255).optional().default(''),
  /** Контакт склада (Р14): необязателен, но «-» вместо имени хуже пустоты — см. optionalPhoneSchema. */
  contactPerson: z.string().trim().max(200).optional().default(''),
  contactPhone: optionalPhoneSchema.optional().default(''),
  comment: z.string().trim().max(2000).optional().default(''),
  isActive: z.boolean().optional().default(true),
});
export type CreateWarehouseInput = z.infer<typeof createWarehouseSchema>;

// `.partial()` снимает обязательность, но не `.default()` — поля со значением по умолчанию
// объявлены заново (тот же подвох, что в updateDepartmentSchema).
export const updateWarehouseSchema = createWarehouseSchema.partial().extend({
  name: z.string().trim().max(255).optional(),
  contactPerson: z.string().trim().max(200).optional(),
  contactPhone: optionalPhoneSchema.optional(),
  comment: z.string().trim().max(2000).optional(),
  isActive: z.boolean().optional(),
});
export type UpdateWarehouseInput = z.infer<typeof updateWarehouseSchema>;

/** Поставщик в строке склада: столько, сколько нужно для показа и повторного выбора. */
export interface WarehouseSupplierRefDto {
  id: string;
  name: string;
  inn: string;
  /** Активность поставщика — списку видно, что склад принадлежит приостановленному контрагенту. */
  isActive: boolean;
}

export interface WarehouseDto {
  id: string;
  supplier: WarehouseSupplierRefDto;
  address: string;
  name: string;
  contactPerson: string;
  contactPhone: string;
  comment: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
```

Плюс реэкспорт из `index.ts`.

---

## 5. API

### `apps/api/src/routes/warehouses.ts` — новый маршрутный модуль

Устроен по образцу [departments.ts](../apps/api/src/routes/departments.ts).

| Метод                    | Право               | Поведение                                                   |
| ------------------------ | ------------------- | ----------------------------------------------------------- |
| `GET /warehouses`        | `directories.read`  | список: фильтры `supplierId`, `isActive`, поиск, сортировка |
| `GET /warehouses/:id`    | `directories.read`  | карточка                                                    |
| `POST /warehouses`       | `directories.write` | заведение                                                   |
| `PATCH /warehouses/:id`  | `directories.write` | правка, включая смену поставщика (Р11)                      |
| `DELETE /warehouses/:id` | `directories.write` | удаление строки (Р10)                                       |

Список — с `innerJoin` на контрагента: наименование поставщика показывается в строке, по нему же
идут поиск и сортировка.

```ts
const where = and(
  q.supplierId ? eq(warehouses.supplierCounterpartyId, q.supplierId) : undefined,
  q.isActive === undefined ? undefined : eq(warehouses.isActive, q.isActive),
  searchCondition(q.search, [warehouses.address, counterparties.name, counterparties.inn]),
);
const sortCols = {
  address: warehouses.address,
  supplier: counterparties.name,
  isActive: warehouses.isActive,
  createdAt: warehouses.createdAt,
};
```

Две проверки, обе — сервисные:

```ts
/** Склад заводится только у поставщика (Р6): тип контрагента задаёт смысл строки. */
async function loadSupplier(tx: Tx, id: string): Promise<CounterpartyRow> {
  const [row] = await tx.select().from(counterparties).where(eq(counterparties.id, id));
  if (!row || row.deletedAt)
    throw err.badRequest('Поставщик не найден', { supplierId: 'Не найден' });
  if (row.type !== 'supplier') {
    throw err.badRequest('Склад заводится только у контрагента типа «Поставщик»', {
      supplierId: 'Не поставщик',
    });
  }
  return row;
}

/** Пара «поставщик + адрес» уникальна (Р4) — проверяем до вставки, как код отдела. */
async function assertAddressFree(tx: Tx, supplierId: string, address: string, exceptId?: string) {
  const dup = await tx
    .select({ id: warehouses.id })
    .from(warehouses)
    .where(
      and(
        eq(warehouses.supplierCounterpartyId, supplierId),
        eq(warehouses.normalizedAddress, sql`counterparty_name_normalize(${address})`),
        exceptId ? ne(warehouses.id, exceptId) : undefined,
      ),
    );
  if (dup.length > 0) throw err.conflict('У этого поставщика уже заведён склад по такому адресу');
}
```

Аудит — `warehouse.create` / `warehouse.update` / `warehouse.delete`; у удаления в `metadata`
остаётся адрес: строки больше нет, и назвать её в журнале больше нечем.

### Правки `apps/api/src/routes/counterparties.ts`

1. `assertTypeChangeAllowed` — ветка `before === 'supplier'`: живые склады → 409 (Р7).
2. `DELETE /:id` — живые склады → 409 «сначала удалите склады» (Р8).

### `apps/api/src/app.ts`

```ts
await app.register(warehousesRoutes, { prefix: '/api/v1/warehouses' });
```

---

## 6. Портал (`apps/web/src`)

1. **`api/resources.ts`** — `warehousesApi` (`list`/`create`/`update`/`remove`), как `departmentsApi`.
2. **`pages/directories/WarehousesTab.tsx`** — новая вкладка. Собирается из готового:
   - таблица: «Поставщик» (`textColumn`, сортировка по `supplier`), «Адрес», «Контактное лицо»
     (ФИО, второй строкой телефон — Р14), «Комментарий», «Активен» (`boolBadgeColumn`), действия.
     Столбца метки нет (Р5);
   - фильтр по поставщику — `Select` над таблицей (`filters` у `PageTableLayout`) и тот же
     фильтр в `mobileFilters`; список поставщиков — `counterpartiesApi.list({ type: 'supplier',
pageSize: 500, sortBy: 'name' })`, неактивные не отсеиваются (иначе уже заведённый склад
     остался бы в форме без наименования — та же оговорка, что в `ObjectsTab`);
   - форма: поставщик (`AutoSelect`), адрес (`AddressAutoComplete`, как у объекта), метка,
     контактное лицо и телефон, комментарий, «Активен»;
   - карточка на телефоне (ADR 0042): заголовок — адрес, `primary` — поставщик, бейдж —
     активность, строками — метка, контакт и комментарий;
   - инвалидация: `['warehouses']`.
3. **`pages/DirectoriesPage.tsx`** — вкладка «Склады» сразу после «Контрагентов» (справочник о
   контрагентах и читается вместе с ними).
4. **`CounterpartiesTab`** менять не нужно: список типов и подписи берутся из контрактов, поле
   «Объекты» остаётся привязанным к типу «Оператор».

---

## 7. Тесты

- **`apps/api/test/counterparties-contracts.test.ts:48`** — **сломается**: `'supplier'` там служит
  примером чужого типа. Заменить пример на заведомо несуществующий (`'bank'`) и добавить кейс
  «поставщик — роль наравне с остальными, ИНН обязателен и ей», по образцу арендодателя.
- **`apps/api/test/permissions.test.ts`** — не ломается (`COUNTERPARTY_TYPES_WITH_ACCOUNTS`
  остаётся `['operator', 'vehicle_lessor']`, строка матрицы у поставщика пустая). Добавить явную
  проверку: учётку к поставщику привязать нельзя.
- **`apps/api/test/warehouses-contracts.test.ts`** (новый): обязательность поставщика и адреса,
  тримминг, `updateWarehouseSchema` без поля не подставляет значения по умолчанию, сортировочные
  поля.
- **`apps/api/test/access-matrix.test.ts`** — четыре кейса `/warehouses`: чтение доступно всем
  профилям с `directories.read`, запись — `admin`/`manager`/`dispatcher`.
- **`route-authorization.test.ts`** подхватит новые маршруты сам — при забытом `requirePermission`
  он и должен упасть.
- Тестов портала на вкладку не пишем: они есть только там, где живёт логика (сетка прайса,
  классификатор), а вкладка склада — композиция готовых блоков.

---

## 8. Этапы

1. **Контракты и БД.** Миграции `0076`, `0077`, `schema.ts`, `counterparties.ts` (+тип),
   `permissions.ts` (+строка), `warehouses.ts`, `index.ts`; правка теста чужого типа + новый тест
   контрактов. Проверка: `pnpm -r typecheck && pnpm -r test`, миграции применяются на чистой базе.
2. **API.** `routes/warehouses.ts`, регистрация в `app.ts`, guard'ы в `counterparties.ts`,
   кейсы матрицы доступа.
3. **Портал.** `warehousesApi`, `WarehousesTab.tsx`, вкладка в `DirectoriesPage`.
4. **Документы.** ADR 0051 «Поставщики и склады» (решения §2 с обоснованиями),
   [database-schema.md](database-schema.md): строка о `warehouses` и правка описания
   `counterparties` (перечень значений enum, миграция `0076`).

Этапы независимы по проверке, но по смыслу линейны: 2 не собирается без 1, 3 — без 2.

---

## 9. Что не входит

- **Потребители склада.** Заявка на доставку, выбор склада в грузоперевозке (`loading_location`),
  привязка склада к объекту — отдельные решения; справочник заполняется первым, ссылки на него
  появятся потом. Это тот же порядок, которым заводился арендодатель (ADR 0010 §13).
- **Метаданные адреса** (`fiasId`, координаты — приём ADR 0006, `freight_transport_request_details`):
  сейчас адрес хранится текстом. Понадобится геометрия маршрута — добавляется колонкой `jsonb`.
- **Учётки поставщика и его модуль в портале** (Р2).
- **Импорт складов и сопоставление адресов** из выгрузок.
- **Часы приёмки склада** — контакт (Р14) заведён, режим работы нет: он расписанием, а не строкой,
  и понадобится вместе с планированием доставки.

---

## 10. Решено при постановке (03.08.2026)

1. **Метка склада заводится, но столбцом в справочнике не показывается** — Р5. Колонка в БД и поле
   в форме есть сразу: добавлять её потом означало бы возвращаться к уже набранным строкам.
2. **Контакт склада — контактное лицо и телефон, необязательные** (Р14); в таблице один столбец,
   ФИО и телефон второй строкой.
3. **Справочник ведут те же, кто ведёт остальные** — `directories.write` (администратор, менеджер,
   диспетчер), отдельного права под снабжение не заводится (Р12). Понадобится — это будет решение
   о праве, а не о справочнике.
