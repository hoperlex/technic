import type { CSSProperties, ReactNode } from 'react';
import { Alert, Card, Empty, Skeleton, Space, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { DriverAssignmentEntry, DriverAssignmentRequest } from '@technic/contracts';
import { errorMessage } from '@shared/lib';
import { driverCabinetApi, driverKeys } from './api';
import { useDriverDate } from './DriverLayout';

/**
 * Тело кабинета: задание работника на выбранную дату (ADR 0102, Р12–Р13).
 *
 * Экран читающий. Правки задания здесь нет вовсе — ни отказа ехать, ни замены машины, ни отметки
 * «выполнено»: кабинет по заданию читающий, и всё это ведётся в основном портале.
 *
 * Ни одного идентификатора справочника страница не знает: машина, заказчик, адреса и назначение
 * приходят готовыми подписями. Это и делает выполнимым главное свойство роли — у неё нет права
 * `directories.read`, и спросить справочник ей нечем.
 */

const secondary: CSSProperties = { fontSize: 12 };

/** Строка «подпись — значение». Пустые значения не выводятся: прочерк в каждой строке — это шум. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  if (children === null || children === undefined || children === '') return null;
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
      <Typography.Text type="secondary" style={{ ...secondary, flex: '0 0 auto' }}>
        {label}
      </Typography.Text>
      <div style={{ flex: '1 1 auto', minWidth: 0 }}>{children}</div>
    </div>
  );
}

/**
 * Заявка в составе рейса. Телефон — ссылкой `tel:`: кабинет открывают с того же аппарата, с
 * которого звонят, и переписывание номера в набор — самое частое и самое бессмысленное действие
 * водителя за смену.
 */
function RequestBlock({ request }: { request: DriverAssignmentRequest }) {
  return (
    <div style={{ paddingTop: 8, borderTop: '1px solid rgba(0, 0, 0, 0.06)' }}>
      <Space size={6} wrap>
        <Typography.Text strong>{request.displayNumber}</Typography.Text>
        {request.time && <Tag color="blue">{request.time}</Tag>}
        {request.customerName && (
          <Typography.Text type="secondary" style={secondary}>
            {request.customerName}
          </Typography.Text>
        )}
      </Space>
      <Field label="Погрузка">{request.loadingLocation}</Field>
      <Field label="Выгрузка">{request.unloadingLocation}</Field>
      <Field label="Груз">{request.cargoLabel}</Field>
      <Field label="Комментарий">{request.comment}</Field>
      {request.contacts.map((contact, index) => (
        <Field key={`${contact.phone}-${index}`} label={contact.label}>
          {contact.name}
          {contact.phone && (
            <>
              {contact.name ? ' · ' : null}
              <Typography.Link href={`tel:${contact.phone}`}>{contact.phone}</Typography.Link>
            </>
          )}
        </Field>
      ))}
    </div>
  );
}

/**
 * Одна строка задания — она же будущая строка ожидания показаний (Р13). Карточка на источник, а не
 * на машину: за день по одной машине бывает две смены, и общая карточка склеила бы их показания.
 */
function EntryCard({ entry }: { entry: DriverAssignmentEntry }) {
  const vehicle = [entry.vehicleLabel, entry.garageNumber && `гар. № ${entry.garageNumber}`]
    .filter(Boolean)
    .join(' · ');
  return (
    <Card
      size="small"
      styles={{ body: { display: 'flex', flexDirection: 'column', gap: 6 } }}
      title={
        <Space size={6} wrap>
          <span>{entry.sourceLabel}</span>
          {entry.purposeLabel && <Tag>{entry.purposeLabel}</Tag>}
        </Space>
      }
    >
      <Field label="Машина">{vehicle}</Field>
      <Field label="Прицеп">{entry.trailerLabel}</Field>
      {/* Перегон состава не имеет вовсе: его задание — «откуда и куда», и без этих двух строк
          карточка перегона пуста. */}
      <Field label="Откуда">{entry.moveFrom}</Field>
      <Field label="Куда">{entry.moveTo}</Field>
      <Field label="Комментарий">{entry.comment}</Field>
      {entry.requests.map((request) => (
        <RequestBlock key={request.displayNumber} request={request} />
      ))}
    </Card>
  );
}

export function DriverPage() {
  const { date } = useDriverDate();
  const { data, isPending, error } = useQuery({
    queryKey: driverKeys.assignment(date),
    queryFn: () => driverCabinetApi.assignment(date),
  });

  if (isPending) return <Skeleton active paragraph={{ rows: 6 }} />;
  if (error)
    return (
      <Alert
        type="error"
        showIcon
        message="Задание не загрузилось"
        description={errorMessage(error)}
      />
    );

  // Пустой день — законное состояние, а не ошибка и не «ничего не найдено»: выходной, отпуск,
  // день без рейсов. Кнопок здесь нет намеренно (Р10) — передавать по такому дню нечего.
  if (data.entries.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="На этот день заданий нет"
        style={{ padding: '48px 0' }}
      />
    );
  }

  return (
    <Space direction="vertical" size={12} style={{ display: 'flex' }}>
      {data.entries.map((entry) => (
        <EntryCard key={`${entry.sourceKind}-${entry.sourceId}`} entry={entry} />
      ))}
    </Space>
  );
}
