-- Автозапчасти: расход по обслуживанию и аннулирование акта (план `docs/auto-parts-plan.md`,
-- §5 «Модель данных», миграция B; решения Р4—Р6, Р20).
--
-- ЗАЧЕМ. Миграция A завела склад, который умеет только ручную корректировку. Деталь же уходит со
-- склада тогда, когда её поставили на машину, и документ этого события в портале уже есть — акт
-- обслуживания (`vehicle_maintenance`, `0147`). Эта миграция сшивает две половины: у акта
-- появляются строки, у журнала — ссылка на акт, а у пары «акт + позиция» — инвариант, из-за
-- которого расход и склад не могут разойтись.
--
-- Отсюда же «привязка истории обслуживания к технике» получается даром (Р4): акт уже принадлежит
-- машине, и вопрос «что ставили на эту машину» отвечается соединением двух таблиц, без единого
-- нового поля.
--
-- ЧТО ЗАВОДИТСЯ: таблица строк акта; ссылка журнала на акт с двумя `CHECK` (связки и направление)
-- и своим индексом; три колонки аннулирования у `vehicle_maintenance` с двумя `CHECK` и частичный
-- индекс ДЕЙСТВУЮЩЕЙ истории; чистая функция инварианта расхода, две триггерные обёртки и ДВА
-- отложенных constraint-триггера — с обеих сторон инварианта.
--
-- ПОРЯДОК ОТНОСИТЕЛЬНО СОСЕДЕЙ. Миграция обязана идти ПОСЛЕ `0187`: она ссылается на `auto_parts`
-- и достраивает `auto_part_stock_entries`, которых до неё не существует. И ПОСЛЕ `0147`, который
-- завёл сам акт. Обратной зависимости нет — ни `0187`, ни `0147` про эту миграцию не знают.
--
-- ПОЧЕМУ ТРИГГЕРОВ ДВА, А ИНВАРИАНТ ОДИН. Обещание «строка акта равна сумме движений по этой паре»
-- нарушается с ДВУХ сторон: строкой без движения (правка строк мимо склада) и движением без строки
-- (списание, не доехавшее до документа). Проверка у них одна и та же, а дверей две, и триггер на
-- одной таблице вторую не видит вовсе.
--
-- ПОЧЕМУ ЭТОТ ИНВАРИАНТ ВООБЩЕ ЕСТЬ. Контур `0187` гарантирует, что остаток не расходится с
-- журналом. Он ничего не говорит о том, соответствует ли журнал документу: списать «−2» по акту, в
-- котором стоит 3, он позволяет. А отчёт «что ставили на эту машину» читается из строк акта, тогда
-- как склад считается по журналу, — и разойтись им нельзя, потому что сверять их будет не с чем.
--
-- ОБРАТИМОСТЬ. Миграция аддитивная: новая таблица, три новые колонки у `vehicle_maintenance` и
-- одна у журнала. Ни одной перезаписи данных: `void_reason` добавляется с умолчанием `''`, и в
-- PostgreSQL 11+ это метаданные, а не переписывание таблицы. Умолчание безопасное — пустая причина
-- у не-аннулированного акта и есть его нормальное состояние (см. `CHECK` ниже). Протокол выката
-- необратимых миграций (`docs/schema-cutover-protocol.md`) к ней не применяется.

-- ── 1. Строки акта обслуживания (Р5) ──
--
-- ПАРА «АКТ + ПОЗИЦИЯ» УНИКАЛЬНА, и это решение, а не удобство: две одинаковых детали в одном акте
-- — это количество 2, а не две строки. Из уникальности следует всё остальное в этой миграции:
-- журнал адресуется парой, а не ссылкой на строку, и инвариант формулируется по паре.
--
-- ССЫЛКИ НА СТРОКУ АКТА В ЖУРНАЛЕ НЕТ — и это осознанное отличие от расходников оргтехники. Там
-- событие ссылается на строку заявки, потому что одна позиция может стоять в заявке дважды; здесь
-- пара объявлена уникальной, и адресация парой ПОЛНЕЕ ссылки: строка приходит и уходит (её сняли —
-- строки больше нет), а акт остаётся, и движения после снятия строки продолжают отвечать, по
-- какому документу они прошли. Ссылка на строку в этот момент стала бы висячей или потребовала бы
-- `SET NULL` со снимком — то есть движения-сироты, которые нечем проверить.
CREATE TABLE vehicle_maintenance_parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- `CASCADE` у акта безвреден и выбран нарочно: акт С ДВИЖЕНИЯМИ удалить всё равно не даст
  -- `RESTRICT` журнала (Р6) — такой акт аннулируют, а не удаляют, — а у акта БЕЗ движений строк
  -- нет вовсе, потому что строка без движения не проходит инвариант ниже. То есть каскад срабатывает
  -- ровно в одном случае: удаляют пустой акт, и уносить ему нечего. `RESTRICT` здесь означал бы
  -- лишнюю дверь, запертую на второй замок.
  maintenance_id uuid NOT NULL REFERENCES vehicle_maintenance (id) ON DELETE CASCADE,
  -- `RESTRICT`: позиция, стоящая в акте, не удаляется. Строго говоря, её и так держит `RESTRICT`
  -- журнала (движение по паре существует всегда), но правило «есть движение — только гашение»
  -- (Р11) должно читаться и отсюда: строка акта — это документ, а не разметка.
  auto_part_id uuid NOT NULL REFERENCES auto_parts (id) ON DELETE RESTRICT,
  -- Целое и строго положительное (Р9). Ноль не бывает: «поставили ноль фильтров» — это отсутствие
  -- строки, а не строка, и разрешить его значило бы завести второе представление одного состояния.
  -- Отрицательное тем более: возврат — это уменьшение строки, а не строка с минусом.
  quantity integer NOT NULL,
  -- Свободная пометка механика к строке: «поставлен передний левый», «б/у, со списанной машины».
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vehicle_maintenance_parts_quantity_check CHECK (quantity > 0),
  CONSTRAINT vehicle_maintenance_parts_unique UNIQUE (maintenance_id, auto_part_id)
);

COMMENT ON TABLE vehicle_maintenance_parts IS
  'Строки акта обслуживания — что поставили на машину (docs/auto-parts-plan.md Р5). Пара '
  '«акт + позиция» уникальна: две одинаковых детали — это количество, а не две строки. Количество '
  'строки обязано равняться сумме движений журнала по той же паре — держит отложенный '
  'constraint-триггер vehicle_maintenance_parts_covered.';

-- Обратная сторона: «в каких актах стоит эта позиция». Ключ уникальности выше читается слева
-- направо, от акта, и на этот вопрос не работает; он же нужен `RESTRICT` при попытке удалить
-- позицию справочника.
CREATE INDEX vehicle_maintenance_parts_part_idx ON vehicle_maintenance_parts (auto_part_id);

-- ── 2. Журнал узнаёт про акт ──
--
-- Связь ссылкой, а не разбором текста причины: по тексту не построить ни отчёт «сколько списано по
-- обслуживанию за период», ни адресный возврат при аннулировании, ни запрет удалить акт, за
-- которым числится движение. `RESTRICT` и обеспечивает последнее — именно он делает правило Р6
-- («акт с движением не удаляют, а аннулируют») свойством схемы, а не вежливостью маршрута.
ALTER TABLE auto_part_stock_entries
  ADD COLUMN maintenance_id uuid REFERENCES vehicle_maintenance (id) ON DELETE RESTRICT;

COMMENT ON COLUMN auto_part_stock_entries.maintenance_id IS
  'Акт обслуживания, по которому прошло движение (Р5). Пусто у ручной корректировки и заполнено у '
  'issue/return — держит auto_part_stock_links_check. RESTRICT: акт с движением не удаляется, его '
  'аннулируют (Р6).';

-- Вид события и ссылка на акт — ОДНО утверждение, а не два соседних поля: «ручная корректировка» и
-- «списано по акту» не бывают наполовину. Иначе в журнале появилось бы списание, не знающее своего
-- документа, — и инвариант ниже его бы не увидел вовсе, потому что искать движения он умеет только
-- по паре «акт + позиция».
ALTER TABLE auto_part_stock_entries ADD CONSTRAINT auto_part_stock_links_check CHECK (
  (entry_kind = 'manual' AND maintenance_id IS NULL)
  OR (entry_kind IN ('issue', 'return') AND maintenance_id IS NOT NULL)
);

-- Направление движения задаёт ВИД события, а не знак разницы. Без этого «возврат», уменьшающий
-- остаток, прошёл бы в журнал и сделал отчёт по расходу неверным при верной цепочке. Инвариант
-- ниже считает по видам ровно поэтому: он спрашивает «сколько списано и сколько возвращено», а не
-- «куда сдвинулось число».
ALTER TABLE auto_part_stock_entries ADD CONSTRAINT auto_part_stock_direction_check CHECK (
  entry_kind = 'manual'
  OR (entry_kind = 'issue' AND quantity_after < quantity_before)
  OR (entry_kind = 'return' AND quantity_after > quantity_before)
);

-- Индекс под сам инвариант: обе половины проверки отбирают движения ровно по этой паре, и она же
-- отвечает на вопрос «что списано по этому акту» в карточке. Частичный, потому что у ручных
-- корректировок ссылка пуста и держать их здесь незачем — индекс остаётся размером с историю
-- расхода, а не всего журнала.
CREATE INDEX auto_part_stock_maintenance_idx
  ON auto_part_stock_entries (maintenance_id, auto_part_id) WHERE maintenance_id IS NOT NULL;

-- ── 3. Аннулирование акта (Р6) ──
--
-- Простое правило «акт с движением неудаляем навсегда» портит не интерфейс, а РАСЧЁТ: пустой
-- ошибочный акт остаётся последним обслуживанием машины, и «пробег с ТО» начинает считаться от
-- ложного якоря — машина, которую пора обслуживать, показывает «в норме». Ошибка ввода не должна
-- молча ломать нормативный контроль, поэтому у акта появляется аннулирование.
--
-- Аннулирование — одна транзакция: блокировка машины, снятие всех строк с возвратом на склад
-- (события `return`), простановка этих трёх полей, аудит. Аннулированный акт виден в истории — с
-- пометкой, причиной и автором: журнал склада на него ссылается, и спрятать документ нельзя.
--
-- `voided_by` — `RESTRICT`, как и остальные авторы акта в `0147`: «кто аннулировал» обязано
-- пережить увольнение, иначе поле отвечает на свой единственный вопрос словом «неизвестно».
ALTER TABLE vehicle_maintenance
  ADD COLUMN voided_at timestamptz,
  ADD COLUMN voided_by uuid REFERENCES users (id) ON DELETE RESTRICT,
  ADD COLUMN void_reason text NOT NULL DEFAULT '';

-- Три поля — одно состояние. Без этой пары «аннулирован, но неизвестно кем» стало бы законной
-- записью, а спросить с неё было бы некого.
ALTER TABLE vehicle_maintenance ADD CONSTRAINT vehicle_maintenance_voided_pair_check
  CHECK ((voided_at IS NULL) = (voided_by IS NULL));

-- Причина есть ровно у аннулированного: пустая у него — «аннулировали и не сказали зачем», а
-- непустая у действующего — текст, который никто никогда не прочитает и который через год примут
-- за признак аннулирования. Пустая строка вместо `NULL` выбрана нарочно: у действующего акта поле
-- заполнено всегда, и `NULL` пришлось бы отличать от `''` в каждом чтении.
ALTER TABLE vehicle_maintenance ADD CONSTRAINT vehicle_maintenance_void_reason_check
  CHECK ((voided_at IS NULL AND btrim(void_reason) = '')
      OR (voided_at IS NOT NULL AND btrim(void_reason) <> ''));

COMMENT ON COLUMN vehicle_maintenance.voided_at IS
  'Отметка аннулирования акта (Р6). NULL — акт действующий. Аннулированный выпадает из расчёта '
  '«последнее ТО», kmSince и снапшота гаража, не правится и повторно не аннулируется, но остаётся '
  'виден в истории: на него ссылается журнал склада.';

-- Порядок ДЕЙСТВУЮЩЕЙ истории: по нему идут «последнее ТО», расчёт пробега с обслуживания и
-- снапшот гаража. Колонки те же, что у `vehicle_maintenance_vehicle_idx` (`0147`), и это не
-- дубликат: тот обслуживает историю ЦЕЛИКОМ, где аннулированные акты обязаны быть видны, а этот —
-- три вопроса расчёта, в которых они не участвуют вовсе. Частичный индекс отвечает на них, не
-- перебирая отброшенное, и заодно называет условие словами схемы: `voided_at IS NULL` стоит в
-- трёх запросах, и разойдись хоть один — расчёт молча вернулся бы к ложному якорю.
CREATE INDEX vehicle_maintenance_active_idx
  ON vehicle_maintenance (vehicle_id, performed_on DESC, created_at DESC, id DESC)
  WHERE voided_at IS NULL;

-- ── 4. Инвариант расхода: строка акта и журнал говорят одно и то же (Р5) ──
--
-- Количество в строке акта равно `Σ issue − Σ return` по паре «акт + позиция». Это и есть тот
-- инвариант, ради которого пара объявлена уникальной: без уникальности «сумма по паре» не имела бы
-- единственного адресата, и сверять было бы не с чем.
--
-- ЧИСТАЯ ФУНКЦИЯ ПРИНИМАЕТ ПАРУ И ПЕРЕЧИТЫВАЕТ ОБЕ СТОРОНЫ — снимка ряда (`NEW`, `OLD`) в ней нет
-- вовсе, и это условие правильности, а не стиль. Правка строк акта — это несколько изменений одной
-- пары в одной транзакции (сняли строку и завели её заново, поправили количество дважды), а
-- отложенные триггеры срабатывают на коммите ВСЕ: первый из них, сравнивая свой снимок с уже
-- изменившимся состоянием, дал бы отказ на ровном месте. Урок дословно из `0035` и `0172`.
--
-- ВЫХОД ПРИ ОТСУТСТВИИ АКТА обязателен по той же причине: удаление акта уносит строки каскадом, и
-- требовать от удалённого документа соответствия журналу значило бы запретить удаление пустого
-- акта — единственный случай, когда каскад вообще срабатывает. Акт С движениями удалить нельзя:
-- держит `RESTRICT` журнала, и до этой ветки дело не доходит.
--
-- СЧЁТ ИДЁТ ПО ВИДАМ, А НЕ ПО ЗНАКУ РАЗНИЦЫ: `issue` прибавляет списанное, `return` вычитает
-- возвращённое. Сегодня направление привязано к виду ограничением
-- `auto_part_stock_direction_check`, и оба способа дали бы одно число, — но `CHECK` может быть
-- ослаблен миграцией, а инвариант обязан продолжать отвечать на свой вопрос («сколько по документу
-- ушло»), а не на соседний («куда сдвинулось число»). `ELSE 0` недостижим: `manual` в выборку не
-- попадает — у него нет ссылки на акт (`auto_part_stock_links_check`); ветка стоит затем, чтобы
-- будущий четвёртый вид не начал молча считаться списанием.
--
-- ЗНАК ФОРМУЛЫ — правка §5 плана: там в `ELSE`-ветке стоит `quantity_after - quantity_before`, то
-- есть возврат ПРИБАВЛЯЛСЯ бы наравне со списанием, и акт с одной снятой строкой сходился бы при
-- нулевой строке и двух движениях. Разбор обеих сторон см. в подписи функции.
CREATE FUNCTION auto_part_maintenance_covered(p_maintenance_id uuid, p_auto_part_id uuid)
  RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  v_line integer;
  v_moved integer;
BEGIN
  -- Акт удалён в этой же транзакции — проверять нечего.
  PERFORM 1 FROM vehicle_maintenance WHERE id = p_maintenance_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT coalesce(sum(l.quantity), 0) INTO v_line
    FROM vehicle_maintenance_parts l
   WHERE l.maintenance_id = p_maintenance_id
     AND l.auto_part_id = p_auto_part_id;

  SELECT coalesce(sum(CASE
                        WHEN e.entry_kind = 'issue' THEN e.quantity_before - e.quantity_after
                        WHEN e.entry_kind = 'return' THEN -(e.quantity_after - e.quantity_before)
                        ELSE 0
                      END), 0)
    INTO v_moved
    FROM auto_part_stock_entries e
   WHERE e.maintenance_id = p_maintenance_id
     AND e.auto_part_id = p_auto_part_id;

  IF v_line <> v_moved THEN
    RAISE EXCEPTION
      'Строка акта % по автозапчасти % говорит про %, а журнал склада — про %',
      p_maintenance_id, p_auto_part_id, v_line, v_moved
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

COMMENT ON FUNCTION auto_part_maintenance_covered(uuid, uuid) IS
  'ЧИСТАЯ проверка инварианта расхода (Р5): количество в строке акта по паре «акт + позиция» равно '
  'Σ issue − Σ return по той же паре. ПЕРЕЧИТЫВАЕТ обе стороны по идентификаторам — снимка ряда не '
  'берёт, иначе несколько правок одной пары в одной транзакции дали бы ложный отказ на коммите. '
  'Списание считается как before − after (положительное), возврат — тем же выражением, у него оно '
  'отрицательное: возврат обязан ВЫЧИТАТЬСЯ, иначе снятая строка сходилась бы при нулевом '
  'количестве и двух движениях. Удалённый акт — молчаливый выход (каскад строк при удалении '
  'пустого акта). Годится и для сверки базы одним запросом, а не только изнутри триггеров.';

-- Обёртка со стороны СТРОК. Проверяются обе пары — старая и новая, — хотя триггер и объявлен как
-- `UPDATE OF quantity`: список колонок говорит, КОГДА сработать, а не что менялось, и один
-- `UPDATE`, поменявший заодно позицию строки, оставил бы старую пару непроверенной. Для `INSERT`
-- старой пары нет, для `DELETE` — новой; `TG_OP` разводит эти три случая, а не `IS NULL` по `OLD`,
-- потому что `OLD` в `INSERT`-триггере не пуст, а не существует.
CREATE FUNCTION vehicle_maintenance_parts_covered_trg() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM auto_part_maintenance_covered(OLD.maintenance_id, OLD.auto_part_id);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM auto_part_maintenance_covered(NEW.maintenance_id, NEW.auto_part_id);
  END IF;
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION vehicle_maintenance_parts_covered_trg() IS
  'Обёртка constraint-триггера vehicle_maintenance_parts_covered: зовёт чистую '
  'auto_part_maintenance_covered(uuid, uuid) по СТАРОЙ и НОВОЙ паре строки (правка могла поменять '
  'и позицию, и акт), больше не делает ничего. Разделены нарочно — проверку зовут и запросом.';

-- Обёртка со стороны ЖУРНАЛА. `OLD` здесь не нужен вовсе: журнал неизменяем (`0187`), и кроме
-- `INSERT` с ним ничего не случается.
CREATE FUNCTION auto_part_stock_maintenance_covered_trg() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM auto_part_maintenance_covered(NEW.maintenance_id, NEW.auto_part_id);
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION auto_part_stock_maintenance_covered_trg() IS
  'Обёртка constraint-триггера auto_part_stock_maintenance_covered: передаёт пару «акт + позиция» '
  'нового движения в чистую auto_part_maintenance_covered(uuid, uuid). OLD не рассматривается — '
  'журнал неизменяем, правки и удаления строк в нём не бывает.';

-- Два отложенных constraint-триггера с одной проверкой: строка без движения и движение без строки
-- запрещены одинаково, а войти в это состояние можно с обеих сторон. Отложенные, потому что внутри
-- транзакции порядок «строка → движение» (или обратный) законен и обязателен: немедленная проверка
-- отбивала бы первый же шаг правильного пути.
CREATE CONSTRAINT TRIGGER vehicle_maintenance_parts_covered
  AFTER INSERT OR UPDATE OF quantity OR DELETE ON vehicle_maintenance_parts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION vehicle_maintenance_parts_covered_trg();

ALTER TABLE vehicle_maintenance_parts
  ENABLE ALWAYS TRIGGER vehicle_maintenance_parts_covered;

COMMENT ON TRIGGER vehicle_maintenance_parts_covered ON vehicle_maintenance_parts IS
  'Отложенный constraint-триггер (DEFERRABLE INITIALLY DEFERRED) AFTER INSERT OR UPDATE OF quantity '
  'OR DELETE: на коммите исполняет vehicle_maintenance_parts_covered_trg(), а та зовёт чистую '
  'auto_part_maintenance_covered(uuid, uuid). Ловит СТРОКУ БЕЗ ДВИЖЕНИЯ — правку строк акта мимо '
  'склада. ENABLE ALWAYS.';

-- `WHEN (NEW.maintenance_id IS NOT NULL)` — ручные корректировки к акту отношения не имеют, и
-- гонять по ним проверку значило бы читать строки акта на каждое движение склада. Условие
-- вычисляется до постановки события в очередь, то есть отсеянные не доживают до коммита вовсе.
-- `UPDATE`/`DELETE` в списке нет: журнал неизменяем, эти пути отбиты в `0187` безусловно.
CREATE CONSTRAINT TRIGGER auto_part_stock_maintenance_covered
  AFTER INSERT ON auto_part_stock_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.maintenance_id IS NOT NULL)
  EXECUTE FUNCTION auto_part_stock_maintenance_covered_trg();

ALTER TABLE auto_part_stock_entries
  ENABLE ALWAYS TRIGGER auto_part_stock_maintenance_covered;

COMMENT ON TRIGGER auto_part_stock_maintenance_covered ON auto_part_stock_entries IS
  'Отложенный constraint-триггер (DEFERRABLE INITIALLY DEFERRED) AFTER INSERT WHEN maintenance_id '
  'IS NOT NULL: на коммите исполняет auto_part_stock_maintenance_covered_trg(), а та зовёт чистую '
  'auto_part_maintenance_covered(uuid, uuid). Ловит ДВИЖЕНИЕ БЕЗ СТРОКИ — списание, не доехавшее до '
  'документа. ENABLE ALWAYS.';
