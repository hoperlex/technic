-- Адресация ролевых сводок правом вместо роли. ADR 0111; план реструктуризации модели доступа,
-- §11.1 (имя роли как бизнес-связь) и §15, этап 7; решение заказчика №3 от 17.08.2026.
--
-- ЗАЧЕМ. Расписание сводки до сих пор перечисляло роли (`mailing_schedule_roles`, ADR 0078,
-- переработан ADR 0093): «кому нужна эта сводка» спрашивалось названием должности, потому что
-- спросить иначе было нечем. Заказчик отвечает: спрашивай правом — сводку по заказам техники
-- получает тот, кто их ведёт. Заодно снимается тихая поломка перевода ролей: расписание с
-- упразднённой ролью не сопоставляется никому и просто перестаёт приходить, а слияние ролей,
-- отмеченных по отдельности, расширяет аудиторию на тех, кого из неё исключали. Поэтому этап и
-- обязан выехать ДО перевода трёх ролей площадки в `site` (миграция 0152, этап 8).
--
-- ЧТО ДЕЛАЕТ. Заводит `mailing_schedule_permissions` и наполняет её ПО ФАКТУ: для каждого
-- расписания ищет право, дающее на живых данных ровно ту же аудиторию, что нынешний набор ролей.
-- Соответствие «роль → право» неоднозначно, и подбирать его на глаз нельзя — здесь оно считается
-- сравнением множеств учёток, а не выводится из сходства названий.
--
-- КРИТЕРИЙ РАВЕНСТВА — «кому уйдёт письмо», а не «кого вернёт отбор», и это осознанный выбор.
-- Сводка целиком про заказы техники: `buildRoleDigestMail` отдаёт `null` всякому, у кого нет
-- `vehicleRequests.read`, — то есть комендант, механик и водитель сегодня стоят в адресатах и не
-- получают ничего. Сравнивай мы множества до этого гейта, не совпало бы почти ничто, а совпадения
-- описывали бы разницу, которой в почтовом ящике не существует. Гейт стоит по обе стороны сравнения
-- и потому ничего не «подгоняет»: он одинаково срезает и «до», и «после».
--
-- Область рассылки, поимённый перечень и подтверждённый адрес в сравнении НЕ участвуют — намеренно.
-- Эти три фильтра одинаковы до и после и накладываются поверх адреса; включи мы их, расписание,
-- суженное до трёх человек, «совпало» бы с доброй половиной словаря прав. Сравнение идёт по одной
-- заменяемой оси, и потому оно строже итогового списка получателей: совпали адресаты — совпадут и
-- получатели после любых одинаковых фильтров поверх.
--
-- ЕСЛИ ПРАВА НЕ НАШЛОСЬ, расписание остаётся без строк — и рассылка по нему не уходит никому. Это
-- не забывчивость и не приближение: аудитория роли выражается правом далеко не всегда, и выбирать
-- «похожее» право за заказчика значит менять список получателей молча. Такие расписания обязан
-- назвать поимённо `check:mailing-audience` сразу после выката (runbook), и решение по каждому
-- принимает человек в форме расписания.
--
-- СНИМОК МАТРИЦЫ. Права ролей и типов контрагента живут в коде (`@technic/contracts`), и здесь они
-- развёрнуты списками — снимком на момент миграции, как и положено переносу данных. Значения
-- сравниваются через `::text`: роль `site` заведена в словаре кода раньше, чем в enum'е базы (её
-- добавляет 0152), и подстановка её как значения enum'а уронила бы миграцию.
--
-- ОБРАТИМОСТЬ. Строки прежней адресации (`mailing_schedule_roles`) миграция не трогает: пока они на
-- месте, откат этапа сводится к откату кода. Удаление таблицы — отдельная миграция релизом позже
-- (§13: между «перестали писать в старую таблицу» и «удалили её» обязан пройти релиз).
--
-- Аддитивная миграция: смысл существующих данных не меняется, протокол выката необратимых
-- миграций (`docs/schema-cutover-protocol.md`) к ней не применяется.

CREATE TABLE mailing_schedule_permissions (
  schedule_id uuid NOT NULL REFERENCES mailing_schedules (id) ON DELETE CASCADE,
  -- Право текстом, а не enum: словарь прав живёт в контрактах и меняется выкатом, а значение enum'а
  -- снимается миграцией — каждое новое право требовало бы своей. Тот же приём, что у
  -- `grant_permissions` (ADR 0106) и у `module_mail_recipients.event`.
  permission text NOT NULL,
  PRIMARY KEY (schedule_id, permission)
);

ALTER TABLE mailing_schedule_permissions ADD CONSTRAINT mailing_schedule_permissions_not_blank
  CHECK (btrim(permission) <> '');

WITH
-- Снимок матрицы `ROLE_PERMISSIONS`: право, его номер в словаре и роли, которым оно положено.
-- Номер нужен только для устойчивого выбора, когда подходящих прав несколько.
role_perm (ord, permission, roles) AS (VALUES
  (1, 'directories.read', ARRAY['admin','manager','dispatcher','shtab','rukstroy','commandant','site','department','department_head','operator','observer','mechanic','chief_mechanic']::text[]),
  (2, 'directories.write', ARRAY['admin','manager','dispatcher']),
  (3, 'directories.export', ARRAY['admin']),
  (4, 'directories.import', ARRAY['admin']),
  (5, 'wasteRequests.read', ARRAY['admin','manager','dispatcher','shtab','rukstroy','commandant','site','department','department_head','observer']),
  (6, 'wasteRequests.create', ARRAY['admin','manager','dispatcher','shtab','rukstroy','commandant','site','department','department_head']),
  (7, 'wasteRequests.update', ARRAY['admin','manager','dispatcher','shtab','rukstroy','commandant','site','department','department_head']),
  (8, 'wasteRequests.delete', ARRAY['admin','manager','dispatcher','shtab','rukstroy','commandant','site','department','department_head']),
  (9, 'wasteRequests.status', ARRAY['admin','manager','dispatcher']),
  (10, 'wasteRequests.assignOperator', ARRAY['admin','manager','dispatcher']),
  (11, 'wasteRequests.operatorComment', ARRAY['admin','manager','dispatcher']),
  (12, 'vehicleRequests.read', ARRAY['admin','manager','dispatcher','shtab','rukstroy','department','department_head','observer']),
  (13, 'vehicleRequests.create', ARRAY['admin','manager','dispatcher','shtab','rukstroy','department','department_head']),
  (14, 'vehicleRequests.update', ARRAY['admin','manager','dispatcher','shtab','rukstroy','department','department_head']),
  (15, 'vehicleRequests.delete', ARRAY['admin','manager','dispatcher','shtab','rukstroy','department','department_head']),
  (16, 'vehicleRequests.status', ARRAY['admin','manager','dispatcher']),
  (17, 'vehicleRequests.approve', ARRAY['admin','rukstroy','department_head']),
  (18, 'weeklyRequests.read', ARRAY['admin','manager','dispatcher','shtab','rukstroy','department','department_head','observer']),
  (19, 'weeklyRequests.create', ARRAY['admin','manager','dispatcher','shtab','rukstroy']),
  (20, 'weeklyRequests.update', ARRAY['admin','manager','dispatcher','shtab','rukstroy']),
  (21, 'weeklyRequests.approve', ARRAY['admin','rukstroy']),
  (22, 'drivers.read', ARRAY['admin','manager','dispatcher','mechanic','chief_mechanic']),
  (23, 'drivers.write', ARRAY['admin','manager','dispatcher','chief_mechanic']),
  (24, 'waybills.read', ARRAY['admin','manager','dispatcher','mechanic','chief_mechanic']),
  (25, 'waybills.cancel', ARRAY['admin','manager','dispatcher','chief_mechanic']),
  (26, 'waybills.files', ARRAY['admin','manager','dispatcher']),
  (27, 'waybills.issueBlank', ARRAY['admin']),
  (28, 'waybills.correct', ARRAY['admin','dispatcher']),
  (29, 'waybills.correctBeyondLimit', ARRAY['admin']),
  (30, 'serviceRequests.read', ARRAY['admin','shtab','rukstroy','site','department','department_head','observer']),
  (31, 'serviceRequests.create', ARRAY['admin','shtab','rukstroy','site','department','department_head']),
  (32, 'serviceRequests.update', ARRAY['admin','shtab','rukstroy','site','department','department_head']),
  (33, 'serviceRequests.delete', ARRAY['admin','shtab','rukstroy','site','department','department_head']),
  (34, 'serviceRequests.assign', ARRAY['admin']),
  (35, 'serviceRequests.estimate', ARRAY['admin']),
  (36, 'serviceRequests.approveEstimate', ARRAY['admin']),
  (37, 'serviceRequests.approveIt', ARRAY['admin']),
  (38, 'serviceRequests.status', ARRAY['admin']),
  (39, 'serviceRequests.files', ARRAY['admin','shtab','rukstroy','site','department','department_head']),
  (40, 'officeEquipment.read', ARRAY['admin','manager','dispatcher','shtab','rukstroy','site','department','department_head','observer']),
  (41, 'officeEquipment.write', ARRAY['admin','manager','dispatcher']),
  (42, 'garage.read', ARRAY['admin','manager','dispatcher','mechanic','chief_mechanic']),
  (43, 'driverCabinet.read', ARRAY['admin','driver']),
  (44, 'driverCabinet.submit', ARRAY['admin','driver']),
  (45, 'vehicleReadings.read', ARRAY['admin','manager','dispatcher']),
  (46, 'vehicleReadings.write', ARRAY['admin','manager','dispatcher']),
  (47, 'vehicleMaintenance.read', ARRAY['admin','manager','dispatcher','mechanic','chief_mechanic']),
  (48, 'vehicleMaintenance.write', ARRAY['admin','manager','dispatcher','mechanic','chief_mechanic']),
  (49, 'archive.read', ARRAY['admin']),
  (50, 'archive.restore', ARRAY['admin']),
  (51, 'requests.rollbackStatus', ARRAY['admin','dispatcher']),
  (52, 'records.purge', ARRAY['admin']),
  (53, 'files.manageAny', ARRAY['admin','manager','dispatcher']),
  (54, 'users.manage', ARRAY['admin']),
  (55, 'audit.read', ARRAY['admin']),
  (56, 'mailings.read', ARRAY['admin','dispatcher']),
  (57, 'mailings.manage', ARRAY['admin','dispatcher'])
),
-- Снимок `COUNTERPARTY_TYPE_PERMISSIONS` (ADR 0038): у внешнего исполнителя модуль задаёт тип его
-- контрагента, а не роль. Без этого слагаемого арендодатель и оператор вывоза выпали бы из любой
-- аудитории — то есть переезд молча отобрал бы у них письма.
cp_perm (permission, types) AS (VALUES
  ('wasteRequests.read', ARRAY['operator']::text[]),
  ('wasteRequests.status', ARRAY['operator']),
  ('wasteRequests.operatorComment', ARRAY['operator']),
  ('vehicleRequests.read', ARRAY['vehicle_lessor']),
  ('vehicleRequests.status', ARRAY['vehicle_lessor']),
  ('weeklyRequests.read', ARRAY['vehicle_lessor']),
  ('serviceRequests.read', ARRAY['service']),
  ('serviceRequests.estimate', ARRAY['service']),
  ('serviceRequests.status', ARRAY['service']),
  ('serviceRequests.files', ARRAY['service'])
),
-- Действующие учётки: сравнивать аудитории имеет смысл только на тех, кому вообще пишут.
live AS (
  SELECT u.id, u.role::text AS role, u.counterparty_id
    FROM users u
   WHERE u.is_active AND u.deleted_at IS NULL AND u.role IS NOT NULL
),
-- Эффективное право учётки — те же три источника и в том же порядке, что у `can`: роль, тип
-- контрагента, назначенный набор (ADR 0106). Надстроек роли здесь нет: с шага 1c они отражаются в
-- `user_grants` двойной записью, и второй источник того же права дал бы тот же ответ.
eff AS (
  SELECT l.id AS user_id, rp.permission
    FROM live l
    JOIN role_perm rp ON l.role = ANY (rp.roles)
  UNION
  SELECT l.id, cp.permission
    FROM live l
    JOIN counterparties c ON c.id = l.counterparty_id
    JOIN cp_perm cp ON c.type::text = ANY (cp.types)
   WHERE l.role = 'operator'
  UNION
  SELECT l.id, gp.permission
    FROM live l
    JOIN user_grants ug ON ug.user_id = l.id
    -- Мягко удалённый набор не действует ни у кого; соединение с ролью — гейт совместимости:
    -- набор, выданный до смены роли, прав больше не даёт.
    JOIN grants g ON g.id = ug.grant_id AND g.deleted_at IS NULL
    JOIN grant_roles gr ON gr.grant_id = ug.grant_id AND gr.role::text = l.role
    JOIN grant_permissions gp ON gp.grant_id = ug.grant_id
),
-- Кому сводка вообще может прийти: модуль заказов техники. См. «критерий равенства» в шапке.
capable AS (SELECT user_id FROM eff WHERE permission = 'vehicleRequests.read'),
-- Адресаты «до» — по нынешним ролям расписания.
before_set AS (
  SELECT r.schedule_id, array_agg(DISTINCT l.id ORDER BY l.id) AS ids
    FROM mailing_schedule_roles r
    JOIN mailing_schedules s ON s.id = r.schedule_id AND s.type = 'role_digest'
    JOIN live l ON l.role = r.role::text
    JOIN capable c ON c.user_id = l.id
   GROUP BY r.schedule_id
),
-- Адресаты «после» — по каждому праву-кандидату. Право, у которого адресатов нет вовсе, сюда не
-- попадает, и пустая аудитория ни с чем не «совпадёт»: расписание, никому сегодня не пишущее,
-- обязан разобрать человек, а не миграция.
after_set AS (
  SELECT e.permission, array_agg(DISTINCT e.user_id ORDER BY e.user_id) AS ids
    FROM eff e
    JOIN capable c ON c.user_id = e.user_id
   GROUP BY e.permission
)
INSERT INTO mailing_schedule_permissions (schedule_id, permission)
-- Подходящих прав бывает несколько — на живых данных они дают один и тот же список, а завтра
-- разойдутся. Выбирается одно, и правило выбора объявлено: сначала право самого модуля сводки
-- (`vehicleRequests.read` — «кто ведёт заказы техники», ровно то, что имел в виду заказчик), затем
-- порядок словаря прав. Остальные равнозначные варианты называет `check:mailing-audience`.
SELECT DISTINCT ON (b.schedule_id) b.schedule_id, a.permission
  FROM before_set b
  JOIN after_set a ON a.ids = b.ids
  JOIN role_perm rp ON rp.permission = a.permission
 ORDER BY b.schedule_id, (a.permission = 'vehicleRequests.read') DESC, rp.ord
    ON CONFLICT DO NOTHING;
