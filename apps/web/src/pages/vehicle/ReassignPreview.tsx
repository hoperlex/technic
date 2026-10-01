import { Alert, Space, Typography } from 'antd';
import { type AssignmentPreviewDto, workedAmountLabel } from '@technic/contracts';
import { formatDateOnly } from '@shared/lib';
import { listStyle, totalOf } from './consequencesList';

/**
 * Render the server-owned cost of a vehicle change before confirmation: replaced ESM-2 sheets,
 * cleared site approvals, locked work days, and missing machinist anchors.
 *
 * This component deliberately performs no parallel calculation. The same server plan is displayed
 * here and executed by the command; pure decisions about silent, blocked, or stale previews live in
 * `@features/vehicle-assignment`. Per-sheet warning confirmations stay beside the command in
 * `reassignConsequences.tsx`.
 */

interface Props {
  preview: AssignmentPreviewDto;
  /** Why the dialog returned after the server rejected a stale preview. */
  staleReason?: string | null;
}

export function ReassignPreview({ preview, staleReason }: Props) {
  const { cancel, issue } = preview.plan;
  const blocked = preview.blockedShiftDays;
  const cleared = preview.clearedShiftDays;

  return (
    <Space orientation="vertical" size={12} style={{ display: 'flex' }}>
      {staleReason && (
        <Alert type="warning" showIcon title="Последствия пересчитаны" description={staleReason} />
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
