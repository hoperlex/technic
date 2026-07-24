# Справочник «Типы/подтипы ТС» — сводка реализации (этап 2.1)

Вертикальный срез БД → контракты → REST → frontend. Обоснование модели —
[ADR 0003](../adr/0003-vehicle-types-directory.md).

## Что сделано

| Слой | Файлы |
|---|---|
| Контракты | `packages/contracts/src/vehicle-types.ts` (union по `level`, strict update-схемы, DTO `level`/`parentName`/`childrenCount`, regex кода), `container-types.ts` (strict update без `code`) |
| БД | `apps/api/drizzle/0011_vehicle_types_invariants.sql` (+ `schema.ts`): CHECK `level`/`is_selectable`, CHECK формата кода |
| API | `routes/vehicle-types.ts` (list/get/POST-union/PATCH-split, транзакции, пересчёт активности, аудит), `routes/vehicle-kinds.ts` (GET), рефактор `routes/container-types.ts` (без DELETE), `lib/errors.ts` (422), регистрация в `app.ts` |
| Frontend | `pages/directories/VehicleTypesTab.tsx`, вкладка в `DirectoriesPage.tsx`, `api/resources.ts` (`vehicleKindsApi`/`vehicleTypesApi`), рефактор `ContainerTypesTab.tsx` |
| Тесты | `test/vehicle-classification.test.ts` переписан под новый контракт |

## Критерии приёмки (§23)

1. ✅ Вертикальный справочник БД → frontend.
2. ✅ Создание типа/подтипа различается через `level` (discriminatedUnion).
3. ✅ Подтип создаётся только внутри существующего типа (FOR UPDATE родителя, 404/422).
4. ✅ Тип переименовывается независимо от наличия подтипов.
5. ✅ Структурные ключи неизменяемы (strict-схемы + отсутствие `parentId` в update подтипа).
6. ✅ Удаления нет (нет DELETE/restore/deleted_at).
7. ✅ Перенос подтипа невозможен.
8. ✅ Активность типа — производная (`EXISTS(active child)`), пересчёт в транзакции.
9. ✅ Колонки: Вид → Тип → Подтип → Активен → Действия.
10. ✅ Готово к привязке моделей/ТС (ссылки на подтипы защищены).

## Проверки (автоматические)

- `pnpm typecheck` (api + web) — чисто.
- `pnpm lint` — чисто.
- `pnpm --filter @technic/web build` — успешно.
- `pnpm test` — **38/38** (контракты ТС, waste-requests, s3-presign, классификатор).

## Отложено — интеграционный PG-тест (§22)

Тестовой инфраструктуры на реальном PostgreSQL нет (все тесты — unit, без БД). По согласованию
конкурентный PG-тест (параллельные «правка описания типа» + «создание подтипа») **вынесен в
бэклог**; логика транзакций и инварианты покрыты контракт/unit-тестами. Полноценный тест
потребует поднятия тестовой БД (Testcontainers или гейт по `TEST_DATABASE_URL`).

## Ручной frontend-чеклист (Playwright-раннера для юнитов нет)

- [ ] Порядок колонок: Вид → Тип → Подтип → Активен → Действия; лишних колонок нет.
- [ ] Строка типа: Подтип = «—»; строка подтипа: Тип = родитель, Подтип = наименование.
- [ ] Тип с подтипами редактируется (name/description/sortOrder).
- [ ] Структурные поля readonly (Вид/Код у типа; Вид/Родитель/Код у подтипа).
- [ ] Подтип нельзя создать без родителя; родителя нельзя создать внутри Select; поле
      родителя недоступно до выбора вида и не допускает свободный ввод.
- [ ] Инлайн-Switch активности у подтипа (деактивация с подтверждением); у типа — бейдж.
- [ ] Удаление отсутствует; перенос подтипа отсутствует.
- [ ] Container-types: удаление убрано, деактивация через Switch, код readonly при правке.
