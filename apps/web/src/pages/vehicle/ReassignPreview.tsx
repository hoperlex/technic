import { Alert, Space, Typography } from 'antd';
import { type AssignmentPreviewDto, workedAmountLabel } from '@technic/contracts';
import { isApiError } from '@shared/api';
import { formatDateOnly } from './shared';

/**
 * Цена смены техники, прочитанная человеком **до** нажатия (волна 4a плана
 * `docs/assignment-periods-plan.md`, §7): какие номера ЭСМ-2 сгорят и какие выпишутся, какие
 * подписи объекта слетят, каких дней не хватает машинисту.
 *
 * Отдельным файлом от `VehicleAssignModal`, по той же границе, что и `RollbackPreview`: там форма —
 * поля, правила и отправка, — а здесь перечень последствий, который к вводу не относится вовсе и
 * растёт от каждой новой двери заднего числа.
 *
 * Считать здесь нечего: всё приходит готовым от сервера
 * (`POST /vehicle-requests/:id/assignment/preview`) и посчитано тем же расчётом, который потом
 * отработает (`planReassignCommand`). Второй расчёт в портале разошёлся бы с первым — и окно
 * обещало бы не то, что произойдёт.
 *
 * Чего здесь нет и почему. `requiredVehicleResolution` у этой двери пуст всегда: расхождение хвоста
 * запирает расширение срока, а смена техники новых дней не открывает. `issues` — предупреждения по
 * каждому выписываемому листу — в этой волне сервер не считает вовсе и отдаёт пустыми; рисовать
 * пустой блок значило бы обещать разговор, которого не будет.
 */

/** 409, на котором окно не ругается, а переспрашивает: последствия успели измениться (Р32, И5). */
export const ASSIGNMENT_PREVIEW_STALE = 'assignment_preview_stale';
/**
 * 409 клиенту без отпечатка — после переключения чтения (И5). Портал волны 4a отпечаток шлёт
 * всегда, кроме одного случая: сервер оказался старее и ручки предпросмотра у него нет вовсе. Тогда
 * этот отказ и приходит — и лечится он тем же, чем устаревший отпечаток: посмотреть последствия.
 */
export const ASSIGNMENT_CLIENT_UPGRADE = 'client_upgrade_required';

/**
 * Отказ, после которого окно возвращает человека к последствиям, — и слова, которыми объясняет
 * возврат. `null` — отказ чужой, и показывать его окну нечем: о нём скажет тот, кто отправлял.
 *
 * Разбор по коду, а не по статусу: 409 у этой ручки бывает и конфликтом версии заявки, а он лечится
 * не пересмотром последствий, а перезагрузкой списка.
 */
export function reassignStaleReason(e: unknown): string | null {
  if (!isApiError(e)) return null;
  if (e.code === ASSIGNMENT_PREVIEW_STALE) {
    return 'Последствия изменились с того момента, как вы их смотрели, — вот что произойдёт теперь. Прочитайте и подтвердите заново.';
  }
  /*
   * Здесь сверяется и статус, хотя соседняя ветка обходится кодом. Тот же литерал носит теперь
   * отказ гейта версии клиента (ADR 0146, решение 7) — но со статусом 426 и с другим разговором:
   * там лечит перезагрузка страницы, а не просмотр последствий. Приняв его за свой, окно
   * подсунуло бы человеку предпросмотр вместо требования обновиться.
   */
  if (e.status === 409 && e.code === ASSIGNMENT_CLIENT_UPGRADE) {
    return 'Смена техники теперь идёт через просмотр последствий — вот они. Прочитайте и подтвердите.';
  }
  return null;
}

/**
 * Говорить не о чем: бумага не тронется, подписи останутся, пробелов нет и в журнал ничего не
 * попадёт. Такую смену окно отправляет сразу, вторым экраном не задерживая, — «ничего не произойдёт,
 * нажмите ещё раз» приучает нажимать не читая, и тогда экран перестаёт работать в тот единственный
 * раз, когда сказать ему есть что.
 *
 * Отпечаток при этом всё равно уезжает с командой: предпросмотр состоялся, просто человека им не
 * беспокоили.
 */
export function reassignPreviewIsSilent(preview: AssignmentPreviewDto): boolean {
  return (
    preview.plan.cancel.length === 0 &&
    preview.plan.issue.length === 0 &&
    preview.requiredUnlocks.length === 0 &&
    preview.blockedShiftDays.length === 0 &&
    preview.clearedShiftDays.length === 0 &&
    preview.requiredAnchors.length === 0 &&
    preview.operationRequirement === null
  );
}

/**
 * Команды не будет: часы этих дней подписаны объектом, и подмена машины переписала бы задним
 * числом то, под чем стоит подпись. Тем же условием отвечает сервер (422 `Есть согласованные
 * смены`), поэтому кнопка гасится — вести человека в отказ окно не должно.
 */
export function reassignPreviewBlocked(preview: AssignmentPreviewDto): boolean {
  return preview.blockedShiftDays.length > 0;
}

/** Сколько всего снимается — числом, а не длиной списка: цена должна читаться одной строкой. */
function totalOf(days: readonly { hours: number }[]): string {
  const hours = days.reduce((sum, day) => sum + day.hours, 0);
  return `Всего дней: ${days.length} · ${workedAmountLabel('hours', hours)}`;
}

const listStyle = { margin: '4px 0 0', paddingInlineStart: 20 } as const;

interface Props {
  preview: AssignmentPreviewDto;
  /**
   * Почему окно вернулось к последствиям само: сервер ответил, что показанное устарело. `null` —
   * человек пришёл сюда обычным порядком, нажав «Сменить технику».
   */
  staleReason?: string | null;
}

export function ReassignPreview({ preview, staleReason }: Props) {
  const { cancel, issue } = preview.plan;
  const blocked = preview.blockedShiftDays;
  const cleared = preview.clearedShiftDays;

  return (
    <Space orientation="vertical" size={12} style={{ display: 'flex' }}>
      {staleReason && (
        <Alert
          type="warning"
          showIcon
          title="Последствия пересчитаны"
          description={staleReason}
        />
      )}

      {/* Замок подписанных дней — первым: всё, что ниже, при нём не случится вовсе, и читать
        перечень бумаги раньше запрета значило бы читать его зря. Выход назван прямо: подпись
        снимает не смена техники, а коррекция задним числом. */}
      {blocked.length > 0 && (
        <Alert
          type="error"
          showIcon
          title="Сменить технику нельзя: дни уже подписаны объектом"
          description={
            <>
              <div>
                Часы этих дней приняты, и смена машины переписала бы задним числом то, под чем стоит
                подпись. Снять её можно только коррекцией — вернитесь и отметьте «Исправить задним
                числом: работала другая машина».
              </div>
              <ul style={listStyle}>
                {blocked.map((day) => (
                  <li key={day.date}>
                    {formatDateOnly(day.date)} — {workedAmountLabel('hours', day.hours)}
                  </li>
                ))}
              </ul>
              <Typography.Text type="secondary">{totalOf(blocked)}</Typography.Text>
            </>
          }
        />
      )}

      <div>
        <Typography.Text strong>Путевые листы ЭСМ-2</Typography.Text>
        {cancel.length === 0 && issue.length === 0 ? (
          <div>
            <Typography.Text type="secondary">
              Останутся как есть: аннулировать и выписывать нечего.
            </Typography.Text>
          </div>
        ) : (
          <ul style={listStyle}>
            {cancel.map((sheet) => (
              <li key={sheet.waybillId}>
                Сгорит № {sheet.displayNumber} за {formatDateOnly(sheet.from)} —{' '}
                {formatDateOnly(sheet.to)}
              </li>
            ))}
            {/* Состав, а не одни границы: за неделю на объекте выходят разные машины и разные
              люди, и «выпишется лист за 10–16 августа» не отвечает на вопрос, чьей фамилией. */}
            {issue.map((sheet) => (
              <li key={sheet.issueKey}>
                Выпишется лист за {formatDateOnly(sheet.from)} — {formatDateOnly(sheet.to)}:{' '}
                {sheet.vehicleName}, машинист {sheet.driverName}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Разблокировка отработанных недель (Р11): эти номера сверка сама не тронула бы — их неделя
        уже кончилась. Перечень серверный, и стоит он рядом с планом нарочно: им объясняется, откуда
        в списке сгорающих взялись прошлые недели. */}
      {preview.requiredUnlocks.length > 0 && (
        <div>
          <Typography.Text strong>Отработанные недели</Typography.Text>
          <div>
            <Typography.Text type="secondary">
              Их неделя уже закрыта — эти листы переоформляются только разблокировкой:
            </Typography.Text>
          </div>
          <ul style={listStyle}>
            {preview.requiredUnlocks.map((sheet) => (
              <li key={sheet.waybillId}>
                № {sheet.displayNumber} за {formatDateOnly(sheet.from)} — {formatDateOnly(sheet.to)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Подписи объекта. Сегодня эта дверь их именно **снимает**, а часы оставляет
        (`clearShiftApprovals`): удаление заполненных без подписи часов приходит вместе с разрезом
        срока, и обещать его сейчас нельзя. Часы показаны при каждом дне и суммой — цена
        подтверждения должна быть видна, а не подразумеваться. */}
      {cleared.length > 0 && (
        <div>
          <Typography.Text strong>Подписи объекта</Typography.Text>
          <div>
            <Typography.Text type="secondary">
              Слетят с этих дней: часы останутся, но принять их объекту придётся заново — уже по той
              машине, которая работала на самом деле.
            </Typography.Text>
          </div>
          <ul style={listStyle}>
            {cleared.map((day) => (
              <li key={day.date}>
                {formatDateOnly(day.date)} — {workedAmountLabel('hours', day.hours)}
              </li>
            ))}
          </ul>
          <Typography.Text type="secondary">{totalOf(cleared)}</Typography.Text>
        </div>
      )}

      {/* Пробелы машиниста (Р16). Смену техники они сегодня не останавливают — история назначений
        ещё не ведётся, и запретить здесь значило бы отнять работающее действие. Но молчать о них
        нельзя: пока за эти дни не назван человек, лист ЭСМ-2 за них не выписать. */}
      {preview.requiredAnchors.length > 0 && (
        <div>
          <Typography.Text strong>Машинист неизвестен</Typography.Text>
          <div>
            <Typography.Text type="secondary">
              История этих дней восстановлена не полностью. Смене техники это не мешает, но пока
              человек не назван, лист ЭСМ-2 за такие дни выписать нечем:
            </Typography.Text>
          </div>
          <ul style={listStyle}>
            {preview.requiredAnchors.map((gap) => (
              <li key={`${gap.requestId}@${gap.effectiveDate}`}>
                {formatDateOnly(gap.from)} — {formatDateOnly(gap.to)} · заявка {gap.requestNumber}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Исход операции считает сервер (Р32), а не календарь на клиенте: плановая смена на будущее
        причины не требует, а правка прошедших дней требует всегда. Портал только называет вслух то,
        что решил сервер, — вторая редакция матрицы разошлась бы с серверной на первом уточнении. */}
      {preview.operationRequirement && (
        <div>
          <Typography.Text strong>Журнал коррекций</Typography.Text>
          <div>
            <Typography.Text type="secondary">
              {preview.operationRequirement.kind === 'crew'
                ? 'Операция правит уже прошедшие дни — она попадёт в журнал вместе с причиной, и причина напечатается в обоих листах.'
                : 'Операция правит уже принятое решение — она попадёт в журнал вместе с причиной.'}
            </Typography.Text>
          </div>
        </div>
      )}

      {/* День расчёта входит в отпечаток: предпросмотр, сделанный вчера, не сойдётся с командой
        сегодня, даже если ничего больше не изменилось. Сказать это здесь дешевле, чем объяснять
        человеку неожиданный отказ после полуночи. */}
      <Typography.Text type="secondary">
        Последствия посчитаны на {formatDateOnly(preview.asOf)}.
      </Typography.Text>
    </Space>
  );
}
