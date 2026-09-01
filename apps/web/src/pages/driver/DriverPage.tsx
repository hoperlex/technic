import type { CSSProperties, ReactNode } from 'react';
import { Alert, Card, Empty, Skeleton, Space, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type {
  DriverAssignmentAction,
  DriverAssignmentEntry,
  DriverAssignmentPoint,
} from '@technic/contracts';
import { errorMessage } from '@shared/lib';
import { cabinetRead, driverCabinetApi, driverKeys } from './api';
import { useDriverDate } from './DriverLayout';

/**
 * Задание работника на выбранную дату (ADR 0102, Р12–Р13).
 *
 * Страница по ссылке, а не тело кабинета: кабинет открывается формой показаний, и задание живёт на
 * `/driver/assignment` — той же датой в адресе, той же шапкой каркаса (план driver-readings-first,
 * Р1, Р5). Само содержимое от переезда не изменилось: адреса точек, время, кто встречает и его
 * телефон — всё, ради чего экран и заведён, читается здесь целиком.
 *
 * Экран читающий. Правки задания здесь нет вовсе — ни отказа ехать, ни замены машины, ни отметки
 * «выполнено»: кабинет по заданию читающий, и всё это ведётся в основном портале.
 *
 * Ни одного идентификатора справочника страница не знает: машина, заказчик, адреса и назначение
 * приходят готовыми подписями. Это и делает выполнимым главное свойство роли — у неё нет права
 * `directories.read`, и спросить справочник ей нечем.
 */

/**
 * Мелкая подпись — долей от размера кабинета, а не двенадцатью пикселями (Р1): масштаб кабинета
 * задан одной переменной на каркасе, и абсолютное число здесь осталось бы прежним ровно тогда,
 * когда всё вокруг выросло.
 */
const secondary: CSSProperties = { fontSize: '0.85em' };

/**
 * Значение строки, которую читают не по списку, а через стекло на ходу: адрес точки и тот, кто
 * там встречает. Эти две строки водитель ищет глазами первыми — с ними он доезжает и попадает
 * внутрь, — поэтому они крупнее соседних на пятую часть. Доля, а не пиксели, — по той же причине,
 * что и у мелкой подписи (Р1): масштаб кабинета живёт одной переменной на каркасе.
 */
const emphasizedValue: CSSProperties = { fontSize: '1.22em' };

/**
 * Порядок карточек — по позиции смены (П5), а не по порядку ответа: первая смена дня сверху.
 * Сейчас сервер отдаёт их в том же порядке, но порядок на экране — свойство экрана: он читается
 * сверху вниз так же, как идёт рабочий день, и зависеть от порядка выборки не должен.
 */
function byShiftOrder(a: DriverAssignmentEntry, b: DriverAssignmentEntry): number {
  // Строка без позиции — недельный ЭСМ-2: он накрывает день целиком и своей смены не имеет,
  // поэтому идёт после сменных карточек, а не перед ними.
  return (a.shiftOrder ?? Number.MAX_SAFE_INTEGER) - (b.shiftOrder ?? Number.MAX_SAFE_INTEGER);
}

/** Строка «подпись — значение». Пустые значения не выводятся: прочерк в каждой строке — это шум. */
function Field({
  label,
  emphasis,
  children,
}: {
  label: string;
  emphasis?: boolean;
  children: ReactNode;
}) {
  if (children === null || children === undefined || children === '') return null;
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
      <Typography.Text type="secondary" style={{ ...secondary, flex: '0 0 auto' }}>
        {label}
      </Typography.Text>
      <div style={{ flex: '1 1 auto', minWidth: 0, ...(emphasis ? emphasizedValue : null) }}>
        {children}
      </div>
    </div>
  );
}

/**
 * Что делают на остановке: одна строка на роль точки. Подпись роли приходит готовой — её собирает
 * тот же слой, что и письмо (`driver-assignment.ts`), и своих слов у кабинета здесь нет: водитель
 * читает оба канала, и «Грузим» в одном против «Погрузка» в другом он прочтёт как разное задание.
 *
 * Количества груза здесь нет, и переход на точки этого не изменил: «20 т» водитель сверяет на
 * весах, а не в телефоне, а груз ему описывает комментарий заявки, который стоит рядом строкой
 * «Примечание». Строки одной остановки различает не цифра, а номер ездки: «ТС-101/1» и «ТС-101/2»
 * названы прямо у роли. В письме-задании количество остаётся (`mailings/driver-routes.ts`) — там
 * строка одна, и лишним оно никого не теснит.
 */
function ActionRow({ action }: { action: DriverAssignmentAction }) {
  return (
    <div>
      <Space size={6} wrap>
        <Typography.Text strong>{action.roleLabel}</Typography.Text>
        <Typography.Text>{action.displayNumber}</Typography.Text>
        {action.customerName && (
          <Typography.Text type="secondary" style={secondary}>
            {action.customerName}
          </Typography.Text>
        )}
      </Space>
      {/* Комментарий строки — рядом со своей ролью, а не общим списком под точкой: на совмещённой
          остановке ездок две, и «песок, звонить за час» относится к одной из них. В бланке он
          отбрасывается первым при нехватке места (Р11а), и кабинет — одно из двух мест, где он
          показывается целиком. */}
      <Field label="Примечание">{action.comment}</Field>
    </div>
  );
}

/**
 * Одна остановка порядка объезда: куда приехать, во сколько, что здесь делать и кто встречает.
 *
 * Блок на точку, а не на заявку (план `docs/route-trips-plan.md`, §8): два заезда в один карьер —
 * одна остановка, а у заявки с двумя ездками «адреса разгрузки» не существует вовсе.
 *
 * Телефон — ссылкой `tel:`: кабинет открывают с того же аппарата, с которого звонят, и
 * переписывание номера в набор — самое частое и самое бессмысленное действие водителя за смену.
 * Ответственных показываются **все**: их у совмещённой точки бывает двое, и приехавший, позвонив
 * первому, останется без пропуска у второго (Р11а).
 */
function PointBlock({ point }: { point: DriverAssignmentPoint }) {
  return (
    <div
      style={{
        paddingTop: 8,
        borderTop: '1px solid rgba(0, 0, 0, 0.06)',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <Space size={6} wrap>
        <Typography.Text strong>Точка {point.position}</Typography.Text>
        {point.arrivalTime && <Tag color="blue">{point.arrivalTime}</Tag>}
      </Space>
      <Field label="Адрес" emphasis>
        {point.location}
      </Field>
      {point.actions.map((action, index) => (
        <ActionRow key={`${action.role}-${action.displayNumber}-${index}`} action={action} />
      ))}
      {point.contacts.map((contact, index) => (
        <Field key={`${contact.phone}-${index}`} label="Встречает" emphasis>
          {contact.name}
          {contact.phone && (
            <>
              {contact.name ? ' · ' : null}
              <Typography.Link href={`tel:${contact.phone}`}>{contact.phone}</Typography.Link>
            </>
          )}
        </Field>
      ))}
      <Field label="На точке">{point.comment}</Field>
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
      {/* Порядок объезда — по позициям точек, как их отдал сборщик: он же кормит письмо, и второй
          сортировки здесь быть не должно — переставь кабинет остановки по-своему, и два канала
          повели бы водителя по разным маршрутам. */}
      {entry.points.map((point) => (
        <PointBlock key={point.position} point={point} />
      ))}
    </Card>
  );
}

export function DriverPage() {
  const { date } = useDriverDate();
  /*
   * Настройки чтения — общие для кабинета (Р7), а не портальные: телефон водителя лежит в кармане
   * со свёрнутым браузером, и рейс, заведённый диспетчером в обед, обязан появиться сам — сказать
   * водителю «обнови страницу» здесь некому. Гейта мутаций у этой страницы нет и не нужно: ни
   * `open`, ни `submit` отсюда не уходят, а задание — чтение, которому нечего затирать.
   */
  const { data, isPending, error } = useQuery({
    queryKey: driverKeys.assignment(date),
    queryFn: () => driverCabinetApi.assignment(date),
    ...cabinetRead,
  });

  if (isPending) return <Skeleton active paragraph={{ rows: 6 }} />;
  if (error)
    return (
      <Alert
        type="error"
        showIcon
        title="Задание не загрузилось"
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

  // Копия перед сортировкой: `entries` лежит в кэше запроса, и сортировка на месте переставила бы
  // строки всем, кто их читает, — включая страницу показаний.
  return (
    <Space orientation="vertical" size={12} style={{ display: 'flex' }}>
      {[...data.entries].sort(byShiftOrder).map((entry) => (
        <EntryCard key={`${entry.sourceKind}-${entry.sourceId}`} entry={entry} />
      ))}
    </Space>
  );
}
