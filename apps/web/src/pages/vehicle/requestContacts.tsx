import { Typography } from 'antd';
import type { VehicleRequestDto, VehicleRequestTripDto } from '@technic/contracts';
import { ExpandableCell } from '@shared/ui';
import { PhoneLink } from '../../components/PhoneField';

/**
 * Контакты заявки на технику и счёт её ездок — всё, чем строка списка отвечает на вопрос «к кому
 * ехать и сколько раз».
 *
 * Выделено из `shared.tsx` не ради длины файла: контакты собираются по трём разным правилам
 * (грузоперевозка берёт их у точек маршрута, спецтехника — у объекта или отдела), и рядом с
 * выпадающими списками и редактором файлов это правило читалось как ещё одна мелочь. Здесь у него
 * своё место, и видно, что счёт ездок — часть того же разговора: он стоит и в карточке, и в
 * подсказке состава рейса.
 */

/** Контакт заявки: чья это роль, кто им занят, куда ехать и по какому номеру звонить. */
interface RequestContact {
  role: string;
  name: string;
  phone: string;
  /** Адрес, к которому контакт приставлен; `null` — у объекта он не заполнен (поле необязательное). */
  address: string | null;
}

/**
 * «6 ездок» — число ездок заявки с русским склонением.
 *
 * Отдельной функцией, а не строкой по месту: счёт стоит и в карточке рядом с итогом груза («60 м³
 * · 6 ездок», §9 плана `docs/route-trips-plan.md`), и в подсказке состава рейса, где он объясняет
 * съеденную ёмкость бланка (Р11). Разъедься они — «6 ездки» в одном месте и «6 ездок» в другом
 * читались бы как две разные величины.
 */
export function tripsCountLabel(count: number): string {
  // Склонение то же, что у календарных дней (`calendarDaysLabel`): 1 ездка, 2–4 ездки, 5–20
  // ездок; 11–14 — всегда «ездок».
  const tail = count % 100;
  const last = count % 10;
  const form =
    tail >= 11 && tail <= 14
      ? 'ездок'
      : last === 1
        ? 'ездка'
        : last >= 2 && last <= 4
          ? 'ездки'
          : 'ездок';
  return `${count} ${form}`;
}

/**
 * Контакты грузоперевозки: их держит **ездка** (Р2), а не заявка — у заявки с ездками `A→B` и
 * `A→C` «ответственного за разгрузку заявки» не существует.
 *
 * Показывается первая ездка — тем же выбором, каким строка списка показывает её адреса (§9).
 * Остальные читаются в карточке: в ячейку списка не помещается и одна пара контактов с адресами,
 * ради чего она и сворачивается. Счёт ездок при этом стоит в самой роли: без него список молча
 * выдавал бы контакт одной ездки за контакт всей заявки, и звонок ушёл бы не туда.
 */
function tripContacts(trips: readonly VehicleRequestTripDto[]): RequestContact[] {
  const trip = trips[0];
  // Ездок не бывает ноль (`FreightTransportRequestDto.trips`), но строка списка не то место, где
  // это стоит утверждать исключением: пустой перечень покажет «—», а не уронит таблицу целиком.
  if (!trip) return [];
  const suffix = trips.length > 1 ? ` · ездка 1 из ${trips.length}` : '';
  return [
    {
      role: `Отв. за погрузку${suffix}`,
      name: trip.fromResponsibleName,
      phone: trip.fromResponsiblePhone,
      address: trip.fromLocation,
    },
    {
      role: `Отв. за разгрузку${suffix}`,
      name: trip.toResponsibleName,
      phone: trip.toResponsiblePhone,
      address: trip.toLocation,
    },
  ];
}

/**
 * Контакты заявки по местам работы. У заказа техники на объект контакт один — тот, кто встречает
 * технику на площадке, и адрес у него объектный; у грузоперевозки их два, по одному на конец
 * маршрута, и у каждого свой адрес: грузят и принимают разные люди в разных местах.
 *
 * Роль в паре с именем неотделима намеренно: «Иванов» без роли в списке ничего не значит — звонить
 * по нему будут не зная, о каком конце маршрута спрашивать.
 */
export function requestContacts(r: VehicleRequestDto): RequestContact[] {
  const contacts: RequestContact[] =
    r.requestType === 'special_equipment'
      ? [
          {
            role: 'Отв. на объекте',
            name: r.responsibleName,
            phone: r.responsiblePhone,
            address: r.objectAddress,
          },
        ]
      : tripContacts(r.trips);
  // Пустой контакт не занимает строку: у заявок до миграции 0062 его нет вовсе, и «Отв. за
  // погрузку —» сообщал бы о заявке ровно ничего, отнимая у соседнего контакта видимую строку.
  return contacts.filter((c) => c.name || c.phone || c.address);
}

/**
 * Контакты в строке списка: роль с именем, под ними адрес и телефон. Отвечает на «кому звонить и
 * куда ехать» — второй вопрос к списку заявок после самой заявки, и до сих пор за ответом
 * приходилось открывать карточку каждой.
 *
 * Ячейка сворачивается (`ExpandableCell`): у грузоперевозки контактов два, адреса длинные, и
 * пущенные в высоту они растянули бы каждую строку списка на пять-шесть строк текста.
 */
export function RequestContactsCell({ request }: { request: VehicleRequestDto }) {
  const contacts = requestContacts(request);
  if (contacts.length === 0) return <Typography.Text type="secondary">—</Typography.Text>;
  return (
    <ExpandableCell>
      {contacts.map((c, i) => (
        <div key={c.role} style={{ marginTop: i === 0 ? 0 : 4 }}>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {c.role}
            </Typography.Text>{' '}
            {c.name || '—'}
          </div>
          <div style={{ fontSize: 12 }}>
            {c.address && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }} title={c.address}>
                {c.address}
              </Typography.Text>
            )}
            {c.address && c.phone ? ' · ' : null}
            {/* Номер ссылкой `tel:`: по контакту в списке именно звонят (ADR 0066). */}
            {c.phone && <PhoneLink phone={c.phone} />}
          </div>
        </div>
      ))}
    </ExpandableCell>
  );
}
