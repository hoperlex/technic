import { Alert, Checkbox, Form, Input, Space, Typography } from 'antd';
import { type CompletionPreviewDto, workedAmountLabel } from '@technic/contracts';
import { cancelGroupLine } from './cancelGroups';
import { formatDateOnly } from './shared';
import { listStyle, totalOf } from './consequencesList';

/**
 * Цена закрытия заказа фактической датой, прочитанная человеком **до** нажатия (ADR 0178, план
 * `docs/vehicle-request-actual-end-date-plan.md`, Р1, Р22).
 *
 * Отдельным файлом от `VehicleCompleteModal` по той же границе, что `RollbackPreview` и
 * `ReassignPreview` отделены от окна назначения: там форма — поля, правила и отправка, — а здесь
 * перечень последствий, который к вводу не относится вовсе и растёт от каждой новой двери.
 *
 * СЧИТАТЬ ЗДЕСЬ НЕЧЕГО. Всё приходит готовым от сервера
 * (`POST /vehicle-requests/:id/completion/preview`) и посчитано тем же расчётом, который потом
 * отработает (`planCompletionCommand`). Вторая, портальная редакция правил разошлась бы с серверной
 * на первом же уточнении — и окно начало бы обещать не то, что произойдёт.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ:
 *
 * - **сокращаемые листы поимённо**. Правка периода (`trim`) — главное, ради чего волна писалась, —
 *   в DTO предпросмотра не приезжает: `AssignmentPreviewDto.plan` знает только `cancel` и `issue`,
 *   а поля под правки в общем контракте ещё нет (запись Э9 в §7 плана: `AssignmentPlanTrimDto` не
 *   заведён). Поэтому окно называет **правило** — «лист недели, в которую попал последний рабочий
 *   день, сократится по него, номер не сгорит», — а не номер и не число. Правило верно при любом
 *   плане, и это честнее, чем молчание: без него человек читал бы «аннулировать и выписывать
 *   нечего» и решал, что бумага не тронется вовсе;
 * - **`blockedShiftDays` и `linearDays.frozen`**. На успешном ответе они пусты **всегда**:
 *   подписанный объектом день за границей факта и день, замороженный выданным листом, отвергают
 *   команду целиком и ещё в расчёте (Р10, Р11) — человек читает перечень в тексте отказа, а не
 *   здесь. Рисовать блок, который не заполняется никогда, значило бы обещать разговор, которого не
 *   будет;
 * - **`issues`** — предупреждения по каждому выписываемому листу: у недельной сверки просителя нет
 *   вовсе, и сервер отдаёт их пустыми.
 */


interface Props {
  preview: CompletionPreviewDto;
  /**
   * Почему окно вернулось к последствиям само: сервер ответил, что показанное устарело. `null` —
   * человек пришёл сюда обычным порядком, заполнив факт.
   */
  staleReason?: string | null;
}

export function CompletionConsequences({ preview, staleReason }: Props) {
  const { cancel, issue } = preview.plan;
  const { endedOn, previousDateTo } = preview.completion;
  /*
   * Срок двигается только сокращением: закрытие ровно по концу срока колонку не трогает вовсе — так
   * же решает и сервер (`termAfter` равен прежнему при `endedOn === previousDateTo`). У
   * арендодательской ветви до этого экрана дело не доходит: она предпросмотра не зовёт.
   */
  const shortens = endedOn !== null && endedOn < previousDateTo;
  const detachable = preview.linearDays.detachable;
  const cleared = preview.clearedShiftDays;

  return (
    <Space orientation="vertical" size={12} style={{ display: 'flex' }}>
      {staleReason && (
        <Alert type="warning" showIcon title="Последствия пересчитаны" description={staleReason} />
      )}

      {/* Чем закрываем и что станет со сроком — первой строкой: всё остальное следствие этой пары
        дат, и читать перечень раньше неё значило бы читать его без основания. */}
      <div style={{ lineHeight: 1.6 }}>
        <Typography.Text strong>
          {endedOn ? `Закрываем ${formatDateOnly(endedOn)}` : 'Закрываем без фактической даты'}
        </Typography.Text>
        <div>
          <Typography.Text type="secondary">
            {shortens
              ? `Срок работ сократится: было по ${formatDateOnly(previousDateTo)}, станет по ${formatDateOnly(endedOn!)}. Техника перестанет числиться занятой на оставшиеся дни.`
              : `Последний день срока — ${formatDateOnly(previousDateTo)}: работы кончились ровно по нему, и срок не двигается.`}
          </Typography.Text>
        </div>
      </div>

      <div>
        <Typography.Text strong>Путевые листы ЭСМ-2</Typography.Text>
        {cancel.length === 0 && issue.length === 0 ? (
          <div>
            <Typography.Text type="secondary">Аннулировать и выписывать нечего.</Typography.Text>
          </div>
        ) : (
          <ul style={listStyle}>
            {cancel.map((sheet) => (
              <li key={sheet.waybillId}>
                Сгорит № {sheet.displayNumber} за {formatDateOnly(sheet.from)} —{' '}
                {formatDateOnly(sheet.to)}: работ в этот период не было
              </li>
            ))}
            {issue.map((sheet) => (
              <li key={sheet.issueKey}>
                Выпишется лист за {formatDateOnly(sheet.from)} — {formatDateOnly(sheet.to)}:{' '}
                {sheet.vehicleName}, машинист {sheet.driverName}
              </li>
            ))}
          </ul>
        )}
        {/* Правило, а не число (см. шапку файла): сколько именно листов сократится, предпросмотр
          сегодня не отдаёт, а умолчать нельзя — иначе «аннулировать нечего» читается как «бумага
          не тронется». Заодно называется и то, ради чего волна писалась: номер остаётся жив. */}
        {shortens && (
          <div style={{ marginTop: 4 }}>
            <Typography.Text type="secondary">
              Лист недели, в которую попал последний рабочий день, будет сокращён по{' '}
              {formatDateOnly(endedOn!)}: номер бланка останется прежним, заново он не выписывается,
              и площадка ничего не переподписывает. В выданном на руки экземпляре печатная графа
              «Период работы» остаётся прежней — отработанное сверяют по заполненным строкам.
            </Typography.Text>
          </div>
        )}
      </div>

      {/* Разблокировка отработанных недель (Р8): их неделя уже закрыта, и сверка сама эти номера не
        тронула бы. Перечень серверный, и стоит он рядом с планом нарочно — им объясняется, откуда в
        списке сгорающих взялись прошлые недели. */}
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

      {/* Часы за границей факта. Заполненные без подписи закрытие **стирает**: этих дней у заказа
        больше нет, и часы по ним относились бы к работе, которой не было. Подписанные объектом
        сюда не попадают вовсе — на них команда отказывается целиком и ещё до первой записи. */}
      {cleared.length > 0 && (
        <div>
          <Typography.Text strong>Часы за фактической датой</Typography.Text>
          <div>
            <Typography.Text type="secondary">
              Будут стёрты: эти дни уходят из срока, а часы по ним объект не принимал.
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

      {/* Дни линейного заказа (Р11, Р27). Снимаются ровно те, что за фактической датой: отработанные
        остаются в своих рейсах — рейс состоявшегося дня отвечает на вопрос «чей это был выезд», и
        после закрытия он обязан читаться. Рейс при этом жив, уходит из него только сама заявка. */}
      {detachable.length > 0 && (
        <div>
          <Typography.Text strong>Дни в рейсах</Typography.Text>
          <div>
            <Typography.Text type="secondary">
              Уйдут из рейсов — этих дней у заказа больше не будет. Отработанные дни внутри факта
              остаются на своих местах:
            </Typography.Text>
          </div>
          <ul style={listStyle}>
            {detachable.map((day) => (
              <li key={`${day.date}@${day.routeNumber}`}>
                {formatDateOnly(day.date)} — рейс {day.routeNumber}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Гашение — то, ради чего у сокращения срока вообще появилось рукопожатие (Д2). Текст говорит
        человеческим языком: что погаснет и почему это нельзя оставить как есть. */}
      {preview.cancelGroups.length > 0 && (
        <Alert
          type="warning"
          showIcon
          title="Вместе со сроком погаснут записи о технике"
          description={
            <>
              <div>
                За фактической датой остаются решения о том, какая техника и какой машинист работают
                по заявке. Оставить их нельзя: при следующем продлении они ожили бы сами — без
                разговора о ставках и занятости.
              </div>
              <ul style={listStyle}>
                {preview.cancelGroups.map((group) => (
                  <li key={group.changeGroupId}>{cancelGroupLine(group)}</li>
                ))}
              </ul>
            </>
          }
        />
      )}

      {/* Исход операции считает сервер (Р8, Р32 плана периодов), а не календарь на клиенте:
        закрытие сегодняшним днём коррекции не требует, а закрытие задним числом и гашение
        отработанной группы требуют. Портал только называет вслух то, что решил сервер. */}
      {preview.operationRequirement && (
        <div>
          <Typography.Text strong>Журнал коррекций</Typography.Text>
          <div>
            <Typography.Text type="secondary">
              {preview.operationRequirement.kind === 'crew'
                ? 'Закрытие задевает уже отработанные дни — оно пойдёт записью в журнал коррекций, и без объяснения его там быть не может.'
                : 'Закрытие гасит принятые решения о технике — оно пойдёт записью в журнал коррекций, и без объяснения его там быть не может.'}
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
 * Подтверждения второго шага: галочка под перечнем гасимых решений и причина записи в журнал
 * коррекций (Д2 плана периодов, Р8).
 *
 * Стоят здесь, а не в форме факта, потому что относятся к прочитанному: галочка подтверждает
 * **этот** перечень, а причина объясняет **эту** правку прошлого. Спрашивать их раньше, чем
 * последствия посчитаны, было бы не у чего: нужны они или нет, решает ответ сервера, а не форма.
 *
 * Оба поля живут в той же форме, что и факт (`Form` окна), — поэтому проверяются одним нажатием
 * вместе с ним: два разных ответа на «можно ли отправлять» разъехались бы при первой правке.
 */
export function CompletionHandshakeFields({ preview }: { preview: CompletionPreviewDto }) {
  return (
    <>
      {preview.cancelGroups.length > 0 && (
        <Form.Item
          name="cancelAck"
          valuePropName="checked"
          style={{ marginTop: 12, marginBottom: 0 }}
          rules={[
            {
              validator: (_r, value: boolean | undefined) =>
                value
                  ? Promise.resolve()
                  : Promise.reject(
                      new Error('Подтвердите, что перечисленные записи о технике погаснут'),
                    ),
            },
          ]}
        >
          <Checkbox>Согласен: перечисленные записи о технике погаснут</Checkbox>
        </Form.Item>
      )}

      {preview.operationRequirement && (
        <Form.Item
          name="reason"
          label="Причина закрытия задним числом"
          style={{ marginTop: 12, marginBottom: 0 }}
          extra={
            preview.operationRequirement.kind === 'crew'
              ? 'Закрытие задевает уже отработанные дни: оно пойдёт записью в журнал коррекций, и без объяснения его там быть не может.'
              : 'Закрытие гасит принятые решения о технике: оно пойдёт записью в журнал коррекций, и без объяснения его там быть не может.'
          }
          rules={[{ required: true, message: 'Укажите причину' }]}
        >
          <Input.TextArea
            rows={2}
            maxLength={2000}
            showCount
            placeholder="Например: закрываем задним числом — акт подписали на объекте только сегодня"
          />
        </Form.Item>
      )}
    </>
  );
}
