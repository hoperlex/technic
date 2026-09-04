import { useMemo, useState } from 'react';
import { Form } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { ServiceRequestDto } from '@technic/contracts';
import { objectOptionsQuery } from '@entities/object';
import {
  officeEquipmentOptionsQuery,
  officeEquipmentPickedQuery,
  type OfficeEquipmentOption,
} from '@entities/office-equipment';
import { EquipmentNotFoundLink, type EquipmentCandidateDraft } from '@features/missing-equipment';
import { AutoSelect } from '@shared/ui';
import { ServiceRequestSubject } from './ServiceRequestSubject';
import { useAuth } from '../../auth/AuthContext';
import { useObjectScope } from '../../hooks/useObjectScope';

/** Опция справочника техники с реквизитами, которые форма показывает под полем (Р48). */
export interface EquipmentOption {
  value: string;
  label: string;
  name: string;
  serialNumber: string;
  inventoryNumber: string;
  objectLabel: string;
  location: string;
  warrantyUntil: string | null;
}

/**
 * КАКАЯ ЕДИНИЦА ВЫБРАНА — и чем она подписана (план кандидата, Ф1).
 *
 * Хук стоит при поле, а не в форме: с переводом отбора на сервер ответ на этот вопрос перестал
 * быть строчкой `find` по загруженному справочнику и собирается из трёх источников. Форме нужен
 * ответ — по нему она считает гарантию и заказчика, — а устройство ответа принадлежит полю.
 *
 * Источников три, и каждый закрывает случай, которого не закрывают остальные.
 *
 * 1. Текущая выдача — обычный выбор из списка.
 * 2. ПАМЯТЬ ВЫБРАННОГО. Выдача — срез по набранному, и следующий набор уносит из неё выбранное:
 *    без памяти подпись в поле сменилась бы идентификатором, реквизиты под ним пропали бы, а поле
 *    заказчика — оно считается по площадке выбранной единицы — заперлось бы, хотя человек всего
 *    лишь набрал следующий номер.
 * 3. ДОЧИТКА КАРТОЧКИ по идентификатору — для единицы, названной не набором: в обращении по
 *    гарантии её назвал реестр, при правке — заведение, а заведённая из самой формы приходит в
 *    поле готовым значением. В срез по набранному ни одна из трёх попасть не обязана.
 *
 * Спрашиваем карточку только тогда, когда справочник выдачей что-то показал, а выбранного в ней
 * нет: пустая выдача означает, что показывать этой учётке нечего вовсе — по идентификатору придёт
 * тот же ответ.
 *
 * Отдельной задержки ввода (debounce) здесь нет намеренно: выдачи лежат в кэше запросов по
 * набранному (`officeEquipmentKeys.options`), повторный набор сервер не тревожит, а лишний слой
 * ожидания добавил бы ровно одно — «поле отстаёт от набранного».
 */
export function useServiceRequestEquipment({
  open,
  equipmentId,
}: {
  open: boolean;
  /** Что стоит в поле формы сейчас; `undefined` — единицу ещё не выбрали. */
  equipmentId: string | undefined;
}) {
  const { can } = useAuth();
  const canRead = can('officeEquipment.read');
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<OfficeEquipmentOption | null>(null);

  const { data: options = [], isFetching: loading } = useQuery({
    ...officeEquipmentOptionsQuery(search),
    enabled: open && canRead,
  });
  const listed = options.find((option) => option.value === equipmentId);
  const remembered = picked?.value === equipmentId ? picked : undefined;
  const { data: fetched } = useQuery({
    ...officeEquipmentPickedQuery(equipmentId),
    enabled: open && canRead && !!equipmentId && !listed && !remembered && options.length > 0,
  });

  return {
    options,
    loading,
    search,
    selected: listed ?? remembered ?? fetched,
    onSearch: setSearch,
    // Выбранное запоминается опцией той выдачи, в которой его выбрали: следующий набранный запрос
    // эту выдачу сменит, а подпись и реквизиты обязаны остаться теми же.
    onPick: (id: string | undefined) =>
      setPicked(options.find((option) => option.value === id) ?? null),
  };
}

/**
 * Выбор единицы и её реквизиты в форме заявки (§9.3, Р40, Р48).
 *
 * Три вещи одним блоком, потому что отвечают они на один вопрос — «о каком аппарате речь»: само
 * поле, выход из тупика «техники нет в справочнике» и реквизиты, которые уйдут в заявку снимком.
 * Разложенные по форме порознь, они разъезжались бы: ссылка «Не нашли технику?» показывается ровно
 * там, где технику вообще выбирают, — при правке и в обращении по гарантии единица задана.
 */
export function ServiceRequestEquipmentField({
  request,
  claim,
  optional,
  selected,
  options,
  loading,
  open,
  search,
  onSearch,
  onPick,
}: {
  /** `null` — заведение: только тогда единицу и выбирают. */
  request: ServiceRequestDto | null;
  /** Обращение по гарантии: единица названа реестром и не правится. */
  claim: boolean;
  /**
   * Аппарат можно не называть (право `serviceRequests.createWithoutEquipment`, Р5): поле теряет
   * звёздочку и правило обязательности. Рядового заявителя это не касается — он обязан назвать
   * аппарат, иначе половина заявок уходила бы «в никуда», а история обслуживания единиц врала бы.
   */
  optional: boolean;
  selected?: EquipmentOption;
  options: EquipmentOption[];
  loading: boolean;
  open: boolean;
  /**
   * Что набрали в поле техники. Своей копии у поля нет — строка приходит из `useServiceRequestEquipment`
   * вместе с выдачей: с переводом поиска на сервер (Ф1) набранное стало параметром запроса, и
   * второй его владелец разъезжался бы с первым на первой же букве.
   *
   * Строка нужна и сама по себе: она уходит контекстом в обращение к поддержке, когда единицы в
   * справочнике не оказалось, — и держится после закрытия списка, потому что искали именно это.
   */
  search: string;
  onSearch: (value: string) => void;
  /** Что выбрали — идентификатором: по нему хук и запоминает выбранную единицу (память выбранного). */
  onPick: (id: string | undefined) => void;
}) {
  const { can } = useAuth();
  const form = Form.useFormInstance();
  const objectScope = useObjectScope();
  const equipmentId = Form.useWatch('officeEquipmentId', form);
  /*
   * Заявленный аппарат живёт ПОЛЕМ ФОРМЫ, а не состоянием компонента (план кандидата, Р2): его
   * отправляет `submitServiceRequest` вместе с описанием и вложениями, а сбрасывает — общий
   * `form.resetFields()` при открытии окна. Своим `useState` он пережил бы закрытие формы и уехал
   * бы в следующую заявку сообщением о чужом аппарате.
   *
   * `preserve` ОБЯЗАТЕЛЕН: у поля нет своего `Form.Item` (показывать нечего — плашку рисует ссылка
   * ниже), а `useWatch` без него читает только ОБЪЯВЛЕННЫЕ поля и вернул бы `undefined` навсегда.
   * Заводить ради подписки скрытый `Form.Item` нельзя: его контролу пришлось бы отдать объект
   * значением, и React ругался бы на него в каждом рендере.
   */
  const candidateDraft = Form.useWatch<EquipmentCandidateDraft | undefined>('equipmentCandidate', {
    form,
    preserve: true,
  });
  const missing = !request && !claim && !equipmentId;

  /*
   * Площадка учётки — контекст обращения в поддержку. Спрашивается только у объектной роли с
   * единственным объектом: с несколькими портал не знает, на какой из них стоит ненайденная
   * техника, и называть первый попавшийся значило бы отправить поддержку не туда.
   */
  const { data: objectOptions = [] } = useQuery({
    ...objectOptionsQuery({ activeOnly: false }),
    enabled: open && missing && !!objectScope.soleObjectId,
  });
  const ownObjectName = objectOptions.find(
    (option) => option.value === objectScope.soleObjectId,
  )?.label;

  /*
   * Выбранная единица дописывается к вариантам, когда её нет в выдаче. Выдача — срез по
   * набранному (Ф1), и следующий набор её из списка уносит: `Select` подписать значение может
   * только вариантом, и без этой строки в поле осталась бы строка идентификатора — на глазах у
   * человека, который ничего не менял.
   */
  const shownOptions = useMemo(
    () =>
      selected && !options.some((option) => option.value === selected.value)
        ? [selected, ...options]
        : options,
    [options, selected],
  );

  return (
    <>
      {/* Подпись человеческая (Р17): «Техника» называла раздел, а поле спрашивает про конкретный
          аппарат — тот, который сломался или которому нужен картридж. */}
      <Form.Item
        name="officeEquipmentId"
        label="Какой аппарат"
        /*
         * Звёздочка и правило снимаются вместе: поле без правила, но со звёздочкой обещало бы
         * отказ, которого не будет, а с правилом, но без звёздочки — молчало бы до нажатия
         * «Сохранить». Обязательность держателя права снимает **портал**, а не схема: она одна на
         * все учётки и прав не видит вовсе, поэтому пустой аппарат принимает всегда, а отвечает по
         * нему 403 маршрут (Р5).
         *
         * При правке правила нет ни у кого, и это не поблажка: единицу там не выбирают вовсе (поле
         * выключено), а у заявки без аппарата оно ещё и пусто — требование обязательности заперло
         * бы правку такой заявки для всех, кроме держателей права, отказом по полю, которое человек
         * не может заполнить.
         */
        /*
         * Заявленный аппарат снимает обязательность так же, как право заводить заявку без
         * аппарата: единицы в справочнике нет вовсе, и требовать выбрать её — значит требовать
         * невозможного от того, кто уже ответил на этот вопрос сообщением (Р5).
         */
        rules={
          optional || request || candidateDraft
            ? []
            : [{ required: true, message: 'Выберите единицу оргтехники' }]
        }
        extra={
          optional && !request && !claim
            ? 'Не выбран — заявка заведётся без аппарата, и заказчика придётся назвать самому'
            : undefined
        }
      >
        <AutoSelect
          showSearch
          /*
           * Отбор идёт на сервере (Ф1) — своего фильтра у поля нет вовсе. Оставь мы его, и он
           * молча резал бы найденное: сервер ищет и по серийному номеру, и по кабинету, а
           * клиентский фильтр видит одну подпись, в которой из двух номеров печатается один.
           */
          filterOption={false}
          /*
           * АВТОПОДСТАНОВКА ЕДИНСТВЕННОГО — только на нетронутой выдаче. Пока ничего не набрано,
           * единственный вариант означает единственную единицу справочника, и подставить её —
           * ровно то, за чем `AutoSelect` и заведён. С набранным то же самое означает другое:
           * «единственная, что нашлась по этим двум цифрам», — и поле выбирало бы аппарат за
           * человека, пока он ещё набирает номер.
           */
          autoSelectSole={!search}
          loading={loading}
          options={shownOptions}
          /*
           * Крестик — только у держателя права: выбранный по ошибке аппарат иначе нечем убрать, и
           * «оставьте поле пустым» оказалось бы советом, невыполнимым после первого же клика.
           * Подстановку единственного варианта он при этом не отменяет (`respectManualClear`):
           * справочник из одной единицы она заполняет по-прежнему, а очищенное руками поле
           * обратно не возвращает.
           */
          allowClear={optional}
          // Технику не меняют ни при правке (это другая заявка), ни в обращении по гарантии:
          // источник гарантии относится к конкретной единице, и подмена сделала бы ссылку ложной.
          disabled={!!request || claim}
          placeholder="Модель, инвентарный или серийный номер"
          onSearch={onSearch}
          // Свой обработчик не подменяет форменный: `Form.Item` вызывает оба — поле формы
          // заполняется как обычно, а форма запоминает саму единицу.
          onChange={(value: string | undefined) => onPick(value)}
          notFoundContent={
            !can('officeEquipment.read')
              ? 'Справочник недоступен'
              : search
                ? 'Ничего не нашлось — техники нет в справочнике'
                : 'Начните вводить модель или номер'
          }
        />
      </Form.Item>

      {/* Ответ на «ничего не нашлось» — под самим полем: тупик разбирается, не выходя из заявки.
          Ответа два, и различает их право вести справочник, а не роль (Р40). */}
      {missing && (
        <EquipmentNotFoundLink
          canCreate={can('officeEquipment.write')}
          search={search}
          objectName={ownObjectName}
          // Заведённая единица становится значением поля — тем же, каким её выбрали бы из списка:
          // заявка продолжается с того же места, где встала.
          onCreated={(equipment) => form.setFieldValue('officeEquipmentId', equipment.id)}
          draft={candidateDraft ?? null}
          // Заявленный аппарат кладётся в форму, а не отправляется: уйдёт он обычным «Сохранить»
          // вместе с заявкой — кандидат и заявка рождаются одной транзакцией (Р2).
          onReported={(reported) => form.setFieldValue('equipmentCandidate', reported ?? undefined)}
        />
      )}

      {/* Реквизиты предмета (Р48, Р57): что именно уйдёт в заявку снимком. Источников два —
          справочник при заведении и сама заявка при правке. Там же, под строкой «Где стоит», живёт
          и чекбокс «аппарат стоит на другом объекте» (Р16): спорят именно с этой строкой. */}
      <ServiceRequestSubject request={request} selected={selected} />
    </>
  );
}
