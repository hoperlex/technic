import { useEffect, useState } from 'react';
import { Alert, App, DatePicker, Divider, Input, InputNumber, Space, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  canCoordinateServiceRequests,
  serviceRequestNeedsEstimate,
  type ServiceRequestDto,
} from '@technic/contracts';
import {
  consumableFactIssue,
  consumableFactPayload,
  consumableFactRows,
  consumableFailureText,
  ServiceConsumableFactRows,
  ServiceHint,
  ServiceRequestContext,
  serviceRequestKeys,
  serviceRequestsApi,
  type ConsumableFactRow,
} from '@entities/service-request';
import { officeEquipmentConsumableKeys, officeEquipmentKeys } from '@entities/office-equipment';
import { FormModal } from '@shared/ui';
import { errorMessage } from '@shared/lib';
import { factIssue, factRowsFrom, factToPayload, factTotal, type FactRow } from '../model/fact';
import { CompleteRows } from './CompleteRows';
import { useAuth } from '../../../auth/AuthContext';

const DATE = 'YYYY-MM-DD';

function money(value: number): string {
  return `${value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

/**
 * Закрытие работ исполнителем (§9.3). Окон ТРИ в одном, потому что дуга одна: у ремонта подрядчика
 * предъявляют смету и факт по её строкам, у расходников — сколько чего выдали (§6.2), у
 * внутреннего ремонта — дату и слова.
 *
 * У ремонта подрядчика итог — **вычисляемая строка, а не поле ввода** (Р12): он пересчитывается на
 * глазах при каждой снятой отметке и разойтись с суммой строк не может. Нужно больше
 * согласованного — окно не пускает и говорит куда идти: удорожание проходит переоткрытием сметы.
 *
 * У расходников сметы нет вовсе, поэтому нет ни итога, ни скидки, ни планки закрывающего документа
 * (предикат контрактов требует `kind = 'repair'`). Вместо них — отметка факта по строкам, и её
 * умолчание «сколько просили» подставляет ФОРМА (Р3): сервер по молчанию клиента со склада не
 * списывает и отвечает 422 «нет отметки о выдаче». Списание идёт той же транзакцией, что и переход
 * в «Решена» (Р5), поэтому нехватка остатка отменяет закрытие целиком — и приходит текстом, в
 * котором названы позиция, остаток и оба законных выхода (Р7).
 *
 * ВНУТРЕННИЙ РЕМОНТ (Р6 плана `office-equipment-card-and-list-cleanup-plan.md`) закрывается датой
 * выполнения и необязательным «Что сделали»: свой сисадмин стоимости не фиксирует, и таблица
 * строк, скидка, счётный итог и плашка «Согласована ревизия N на X ₽» показывали бы ему нули —
 * то есть цифры там, где цифр по заявке не бывает.
 *
 * Режим выбирает признак Р4 (`serviceRequestNeedsEstimate`), а НЕ «есть ли у заявки строки». Это
 * не придирка: у заявки, которую вели подрядчиком, а потом передали своему, строки остались, и
 * закройся она по-старому — историческая смета превратилась бы в факт и в стоимость внутреннего
 * ремонта. Историю она остаётся, фактом не становится.
 */
export function ServiceCompleteModal({
  request,
  onClose,
}: {
  /** `null` — окно закрыто. Открывается в статусе «В работе». */
  request: ServiceRequestDto | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [rows, setRows] = useState<FactRow[]>([]);
  const [lines, setLines] = useState<ConsumableFactRow[]>([]);
  const [completedOn, setCompletedOn] = useState<Dayjs>(dayjs());
  const [adjustment, setAdjustment] = useState<number | null>(null);
  const [adjustmentReason, setAdjustmentReason] = useState('');
  const [comment, setComment] = useState('');
  /**
   * Отказ сервера — строкой в самом окне, а не только тостом: нехватка остатка называет позицию и
   * число, по которым человек правит факт прямо здесь, а тост к этому моменту уже погас.
   */
  const [failure, setFailure] = useState<string | null>(null);
  const consumable = request?.kind === 'consumable';
  /**
   * Считает ли эта заявка деньги (Р4). Признак берётся функцией контрактов по паре «вид +
   * исполнитель-контрагент» — той же, что спрашивают предикаты объёма работ и сервер: своя копия
   * условия в окне разошлась бы с серверной веткой закрытия молча, и человек узнавал бы о
   * расхождении из 422 после заполненной формы.
   *
   * Компания в DTO лежит объектом, предикату нужен идентификатор — тот же перевод делает и меню
   * действий у планки закрывающего документа.
   */
  const priced =
    !!request &&
    serviceRequestNeedsEstimate({
      kind: request.kind,
      serviceCounterpartyId: request.service?.id ?? null,
    });
  /**
   * Внутренний ремонт: ни строк, ни сумм. Пишется отрицанием двух других режимов, а не своим
   * условием — так третья ветка не может однажды совпасть с первой: расходники сюда не попадают
   * потому, что у них свой предмет (состав выдачи), а не потому, что «денег тоже нет».
   */
  const inHouse = !!request && !consumable && !priced;
  /**
   * Кому положены пояснения (Р11): держателю `serviceRequests.assign` — «Ведению» и ИТ-службе.
   * Правило спрашивается ОДНОЙ функцией контрактов, а не строкой `can(...)` по месту: мест,
   * задающих этот вопрос, одиннадцать, и разложенное по вызовам оно переехало бы наполовину.
   */
  const coordinator = canCoordinateServiceRequests(user);

  useEffect(() => {
    if (!request) return;
    setRows(factRowsFrom(request.items));
    setLines(consumableFactRows(request.consumables));
    setCompletedOn(dayjs());
    setAdjustment(null);
    setAdjustmentReason('');
    setComment('');
    setFailure(null);
  }, [request]);

  const total = factTotal(rows, adjustment);
  /*
   * Что мешает закрыть. У внутреннего ремонта — ничего: дата подставлена, комментарий
   * необязателен, а строки и суммы в тело не уходят вовсе, и проверять их значило бы держать
   * человека за форму, которой он не видит.
   */
  const issue = inHouse
    ? null
    : consumable
      ? consumableFactIssue(lines)
      : factIssue(rows, adjustment, adjustmentReason, request?.estimatedTotalAmount ?? null);

  const changeRow = (id: string, patch: Partial<FactRow>) =>
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  const changeLine = (id: string, patch: Partial<ConsumableFactRow>) =>
    setLines((prev) => prev.map((line) => (line.id === id ? { ...line, ...patch } : line)));

  const mutation = useMutation({
    mutationFn: () =>
      serviceRequestsApi.complete(request!.id, {
        completedOn: completedOn.format(DATE),
        /*
         * Строки сметы и строки номенклатуры — предмет одного или другого вида заявки, но не
         * обоих сразу: сервер отбивает и смету у расходников, и номенклатуру у ремонта.
         *
         * У внутреннего ремонта пусто и то, и другое, и `items: []` здесь — не «нечего послать», а
         * ЗАКОННОЕ тело (Н8): поле схемы обязательное, и запрет самого поля сделал бы внутреннее
         * закрытие невозможным. Сервер отвергает только непустое содержимое.
         *
         * Строки исторической сметы сюда не попадают намеренно (Р6): пошли они фактом — прошлый
         * объём работ превратился бы в стоимость внутреннего ремонта и в гарантии по позициям,
         * которых своими руками никто не давал.
         */
        items: consumable || inHouse ? [] : factToPayload(rows),
        consumables: consumable ? consumableFactPayload(lines) : undefined,
        adjustmentAmount: consumable || inHouse ? null : adjustment,
        adjustmentReason: consumable || inHouse ? '' : adjustmentReason.trim(),
        comment: comment.trim(),
        version: request!.version,
      }),
    onSuccess: () => {
      message.success('Работы закрыты — заявка ждёт приёмки');
      void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
      // Закрытие расходников двигает склад той же транзакцией (Р5): остаток в справочнике и лента
      // журнала устарели ровно сейчас.
      if (consumable) void qc.invalidateQueries({ queryKey: officeEquipmentConsumableKeys.root });
      onClose();
    },
    onError: (e) => {
      const text = consumable ? consumableFailureText(e) : errorMessage(e);
      setFailure(text);
      message.error(text);
    },
  });

  const submit = () => {
    if (issue) {
      message.warning(issue);
      return;
    }
    mutation.mutate();
  };

  return (
    <FormModal
      title={request ? `Закрытие работ ${request.displayNumber}` : 'Закрытие работ'}
      open={!!request}
      onCancel={onClose}
      onSubmit={submit}
      confirmLoading={mutation.isPending}
      okText="Закрыть работы"
      width={720}
    >
      {request && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <ServiceRequestContext request={request} />
          {/*
           * Пояснения — только тому, кто ведёт заявки (Р11, Э4). Исполнителю и оператору
           * подрядчика форма и так знакома, а синие плашки просили убрать именно у них; читает же
           * их `ServiceHint` из `entities`, а не свой `Alert`: класть общий компонент в `features`
           * нельзя — соседние слайсы до него не дотянутся (Н14).
           *
           * У внутреннего ремонта плашки нет ни у кого: объяснять в ней нечего — ни строк, ни
           * ревизии, ни суммы по такой заявке не бывает, а «Согласована ревизия 0 на 0,00 ₽»
           * называла бы цифры, которых нет.
           */}
          {consumable ? (
            <ServiceHint
              coordinator={coordinator}
              level="info"
              title="Отметьте, сколько выдали"
              description="Умолчание — сколько просили. Расхождение объясняется причиной: выдали больше, меньше или не выдали вовсе. Закрывающий документ у расходников не требуется."
            />
          ) : (
            priced && (
              <ServiceHint
                coordinator={coordinator}
                level="info"
                title={`Согласована ревизия ${request.approval?.revision ?? request.estimateRevision} на ${money(request.estimatedTotalAmount ?? 0)}`}
                description="Снимите отметку с того, что не понадобилось: гарантия проставляется только выполненным строкам."
              />
            )
          )}

          <DatePicker
            style={{ width: 220 }}
            format="DD.MM.YYYY"
            allowClear={false}
            value={completedOn}
            // Дата выполнения — от неё сервер считает гарантии по строкам без своей даты, и она же
            // единственное обязательное поле внутреннего закрытия (Р6). Подпись ей нужна именно
            // поэтому: у внутреннего ремонта рядом нет ни таблицы, ни итога, по которым читалось
            // бы, что это за дата.
            aria-label="Дата выполнения"
            onChange={(d) => d && setCompletedOn(d)}
          />

          {consumable ? (
            <ServiceConsumableFactRows rows={lines} onChange={changeLine} />
          ) : (
            /*
             * Строки, скидка и итог — только там, где заявка считает деньги (Р6). Признак Р4, а не
             * «есть ли строки»: у переданной своему сотруднику заявки строки остались от
             * подрядчика, и таблица факта предложила бы закрыть чужую смету как свою работу.
             */
            priced && (
              <>
                <CompleteRows rows={rows} onChange={changeRow} />

                <Divider style={{ margin: '8px 0' }} />

                <Space wrap align="start">
                  <InputNumber
                    style={{ width: 200 }}
                    max={-0.01}
                    value={adjustment}
                    placeholder="Скидка по акту, ₽"
                    aria-label="Скидка по акту"
                    onChange={setAdjustment}
                  />
                  <Input
                    style={{ width: 320 }}
                    maxLength={500}
                    value={adjustmentReason}
                    disabled={adjustment == null}
                    placeholder="Причина скидки"
                    aria-label="Причина скидки"
                    onChange={(e) => setAdjustmentReason(e.target.value)}
                  />
                </Space>

                {/* Итог считается, а не вводится: строка меняется при каждой отметке (Р12). */}
                <Space size={8} style={{ justifyContent: 'flex-end', width: '100%' }}>
                  <Typography.Text type="secondary">Итого по акту:</Typography.Text>
                  <Typography.Text strong style={{ fontSize: 16 }}>
                    {money(total)}
                  </Typography.Text>
                </Space>
              </>
            )
          )}

          {/*
           * Слова о работе. У внутреннего ремонта это единственное содержание закрытия, и потому
           * подпись у поля своя: «Что сделали» отвечает на вопрос, который по такой заявке и
           * задают, — а «чего не понадобилось» относится к строкам сметы, которых здесь нет.
           * Обязательным оно не становится: заказчик просил дату и НЕОБЯЗАТЕЛЬНЫЙ комментарий, и
           * выдуманное требование заставляло бы писать «сделал» ради кнопки.
           */}
          <Input.TextArea
            rows={2}
            maxLength={1000}
            value={comment}
            aria-label={inHouse ? 'Что сделали' : 'Комментарий'}
            placeholder={
              inHouse
                ? 'Что сделали — необязательно: например, заменили ролик подачи'
                : 'Комментарий: что сделали и чего не понадобилось'
            }
            onChange={(e) => setComment(e.target.value)}
          />
          {/* Отказ сервера показывается как есть (Р7): в нём названы позиция, остаток и выход. */}
          {failure && <Alert type="error" showIcon title={failure} />}
          {issue && <Typography.Text type="warning">{issue}</Typography.Text>}
        </div>
      )}
    </FormModal>
  );
}
