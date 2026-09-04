import { useState } from 'react';
import { Alert, App, Button, Form, Input, Skeleton, Space, Tag, Typography } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { VehicleReadingJournalRow } from '@technic/contracts';
import { formatReading, vehicleReadingKeys, vehicleReadingsApi } from '@entities/vehicle-reading';
import { FormModal } from '@shared/ui';
import { useIntakeAction } from './intakeAction';

/**
 * Порядок смен машины за день (ADR 0103, решение 3; план «Показания техники», §7).
 *
 * Вводимого времени у показаний нет: их сдают вечером или через три дня, и `now()` для прошлой
 * недели неверен. Начальную позицию назначает сервер по номерам листов и рейсов, но это
 * приближение — `vehicle_routes.num` говорит, когда рейс завели, а не когда машина выехала.
 * Позиция поэтому снимок, который человек исправляет, и исправление это не косметическое:
 * предшественник каждого счётчика берётся по позиции, то есть перестановка переписывает разности.
 *
 * **День спрашивается целиком у журнала машины, а не берётся из карточки.** Позиция принадлежит
 * паре «машина + день», а не отчёту: две смены одной машины бывают у двух работников, то есть в
 * двух отчётах, и карточка одного из них видит половину дня. Полный порядок, собранный по половине,
 * сервер отверг бы как «не тот состав строк» — и был бы прав.
 *
 * **Версии затронутых отчётов уходят вместе с порядком.** Их столько, сколько отчётов у дня этой
 * машины, и спрашиваются они по одному той же ручкой карточки: открытый отчёт при этом уже лежит в
 * кэше под своим ключом, и лишнего запроса не будет. Без версий два диспетчера, переставляющие
 * смены в соседних вкладках, молча перезаписали бы работу друг друга.
 */

const SHOWN_DATE = 'DD.MM.YYYY';

const CONFLICT =
  'Порядок не сохранён: смены или отчёты этого дня успели измениться, пока окно было открыто. ' +
  'Карточка перечитана — откройте порядок заново и переставьте смены ещё раз';

/**
 * Чем строка узнаётся глазами: числа показания либо честное «показания нет».
 *
 * Топливо в подписи наравне со счётчиками (ADR 0163, Н8). Без него утренняя строка, где заполнен
 * один остаток бака, называлась бы «числа не заполнены» — а переставляют смены как раз тогда, когда
 * их две и различить их надо по числам. Метки короткие и обязательные: все три числа в литрах, и
 * без «нач./запр./кон.» ряд неразличим.
 */
function readingLabel(row: VehicleReadingJournalRow): string {
  const reading = row.reading;
  if (!reading) return 'показания нет';
  if (reading.kind === 'no_data') return 'нет возможности снять';
  const parts = [
    reading.odometerKm === null ? null : `${formatReading(reading.odometerKm)} км`,
    reading.engineHours === null ? null : `${formatReading(reading.engineHours)} ч`,
    reading.fuelStartLiters === null ? null : `нач. ${formatReading(reading.fuelStartLiters)} л`,
    reading.fuelFilledLiters === null ? null : `запр. ${formatReading(reading.fuelFilledLiters)} л`,
    reading.fuelEndLiters === null ? null : `кон. ${formatReading(reading.fuelEndLiters)} л`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'числа не заполнены';
}

export function IntakeShiftOrderModal({
  vehicleId,
  vehicleLabel,
  date,
  onClose,
}: {
  vehicleId: string;
  vehicleLabel: string;
  /** Снимочный день строки — тот же, которым день ищет сервер. */
  date: string;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<{ reason: string }>();
  /** Переставленное человеком; `null` — ещё ничего не двигали, и порядок равен серверному. */
  const [moved, setMoved] = useState<string[] | null>(null);

  const query = { from: date, to: date, page: 1, pageSize: 50 };
  const { data, isLoading } = useQuery({
    queryKey: vehicleReadingKeys.journal(vehicleId, query),
    queryFn: () => vehicleReadingsApi.journal(vehicleId, query),
  });

  /*
   * Порядок сервера — по возрастанию позиции. Сортируется здесь, а не берётся порядком ответа:
   * журнал отдаёт свежее сверху, а ожидаемый прежний порядок сверяется с `ORDER BY shift_order`.
   */
  const rows = [...(data?.items ?? [])].sort((a, b) => a.shiftOrder - b.shiftOrder);
  const byId = new Map(rows.map((row) => [row.itemId, row]));
  const expectedOrder = rows.map((row) => row.itemId);
  const order = moved ?? expectedOrder;

  /** Версии всех отчётов дня: открытый уже в кэше, соседний спрашивается своим запросом. */
  const reportIds = [...new Set(rows.map((row) => row.reportId))];
  const reports = useQueries({
    queries: reportIds.map((id) => ({
      queryKey: vehicleReadingKeys.report(id),
      queryFn: () => vehicleReadingsApi.report(id),
    })),
  });
  const versionsReady = reports.every((report) => report.data);
  const reportVersions = Object.fromEntries(
    reports
      .filter((report) => report.data)
      .map((report) => [report.data!.id, report.data!.version]),
  );

  const save = useIntakeAction({
    run: (values: { reason: string }) =>
      vehicleReadingsApi.reorderShifts({
        vehicleId,
        date,
        // Ожидаемый прежний порядок — тот, который человек видел, когда двигал строки.
        expectedOrder,
        order: order.map((itemId, index) => ({ itemId, shiftOrder: index + 1 })),
        reportVersions,
        reason: values.reason.trim(),
      }),
    done: 'Порядок смен изменён',
    conflict: CONFLICT,
    onDone: onClose,
  });

  const move = (index: number, step: number) => {
    const next = [...order];
    const target = index + step;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    setMoved(next);
  };

  const changed = order.some((id, index) => id !== expectedOrder[index]);
  /** Хвост за пределами страницы: полного порядка из половины дня не собрать. */
  const truncated = (data?.total ?? 0) > rows.length;

  return (
    <FormModal
      title={`Порядок смен — ${vehicleLabel}, ${dayjs(date).format(SHOWN_DATE)}`}
      open
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={save.isPending}
      okText="Сохранить порядок"
      width={620}
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={(values) => {
          // Перестановка переписывает разности и историю обоих отчётов: отправлять «тот же
          // порядок» значило бы завести учётное событие, которого не было.
          if (!changed) {
            message.info('Порядок не менялся — переставьте смены или закройте окно');
            return;
          }
          if (!versionsReady) {
            message.info('Отчёты этого дня ещё читаются — повторите через мгновение');
            return;
          }
          save.mutate(values);
        }}
      >
        <Typography.Paragraph type="secondary">
          Позиция смены — снимок, назначенный по номерам документов, а не по времени выезда. От неё
          считаются приросты: у второй смены предшественник — первая.
        </Typography.Paragraph>

        {truncated && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 16 }}
            title="День не поместился на страницу журнала — порядок отсюда не менять"
          />
        )}

        {/* Одна смена — законный день, и окно об этом говорит прямо: список из одной строки без
            объяснения читался бы как «остальные не загрузились». */}
        {!isLoading && rows.length < 2 && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            title="За этот день у машины одна смена — переставлять нечего"
          />
        )}

        {/* Список появляется вместе с версиями: строки, которые нельзя отправить, показывать
            незачем — человек переставил бы их и упёрся в отказ на кнопке. */}
        {isLoading || !versionsReady ? (
          <Skeleton active paragraph={{ rows: 3 }} />
        ) : (
          <Space orientation="vertical" size={8} style={{ display: 'flex', marginBottom: 16 }}>
            {order.map((itemId, index) => {
              const row = byId.get(itemId);
              if (!row) return null;
              return (
                <Space key={itemId} size={8} wrap style={{ justifyContent: 'space-between' }}>
                  <Space size={8} wrap>
                    <Tag style={{ marginInlineEnd: 0 }}>{`смена ${index + 1}`}</Tag>
                    <Typography.Text strong>{row.sourceLabel}</Typography.Text>
                    {/* Чей это отчёт — существенно: у дня машины бывает два владельца, и
                        перестановка меняет разности им обоим. */}
                    <Typography.Text type="secondary">{row.personName}</Typography.Text>
                    <Typography.Text type="secondary">{readingLabel(row)}</Typography.Text>
                  </Space>
                  <Space size={4}>
                    <Button
                      size="small"
                      icon={<ArrowUpOutlined />}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                      aria-label={`Поднять смену — ${row.sourceLabel}`}
                    />
                    <Button
                      size="small"
                      icon={<ArrowDownOutlined />}
                      disabled={index === order.length - 1}
                      onClick={() => move(index, 1)}
                      aria-label={`Опустить смену — ${row.sourceLabel}`}
                    />
                  </Space>
                </Space>
              );
            })}
          </Space>
        )}

        <Form.Item
          name="reason"
          label="Причина перестановки"
          rules={[{ required: true, message: 'Перестановку смен объясняют' }]}
          extra="Уедет в историю каждого затронутого отчёта вместе с новым порядком"
        >
          <Input maxLength={500} placeholder="Ночная смена вышла первой, рейс завели позже" />
        </Form.Item>
      </Form>
    </FormModal>
  );
}
