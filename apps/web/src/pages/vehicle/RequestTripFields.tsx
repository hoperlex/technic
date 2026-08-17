import { Form, Input, InputNumber } from 'antd';
import { isAddressVerified, type VehicleRequestTripDto } from '@technic/contracts';
import { FormGrid } from '@shared/ui';
import { AddressField } from '@features/address-input';
import { ResponsibleFields } from '../../components/ResponsibleFields';
import { TimeInput, optionalWorkTimeRule } from '../../components/TimeInput';

/**
 * Поля **одной** ездки заявки (§4.1 плана `docs/route-trips-plan.md`, этап 6).
 *
 * Отдельно от списка (`RequestTripsBlock`) по существу дела, а не ради длины файла: список знает
 * про состав — сколько строк, какую размножить, какую убрать; строка знает про поля — что
 * спрашивается у ездки и по каким правилам. Свёрнутый вид заявки с одной ездкой рисуется этим же
 * компонентом, и это его главное свойство: разъедься они, «как сегодня» и «в списке» стали бы
 * двумя разными формами с двумя наборами правил.
 *
 * Имена полей — путями в массив (`trips.3.fromLocation`), а не относительными внутри
 * `Form.List`: адресное поле и контакт зовут форму напрямую (`getFieldValue`, `setFieldValue`,
 * `useWatch`), а туда путь нужен целиком. Список ездок поэтому ведётся своими значениями, а не
 * антовским `Form.List`.
 */

/** Ездка — пара концов; у каждого свой адрес и свой контакт: грузят и принимают разные люди. */
type Side = 'from' | 'to';

const SIDE_LABELS: Record<Side, { address: string; required: string; responsible: string }> = {
  from: {
    address: 'Место погрузки',
    required: 'Укажите место погрузки',
    responsible: 'Ответственный за погрузку',
  },
  to: {
    address: 'Место разгрузки',
    required: 'Укажите место разгрузки',
    responsible: 'Ответственный за разгрузку',
  },
};

interface EndProps {
  /** Позиция строки в списке значений формы — из неё собираются пути полей. */
  index: number;
  side: Side;
  /** Сохранённая ездка этой строки; `undefined` — строка новая (Р2а: послаблений у неё нет). */
  saved: VehicleRequestTripDto | undefined;
  suggestObjectIds: readonly string[];
}

/**
 * Конец ездки: адрес и контакт под ним.
 *
 * Контакт стоит под своим адресом, а не общим блоком в конце формы: погрузка и разгрузка — два
 * разных места, и водитель ищет того, кто откроет ворота именно здесь.
 */
function TripEnd({ index, side, saved, suggestObjectIds }: EndProps) {
  const form = Form.useFormInstance();
  const labels = SIDE_LABELS[side];
  const locationField = ['trips', index, `${side}Location`];
  const metaField = ['trips', index, `${side}Address`];
  const nameField = ['trips', index, `${side}ResponsibleName`];
  const phoneField = ['trips', index, `${side}ResponsiblePhone`];

  const savedLocation = side === 'from' ? saved?.fromLocation : saved?.toLocation;
  const savedMeta = (side === 'from' ? saved?.fromAddress : saved?.toAddress) ?? null;
  const savedName = side === 'from' ? saved?.fromResponsibleName : saved?.toResponsibleName;
  const savedPhone = side === 'from' ? saved?.fromResponsiblePhone : saved?.toResponsiblePhone;

  /*
   * Жёсткая модель адреса (ADR 0006) действует на **новое** значение, а не на перезапись прежнего
   * (Р2а). У ездки, доехавшей бэкфилом от заявки старше ADR 0006, метаданных нет вовсе, и правило
   * поля не пустило бы правку такой заявки, пока кто-нибудь не выберет ей адрес заново — то есть
   * не выдумает данные за прошлое. Тем же послаблением её принимает сервер
   * (`updateRequestTripSchema`), и разойтись им нельзя: форма, не отправляющая того, что ручка
   * принимает, — это запрет, о котором никто не решал.
   *
   * Послабление живёт у **каждой** строки своё, а не одно на форму: у заявки с шестью ездками
   * старой может оказаться третья, и общий выключатель либо снял бы требование со всех, либо ни с
   * кого. Держится оно ровно до правки — как только адрес изменили, требование возвращается.
   *
   * Сравнивается здесь печатаемая строка, а сервер сверяет пару целиком — строку и метаданные
   * (`assertAddressWritable`). Условие поля поэтому чуть шире серверного, и в зазор попадает один
   * случай: строку правили и вернули к прежнему виду руками — метаданные при этом стали `manual`,
   * форма отправку пропустит, а ручка ответит 422 с ошибкой на самом поле. Сузить его нечем, пока
   * сравнение метаданных живёт приватной функцией ручки: копия правила на фронте разошлась бы с
   * ней при первой же правке.
   */
  const location = Form.useWatch(locationField, form) as string | undefined;
  const keepsAddress = !!saved && !isAddressVerified(savedMeta) && location === savedLocation;

  return (
    <>
      <AddressField
        name={locationField}
        label={labels.address}
        required
        requiredMessage={labels.required}
        verified={!keepsAddress}
        metaField={metaField}
        directory
        suggestObjectIds={suggestObjectIds}
        placeholder="Начните вводить адрес"
      />
      {/* Прежний контакт правку не блокирует тем же правилом, что и прежний адрес (Р2а): у ездки
          от заявки старше миграции 0062 он пустой, а у заявки старше ADR 0066 — несводимый к
          десяти цифрам. Как только значение меняют, обычные правила возвращаются. */}
      <ResponsibleFields
        nameField={nameField}
        phoneField={phoneField}
        nameLabel={labels.responsible}
        phoneLabel="Телефон"
        kept={saved ? { name: savedName ?? '', phone: savedPhone ?? '' } : undefined}
      />
    </>
  );
}

interface Props {
  index: number;
  saved: VehicleRequestTripDto | undefined;
  suggestObjectIds: readonly string[];
  /**
   * Нужно ли количество: у легковой машины (форма № 3) груза не бывает вовсе, и требовать «объём
   * или массу» значило бы заставлять заявителя его выдумывать. Правило то же, которым отвечает
   * сервер, — спрашивает оно бланк заказанного типа ТС.
   */
  cargoRequired: boolean;
  /**
   * Показывать ли то, чего свёрнутый вид не знает: своё время подачи (Р3) и примечание к ездке.
   *
   * Заявка с одной ездкой заполняется ровно как сегодня (§4.1), а сегодня этих полей в форме нет.
   * Появляются они вместе со списком — там, где ездок несколько и «шестая едет к 14:00» есть что
   * сказать.
   */
  detailed: boolean;
}

/**
 * Поля ездки в порядке, в каком их читают: сколько везём, во сколько, откуда и куда.
 *
 * Возвращается фрагментом, а не блоком: в свёрнутом виде эти поля — прямые ячейки сетки формы
 * (`FormGrid`), и обёртка превратила бы их в одну ячейку на всю пару колонок. Разворот в список
 * оборачивает их сам — карточкой ездки.
 */
export function RequestTripFields({
  index,
  saved,
  suggestObjectIds,
  cargoRequired,
  detailed,
}: Props) {
  return (
    <>
      {/* Груз: одного из двух достаточно. Обязательность условная и решается сервером — здесь
          только подсказка о том, чего от поля ждут. */}
      <Form.Item
        name={['trips', index, 'volumeM3']}
        label="Объём, м³"
        tooltip={cargoRequired ? 'Укажите объём или массу' : 'Необязательно'}
      >
        <InputNumber style={{ width: '100%' }} min={0} step={0.1} />
      </Form.Item>
      <Form.Item
        name={['trips', index, 'weightTons']}
        label="Масса, т"
        tooltip={cargoRequired ? 'Укажите объём или массу' : 'Необязательно'}
      >
        <InputNumber style={{ width: '100%' }} min={0} step={0.1} />
      </Form.Item>
      {detailed && (
        // Своё время подачи — уточняющее (Р3): днём заказа, фильтрами и рабочим окном заведует
        // подача **заявки**, а ездка отвечает на «во сколько именно эта». Пустое поле так и
        // читается — «как у заявки»; спрашивается только время, потому что день ездки обязан
        // остаться днём заявки.
        <Form.Item
          name={['trips', index, 'scheduledTime']}
          label="Время подачи (МСК)"
          tooltip="Необязательно: пусто — время заявки. Рабочее окно — с 07:00 до 21:00"
          rules={[optionalWorkTimeRule]}
        >
          <TimeInput />
        </Form.Item>
      )}
      {/* Адреса и контакты — во всю ширину: подсказка DaData приходит одной длинной строкой, и в
          половине окна выбирать пришлось бы из обрезанных вариантов. */}
      <FormGrid.Full>
        <TripEnd index={index} side="from" saved={saved} suggestObjectIds={suggestObjectIds} />
        <TripEnd index={index} side="to" saved={saved} suggestObjectIds={suggestObjectIds} />
        {detailed && (
          // Примечание к ездке — то, что в бланке отбрасывается первым (Р11а), а водителю нужно:
          // «песок, звонить за час». Комментарий заявки о заказе целиком и этого не заменяет.
          <Form.Item name={['trips', index, 'comment']} label="Примечание к ездке">
            <Input.TextArea
              rows={2}
              maxLength={2000}
              placeholder="Например: песок, звонить за час"
            />
          </Form.Item>
        )}
      </FormGrid.Full>
    </>
  );
}
