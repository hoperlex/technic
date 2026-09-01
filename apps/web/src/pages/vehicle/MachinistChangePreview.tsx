import { Alert, Space, Typography } from 'antd';
import type { AssignmentPreviewDto } from '@technic/contracts';
import { TailMismatchAlert } from './AssignmentHistoryPanel';
import { driverStateLabel, type AssignmentSegment } from './assignmentTimeline';
import { formatDateOnly } from './shared';

/**
 * Цена смены машиниста, прочитанная человеком **до** нажатия (этап 6 плана
 * `docs/assignment-periods-plan.md`, §7): какие номера ЭСМ-2 сгорят и какие выпишутся, какие
 * отработанные недели придётся переоформить и попадёт ли операция в журнал коррекций.
 *
 * Отдельным файлом от окна, по той же границе, что `ReassignPreview` отделён от `VehicleAssignModal`:
 * там форма — поля, правила и отправка, — а здесь перечень последствий, который к вводу не
 * относится вовсе.
 *
 * Считать здесь нечего: всё приходит готовым от сервера и посчитано тем же расчётом, который потом
 * отработает. Второй расчёт в портале разошёлся бы с первым — и окно обещало бы не то.
 *
 * Чего здесь нет и почему. `requiredAnchors` не рисуются: их непустота означает **первую фазу**
 * предпросмотра (Р16) — набор последствий ещё неизвестен, и показывать рядом с вопросом «кто
 * работал в эти дни» половину плана значило бы выдавать её за окончательную. Спрашивает имена само
 * окно. `blockedShiftDays` и `clearedShiftDays` эта дверь не заполняет никогда: смена машиниста
 * подписей не снимает и часов не удаляет (Р11), и пустой блок обещал бы разговор, которого не будет.
 */

/**
 * Говорить не о чем: бумага не тронется, отработанных недель под переоформление нет и в журнал
 * ничего не попадёт. Такую команду окно отправляет сразу, вторым экраном не задерживая, — пустое
 * «ничего не произойдёт, нажмите ещё раз» приучает нажимать не читая, и тогда экран перестаёт
 * работать в тот единственный раз, когда сказать ему есть что.
 *
 * Отпечаток при этом всё равно уезжает с командой: предпросмотр состоялся, просто человека им не
 * беспокоили.
 */
export function machinistPreviewIsSilent(preview: AssignmentPreviewDto): boolean {
  return (
    preview.plan.cancel.length === 0 &&
    preview.plan.issue.length === 0 &&
    preview.requiredUnlocks.length === 0 &&
    preview.requiredAnchors.length === 0 &&
    preview.requiredVehicleResolution === null &&
    preview.operationRequirement === null
  );
}

const listStyle = { margin: '4px 0 0', paddingInlineStart: 20 } as const;

interface Props {
  preview: AssignmentPreviewDto;
  /**
   * Отрезок, решение которого гасят (В2). Не передан — команда назначает человека, а не снимает
   * решение: гасить нечего.
   */
  cancelling?: AssignmentSegment | null;
  /** Имя машиниста по идентификатору — для состава гасимой группы. */
  driverName: (personId: string) => string | undefined;
  /**
   * Почему окно вернулось к последствиям само: сервер ответил, что показанное устарело. `null` —
   * человек пришёл сюда обычным порядком.
   */
  staleReason?: string | null;
}

export function MachinistChangePreview({ preview, cancelling, driverName, staleReason }: Props) {
  const { cancel, issue } = preview.plan;

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

      {/* Расхождение хвоста, если сервер его назвал. Поле общее у пяти дверей модуля (§7), и
        молчание портала о непустом ответе означало бы отказ без объяснения. */}
      {preview.requiredVehicleResolution && (
        <TailMismatchAlert tail={preview.requiredVehicleResolution} />
      )}

      {/* Гашение группы — то, ради чего у отмены вообще заведено рукопожатие (В2). Гасится всегда
        вся группа, а не одна строка: погасив решение о технике и оставив его спутника, портал
        получил бы отрезок «собственная машина без машиниста». Поэтому состав называется целиком. */}
      {cancelling && <CancelGroupAlert segment={cancelling} driverName={driverName} />}

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
        уже кончилась. Перечень серверный, и стоит он рядом с планом нарочно: им объясняется,
        откуда в списке сгорающих взялись прошлые недели. */}
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

      {/* Исход операции считает сервер (Р32), а не календарь на клиенте: плановая смена на
        понедельник причины не требует, а отмена решения с прошлогодней датой требует. Портал
        только называет вслух то, что решил сервер. */}
      {preview.operationRequirement && (
        <div>
          <Typography.Text strong>Журнал коррекций</Typography.Text>
          <div>
            <Typography.Text type="secondary">
              {preview.operationRequirement.kind === 'crew'
                ? 'Команда правит уже прошедшие дни — она попадёт в журнал вместе с причиной, и причина напечатается в переоформленных листах.'
                : 'Команда правит уже принятое решение — она попадёт в журнал вместе с причиной.'}
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

/**
 * Отказ по правам (Р32): коррекционные права спрашивает сервер и **по посчитанному исходу**, а не
 * по календарю — из тела команды не видно, задевает ли она отработанные дни. Поэтому отказ
 * приходит уже после того, как человек прочитал последствия, — и показывать его надо там же, где
 * он читал, вместе с тем, что делать дальше. Тост в углу оставил бы окно выглядящим сломанным.
 */
export function MachinistForbiddenAlert({ message }: { message: string }) {
  return (
    <Alert
      type="error"
      showIcon
      title="Команду не провести: не хватает прав"
      description={
        <>
          <div>{message}</div>
          <div style={{ marginTop: 8 }}>
            Ничего не записано. Попросите провести эту смену того, у кого есть право коррекции
            задним числом, — либо назначьте человека датой, с которой работа ещё не началась.
          </div>
        </>
      }
    />
  );
}

/**
 * Что останется после гашения — и это разные ответы, а не оттенки одного.
 *
 * Снятая граница хвоста снова открывает вопрос «чем заявка закрыта после конца срока» и вместе с
 * ним запирает продление (Р31); дремлющее решение о человеке не запирает ничего — работы за ним
 * ещё не было; отмена будущего решения внутри срока возвращает на эти дни прежний состав.
 */
function cancelAftermath(segment: AssignmentSegment): string {
  if (segment.starts.some((row) => row.dimension === 'vehicle')) {
    return 'После отмены за концом срока снова не будет решения о том, чем заявка закрыта дальше, — и продлить её не выйдет, пока это решение не примут заново.';
  }
  if (segment.dormant) {
    return 'Решение ещё не действовало: срок до этих дней не доходит, и работы за ним нет.';
  }
  return 'После отмены на эти дни вернётся состав предыдущего отрезка.';
}

/** Что именно погаснет: даты, шкалы и состав решения — целиком, потому что гашение групповое. */
function CancelGroupAlert({
  segment,
  driverName,
}: {
  segment: AssignmentSegment;
  driverName: (personId: string) => string | undefined;
}) {
  return (
    <Alert
      type="warning"
      showIcon
      title={`Погаснет решение с ${formatDateOnly(segment.from)}`}
      description={
        <>
          <div>
            Гасится всё решение целиком, а не одна его строка: снять запись о технике и оставить
            рядом запись о человеке значило бы получить отрезок с машиной, за которой никого нет.
          </div>
          <ul style={{ margin: '8px 0 0', paddingInlineStart: 20 }}>
            {segment.starts.map((row) => (
              <li key={`${row.dimension}@${row.effectiveDate}`}>
                {row.dimension === 'vehicle'
                  ? `Техника: ${row.vehicle?.name ?? 'не названа'}`
                  : `Машинист: ${driverStateLabel(row.driver, driverName)}`}
              </li>
            ))}
          </ul>
          <div style={{ marginTop: 8 }}>{cancelAftermath(segment)}</div>
        </>
      }
    />
  );
}
