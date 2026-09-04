-- Топливо в баке на концах смены (ADR 0163, план `docs/driver-fuel-readings-plan.md`, Э1).
--
-- ЧТО ДОБАВЛЯЕТСЯ. Две необязательные колонки уровня — `fuel_start_liters` и `fuel_end_liters`, — и
-- переписанные под них два CHECK. Рядом с ними уже лежащий `fuel_filled_liters` остаётся тем, чем
-- был: заправленным ЗА СМЕНУ. Природа у чисел разная, и в этом весь смысл разделения: уровень
-- нельзя складывать за период, поток — можно.
--
-- БЭКФИЛА НЕТ И БЫТЬ НЕ МОЖЕТ. У показаний, сданных до этой миграции, остатков не спрашивали
-- вовсе — `NULL` здесь и означает «не спрашивали», а не «бак был пуст». Проставить им ноль значило
-- бы придумать учётное число за человека, которого рядом с машиной уже нет.
--
-- ОТКУДА НОМЕР. Перед созданием файла 04.09.2026 числовые имена сверены по всему каталогу, включая
-- незакоммиченные файлы соседних потоков: после `0266_office_equipment_requester_grant.sql` свободен
-- 0267. Запись выпуска этой волны заняла следующий свободный 0268.
--
-- ПОЧЕМУ ПРЯМАЯ ВЕТКА, А НЕ `expand → validate → swap`. Н10 плана разрешает этот файл только после
-- preflight рабочей БД: число строк, размер `vehicle_readings` и отсутствие долгих транзакций/
-- ожидающих блокировок должны попасть в протокол выката. Непосредственно перед G проверка блокировок
-- повторяется. Если до публикации таблица достигла миллиона строк либо найдена конкурирующая очередь
-- или длительный писатель, этот файл заменяется трёхфайловой веткой из плана. Поздняя конкуренция
-- набор файлов уже не меняет, а переносит выкат в тихое окно. `lock_timeout` ни одна ветка не меняет.
--
-- ЗАМЕНА ПРОХОДИТ ЗАВЕДОМО. Оба новых условия СЛАБЕЕ прежних: форма допускает те же `values` плюс
-- строки с одними остатками, а неотрицательность сохраняет старые условия и добавляет два, истинных
-- для `NULL`. Всякая уже лежащая строка им удовлетворяет. Все шесть подкоманд сведены в один
-- `ALTER TABLE`: одна блокировка и один проход проверки новых CHECK вместо пяти отдельных захватов.
-- Весь файл идёт одной транзакцией раннера, поэтому промежуточного состояния снаружи нет.
--
-- ОТКАТ. Обратной миграции нет: `DROP COLUMN` не восстанавливает прежние CHECK, а после первой записи
-- ещё и уничтожает учётные числа. Обычный `--previous` из G в pre-G запрещён уже из-за сверки
-- миграционного журнала. Прикладной откат — новый совместимый релиз с тем же каталогом и схемой;
-- точное возвращение требует согласованного предмиграционного дампа, а после появления остатков —
-- отдельного плана их сохранения. D безопасно возвращается на подготовленный тег G (§7 плана).

ALTER TABLE vehicle_readings
  ADD COLUMN fuel_start_liters numeric(7, 1),
  ADD COLUMN fuel_end_liters numeric(7, 1),
  DROP CONSTRAINT vehicle_readings_values_check,
  DROP CONSTRAINT vehicle_readings_non_negative_check,
  ADD CONSTRAINT vehicle_readings_values_check CHECK (
    (
      kind = 'values'
      AND no_data_reason = ''
      AND (
        odometer_km IS NOT NULL
        OR engine_hours IS NOT NULL
        OR fuel_filled_liters IS NOT NULL
        OR fuel_start_liters IS NOT NULL
        OR fuel_end_liters IS NOT NULL
      )
    )
    OR (
      kind = 'no_data'
      AND odometer_km IS NULL
      AND engine_hours IS NULL
      AND fuel_filled_liters IS NULL
      AND fuel_start_liters IS NULL
      AND fuel_end_liters IS NULL
      AND btrim(no_data_reason) <> ''
    )
  ),
  ADD CONSTRAINT vehicle_readings_non_negative_check CHECK (
    (odometer_km IS NULL OR odometer_km >= 0)
    AND (engine_hours IS NULL OR engine_hours >= 0)
    AND (fuel_filled_liters IS NULL OR fuel_filled_liters >= 0)
    AND (fuel_start_liters IS NULL OR fuel_start_liters >= 0)
    AND (fuel_end_liters IS NULL OR fuel_end_liters >= 0)
  );
