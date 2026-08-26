import { useEffect, useRef } from 'react';
import { Checkbox, Form, Input, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { HitchedTrailerDto } from '@technic/contracts';
import { FormGrid } from '@shared/ui';
import {
  graphsAreHitched,
  hitchedTrailerGraphs,
  hitchedTrailerNote,
  TRACTOR_TRAILER_HINT,
  TRACTOR_TRAILERS_TYPE_CODE,
  vehicleTypesForTrailerKey,
} from '@entities/vehicle-route';
import { vehicleTypesApi } from '../../api/resources';

/**
 * Графы прицепа в форме рейса: галочка «с прицепом», две пары «марка / госномер» под ней и подпись
 * о том, откуда графы взялись.
 *
 * Один блок на пять окон заведения рейса — правку рейса, перевод заявки в работу, коррекцию
 * задним числом, день линейного заказа и «Новый маршрут». Держать его в копиях уже вышло боком:
 * вторую пару граф заводили копированием, и в окне назначения она осталась только на экране — до
 * сервера доезжала половина состава. Графа бланка одна, и спрашиваться она обязана одним кодом.
 *
 * **Почему пар две.** 4-П держит два прицепа, и колонки под них лежали в базе с самого заведения
 * листов. Спрашивать их было негде, и состав из двух прицепов доезжал до бумаги наполовину.
 * Порядок обязателен — сервер не примет второй прицеп при пустом первом (план
 * `docs/vehicle-trailers-plan.md`, §4.6).
 *
 * **Подстановка живёт здесь же, а не в окнах.** Правило чтения закрепления одно на все окна
 * (§4.2.2), и разложенное по пяти формам оно разошлось бы на первой правке. Здесь же оно и
 * выключается само собой там, где прицеп не спрашивают: блок не отрисован — подставлять некуда.
 *
 * **Где блок не показывается.** У формы № 3 граф прицепа нет вовсе (ADR 0071), поэтому прицеп
 * спрашивается только там, где он печатается. Решает это вызывающее окно: бланк рейса знает оно,
 * а у назначения условие и вовсе своё («реквизиты выезда у готового рейса уже свои»).
 *
 * Подписи и подсказки различаются по окнам намеренно и приходят пропсами: коррекция говорит о
 * рейсе в прошедшем времени, а примеры в подсказках у каждого окна свои — переписывать их заодно
 * с выносом значило бы менять экран под предлогом рефакторинга.
 */
export function TrailerFields({
  withTrailer,
  checkboxLabel,
  checkboxFullWidth = false,
  modelPlaceholder,
  regNumberPlaceholder,
  secondPlaceholder,
  hitched,
  vehicleId,
  vehicleTypeId,
  keepOwnGraphs = false,
  substituteOnOpen = true,
}: {
  /**
   * Состояние галочки, каким его видит форма прямо сейчас (`Form.useWatch('withTrailer', form)`).
   * Пропсом, а не своим наблюдением: то же значение окну нужно и для списка водителей — с прицепом
   * требование поднимается до CE, и список пересобирается (ADR 0055, ADR 0064).
   */
  withTrailer: boolean;
  /** Подпись галочки: коррекция описывает уже состоявшийся день и говорит о нём в прошедшем. */
  checkboxLabel: string;
  /**
   * Галочка занимает строку целиком. У правки и коррекции — да, у назначения нет: там она стоит
   * в паре с соседним полем, и перенос её на свою строку переставил бы форму.
   */
  checkboxFullWidth?: boolean;
  /** Пример марки первого прицепа — свой у каждого окна, по машинам, которые в нём заказывают. */
  modelPlaceholder: string;
  /** Пример госномера первого прицепа. */
  regNumberPlaceholder: string;
  /** Подсказка обеих граф второго прицепа: ею же сказано, что пара необязательна. */
  secondPlaceholder: string;
  /**
   * Закреплённые за машиной прицепы — поле `hitched` ответа `GET /vehicle-routes/suggest`.
   * `undefined` — ответ ещё не пришёл (подставлять рано), пустой массив — закрепления нет, и
   * новой подстановки у такой машины не бывает вовсе (§4.2.2, пункт 2).
   */
  hitched?: readonly HitchedTrailerDto[];
  /**
   * Машина, о которой спрошено закрепление: её смена — повод подставить заново.
   *
   * Смена **машины в форме** и смена **записи, которую окно показывает**, — разные события с
   * одинаковым следом в этом пропе, и различить их изнутри нечем. Поэтому окна, живущие дольше
   * одной записи (все пять — antd не размонтирует закрытое окно), ставят блоку `key` по
   * идентификатору записи: другой рейс, другой день, другая заявка — другой экземпляр блока с
   * чистой памятью о том, что он подставлял.
   */
  vehicleId?: string | null;
  /** Тип этой машины: по нему встаёт галочка у седельного тягача (§4.4 (а)). */
  vehicleTypeId?: string | null;
  /**
   * Не трогать графы, которые уже заполнены, пока машину не сменили. Так открывается окно правки
   * рейса: его графы пришли из самого рейса, и переписать их закреплением значило бы подменить
   * запись, которую человек открыл править. Пустые графы правка подставить даёт — там подстановка
   * ничего не вытесняет.
   */
  keepOwnGraphs?: boolean;
  /**
   * Подставлять ли под машину, с которой окно открылось. Коррекция говорит «нет»: она
   * переписывает **уже состоявшийся день**, и сегодняшнее закрепление о прошлом вторнике не знает
   * ничего — а подставленное в неё меняет форму само по себе и проводит проверку «коррекция
   * должна что-то менять» (Р31), сжигая номер бланка за правку, которой человек не делал. Смена
   * машины в коррекции — другое дело: графы описывают уже не ту единицу, и закрепление новой —
   * лучшее, что портал о ней знает.
   */
  substituteOnOpen?: boolean;
}) {
  const form = Form.useFormInstance();
  const trailer1Model = Form.useWatch('trailer1Model', form);
  const trailer1RegNumber = Form.useWatch('trailer1RegNumber', form);
  const trailer2Model = Form.useWatch('trailer2Model', form);
  const trailer2RegNumber = Form.useWatch('trailer2RegNumber', form);

  /**
   * Типы техники — ради одного вопроса: этот тип седельный тягач или нет. Спрашивается справочник
   * целиком, потому что в карточке машины (`VehicleDto`) кода типа нет — есть идентификатор и
   * наименование, а наименование в условии было бы сверкой по написанию. Запрос один на портал:
   * ключ общий, ответ кэшируется, и пять окон делят одну загрузку.
   */
  const { data: tractorTypeIds } = useQuery({
    queryKey: vehicleTypesForTrailerKey,
    queryFn: () => vehicleTypesApi.list({ page: 1, pageSize: 500 }),
    staleTime: 5 * 60 * 1000,
    select: (page) =>
      new Set(page.items.filter((t) => t.code === TRACTOR_TRAILERS_TYPE_CODE).map((t) => t.id)),
  });
  const isTractor = !!vehicleTypeId && !!tractorTypeIds?.has(vehicleTypeId);

  /**
   * Отпечаток закрепления: подстановка повторяется, когда сменилась машина или её состав прицепов,
   * и не повторяется больше никогда. Иначе снятая рукой галочка вставала бы обратно на каждой
   * перерисовке формы — а снимаемой она обязана быть (§4.4).
   */
  const signature = (hitched ?? [])
    .map((t) => `${t.position}:${t.id}:${t.model}:${t.registrationNumber}:${t.status}`)
    .join('|');

  const applied = useRef<string | null>(null);
  /** Машина, с которой окно открылось, и признак того, что её меняли: ими живёт `substituteOnOpen`. */
  const openVehicle = useRef<string | null | undefined>(undefined);
  const vehicleChanged = useRef(false);

  useEffect(() => {
    // Машину сняли — форму сбросили после заведения рейса. Память о подстановке снимается вместе
    // с ней: иначе второй рейс подряд на ту же единицу уехал бы с пустыми графами.
    if (!vehicleId) {
      applied.current = null;
      openVehicle.current = undefined;
      vehicleChanged.current = false;
      return;
    }
    // Ответа сервера ещё нет: пустых граф это не значит — значит «пока не знаем».
    if (hitched === undefined) return;
    if (openVehicle.current === undefined) openVehicle.current = vehicleId;
    else if (vehicleId !== openVehicle.current) vehicleChanged.current = true;

    const source = `${vehicleId}|${signature}|${isTractor}`;
    if (applied.current === source) return;
    applied.current = source;

    if (!substituteOnOpen && !vehicleChanged.current) return;

    const graphs = hitchedTrailerGraphs(hitched);
    const own =
      !!form.getFieldValue('withTrailer') ||
      !!form.getFieldValue('trailer1Model') ||
      !!form.getFieldValue('trailer1RegNumber') ||
      !!form.getFieldValue('trailer2Model') ||
      !!form.getFieldValue('trailer2RegNumber');
    if (keepOwnGraphs && !vehicleChanged.current && own) return;

    if (graphs) form.setFieldsValue(graphs);
    // Закрепления нет — новой подстановки не бывает (§4.2.2, пункт 2), но галочка тягача встаёт:
    // она про категорию прав и бланк, а не про то, чем машина сегодня укомплектована (§4.4 (а)).
    else if (isTractor) form.setFieldsValue({ withTrailer: true });
    // Зависимости — источник подстановки, а не форма: `form` у окна один и тот же всё время.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicleId, signature, isTractor, hitched === undefined]);

  /**
   * Подпись говорит о том, что в графах стоит **сейчас**, а не о том, что портал когда-то
   * подставил: вписал человек другой прицеп — подпись уходит, и врать ей нечем.
   */
  const note = graphsAreHitched(hitched, {
    withTrailer,
    trailer1Model,
    trailer1RegNumber,
    trailer2Model,
    trailer2RegNumber,
  })
    ? hitchedTrailerNote(hitched)
    : isTractor && withTrailer
      ? TRACTOR_TRAILER_HINT
      : null;

  const checkbox = (
    <Form.Item name="withTrailer" valuePropName="checked">
      <Checkbox>{checkboxLabel}</Checkbox>
    </Form.Item>
  );

  return (
    <>
      {checkboxFullWidth ? <FormGrid.Full>{checkbox}</FormGrid.Full> : checkbox}
      {withTrailer && (
        <>
          <Form.Item name="trailer1Model" label="Прицеп 1: марка">
            <Input placeholder={modelPlaceholder} />
          </Form.Item>
          <Form.Item name="trailer1RegNumber" label="Прицеп 1: госномер">
            <Input placeholder={regNumberPlaceholder} />
          </Form.Item>
          <Form.Item name="trailer2Model" label="Прицеп 2: марка">
            <Input placeholder={secondPlaceholder} />
          </Form.Item>
          <Form.Item name="trailer2RegNumber" label="Прицеп 2: госномер">
            <Input placeholder={secondPlaceholder} />
          </Form.Item>
          {note && (
            <FormGrid.Full>
              <Typography.Text type="secondary">{note}</Typography.Text>
            </FormGrid.Full>
          )}
        </>
      )}
    </>
  );
}

/**
 * Графы прицепа из формы — в тело рейса, теми же правилами во всех окнах.
 *
 * Реквизиты прицепа уходят только вместе с самим прицепом: без него сервер их не примет
 * («реквизиты прицепа без прицепа в рейсе не печатаются»), а у рейса они могли остаться с прошлого
 * раза — снятый прицеп забирает их с собой.
 *
 * Второй прицеп уходит наравне с первым. До выноса окно назначения его спрашивало (после
 * наследования от прошлого рейса) и **теряло на отправке**: ключей в теле было два, и рейс уезжал
 * с половиной состава, не сказав об этом ни слова. Ровно этой ошибке здесь больше негде взяться —
 * тело собирается одним местом на все окна.
 */
export function trailerTripBody(v: {
  withTrailer?: boolean;
  trailer1Model?: string;
  trailer1RegNumber?: string;
  trailer2Model?: string;
  trailer2RegNumber?: string;
}): {
  withTrailer: boolean;
  trailer1Model: string;
  trailer1RegNumber: string;
  trailer2Model: string;
  trailer2RegNumber: string;
} {
  const withTrailer = v.withTrailer ?? false;
  return {
    withTrailer,
    trailer1Model: withTrailer ? (v.trailer1Model ?? '') : '',
    trailer1RegNumber: withTrailer ? (v.trailer1RegNumber ?? '') : '',
    trailer2Model: withTrailer ? (v.trailer2Model ?? '') : '',
    trailer2RegNumber: withTrailer ? (v.trailer2RegNumber ?? '') : '',
  };
}
