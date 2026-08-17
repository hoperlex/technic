import { useState } from 'react';
import {
  Button,
  Card,
  Form,
  InputNumber,
  Modal,
  Popconfirm,
  Space,
  Tooltip,
  Typography,
} from 'antd';
import { CopyOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { MAX_ROUTE_REQUESTS, type VehicleRequestTripDto } from '@technic/contracts';
import { FormGrid } from '@shared/ui';
import { RequestTripFields } from './RequestTripFields';
import { blankTrip, repeatTrip, type TripFormValue } from './requestTripsForm';
import { tripsCountLabel } from './shared';

/**
 * Список ездок в форме заявки на грузоперевозку (§4.1 плана `docs/route-trips-plan.md`, этап 6).
 *
 * Заявка с одной ездкой выглядит и заполняется **ровно как сегодня**: те же поля, в том же
 * порядке, в тех же ячейках сетки — и одна кнопка под ними. Список разворачивается по нажатию,
 * потому что заявок с одной ездкой большинство, и усложнять их ввод ради «шести с карьера» нельзя.
 *
 * Ездки ведутся значениями формы (`trips`), а не антовским `Form.List`: адресное поле и контакт
 * зовут форму напрямую и путь к полю знают целиком, а `Form.List` подставляет свой префикс только
 * элементам `Form.Item` — вложенный компонент об этом префиксе не знает ничего.
 */

interface Props {
  /**
   * Сохранённые ездки правимой заявки; `null` — заводится новая. По ним строка списка узнаёт своё
   * прежнее состояние: номер («ТС-40/2») и послабления Р2а для непроверенного адреса и пустого
   * контакта.
   */
  savedTrips: readonly VehicleRequestTripDto[] | null;
  /**
   * Показывать ли список. Решает форма при открытии окна: у заявки с несколькими ездками — да, у
   * заявки с одной, несущей своё время или примечание, — тоже (свёрнутый вид их не показывает).
   * Дальше флаг поднимает сама кнопка «+ ездка».
   */
  expanded: boolean;
  onExpand: () => void;
  suggestObjectIds: readonly string[];
  cargoRequired: boolean;
}

/** Ключи строк из значений формы — по ним список знает свой состав, не глядя в сами поля. */
function tripKeys(values: { trips?: (TripFormValue | undefined)[] }): string[] {
  return (values?.trips ?? []).map((t) => t?.key ?? '');
}

/**
 * Сколько копий добавить. Отдельным окном, а не парой «число + кнопка» в каждой карточке: копий
 * спрашивают один раз на заявку, а поле ввода в каждой строке стояло бы шесть раз и путалось бы с
 * количеством груза.
 */
function RepeatModal({
  open,
  max,
  onCancel,
  onOk,
}: {
  open: boolean;
  /** Сколько копий ещё влезает: ездок в заявке не больше `MAX_ROUTE_REQUESTS`. */
  max: number;
  onCancel: () => void;
  onOk: (times: number) => void;
}) {
  const [times, setTimes] = useState(1);
  return (
    <Modal
      title="Повторить ездку"
      open={open}
      okText="Повторить"
      cancelText="Отмена"
      onCancel={onCancel}
      onOk={() => onOk(Math.min(Math.max(times, 1), max))}
      afterClose={() => setTimes(1)}
      width={420}
    >
      <Form layout="vertical">
        <Form.Item
          label="Сколько копий добавить"
          // Что копия несёт, а что нет, сказано здесь, а не в истории: время подачи у копий пустое
          // намеренно (Р3) — шесть ездок за смену едут по графику, а не одновременно.
          extra="Адреса, контакты и груз копируются; время подачи у копий остаётся «как у заявки»"
        >
          <InputNumber
            min={1}
            max={max}
            value={times}
            onChange={(v) => setTimes(v ?? 1)}
            style={{ width: '100%' }}
            autoFocus
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}

export function RequestTripsBlock({
  savedTrips,
  expanded,
  onExpand,
  suggestObjectIds,
  cargoRequired,
}: Props) {
  const form = Form.useFormInstance();
  /*
   * Подписка на **состав** списка: возвращённое значение не нужно — нужен сам сигнал к
   * перерисовке. Показывается при этом то, что лежит в форме сейчас (`rows` ниже), а не снимок
   * подписки: она приходит макрозадачей позже, и в кадре между ними список показал бы состав,
   * которого уже нет.
   *
   * Селектором по ключам, а не наблюдением за всем полем `trips`: `useWatch` сравнивает результат
   * сериализацией, и блок перерисовывается на добавление, размножение и удаление строки — а не на
   * каждую букву, набранную в адресе шестой ездки.
   *
   * `preserve` здесь обязателен, а не для порядка: без него наблюдение видит значения **только
   * заведённых полей** (`getFieldsValue()` против `getFieldsValue(true)`), а ключ строки поля не
   * имеет — его никто не показывает и не правит. Получилась бы петля: новая строка не показана,
   * значит её полей нет, значит её не видно в составе, значит она не появится.
   */
  Form.useWatch(tripKeys, { form, preserve: true });
  /** Строка, которую размножают; `null` — окно закрыто. */
  const [repeatAt, setRepeatAt] = useState<number | null>(null);

  const savedById = new Map((savedTrips ?? []).map((t) => [t.id, t]));
  /**
   * Ездки, как они лежат в форме **сейчас**.
   *
   * Функцией, а не значением рендера, и это не стиль: блок перерисовывается только на смену
   * состава (см. подписку выше), а набранное в полях меняет значения формы между перерисовками.
   * Возьми обработчик снимок рендера — и «+ ездка», нажатая после ввода адреса, сохранила бы
   * состав вместе со стёртым адресом.
   */
  const readTrips = () => (form.getFieldValue('trips') ?? []) as TripFormValue[];
  /** Снимок для разметки: состав между перерисовками не меняется — меняются только значения. */
  const rows = readTrips();
  const full = rows.length >= MAX_ROUTE_REQUESTS;

  /**
   * Новый состав списка в форму.
   *
   * Правится он целиком, а не по строкам: удаление сдвигает соседей, и их поля переезжают на
   * другие пути. Вместе с составом снимаются ошибки строк — они остались бы висеть на прежних
   * путях, то есть на чужих теперь строках, и человек искал бы незаполненный адрес там, где он
   * заполнен. Правила проверят список заново при отправке.
   */
  const setTrips = (next: TripFormValue[]) => {
    form.setFieldsValue({ trips: next });
    form.setFields(
      next.flatMap((_row, i) =>
        [
          'fromLocation',
          'toLocation',
          'fromResponsibleName',
          'fromResponsiblePhone',
          'toResponsibleName',
          'toResponsiblePhone',
          'volumeM3',
          'weightTons',
          'scheduledTime',
        ].map((field) => ({ name: ['trips', i, field], errors: [] })),
      ),
    );
  };

  const addTrip = () => {
    setTrips([...readTrips(), blankTrip()]);
    onExpand();
  };

  const removeTrip = (index: number) => {
    setTrips(readTrips().filter((_row, i) => i !== index));
  };

  /** Копии встают сразу за исходной строкой: «шесть раз с карьера» читается подряд, а не вразбивку. */
  const applyRepeat = (index: number, times: number) => {
    const current = readTrips();
    const source = current[index];
    if (!source) return;
    setTrips([
      ...current.slice(0, index + 1),
      ...repeatTrip(source, times),
      ...current.slice(index + 1),
    ]);
    setRepeatAt(null);
  };

  // Свёрнутый вид: заявка с одной ездкой — это вчерашняя заявка (Р24), и поля у неё те же самые.
  if (!expanded && rows.length <= 1) {
    return (
      <>
        <RequestTripFields
          index={0}
          saved={rows[0]?.id ? savedById.get(rows[0].id) : undefined}
          suggestObjectIds={suggestObjectIds}
          cargoRequired={cargoRequired}
          detailed={false}
        />
        <FormGrid.Full>
          <Form.Item>
            <Button icon={<PlusOutlined />} onClick={addTrip}>
              Ездка
            </Button>
            <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
              Одной заявкой можно заказать несколько ездок — например, шесть раз с карьера на объект
            </Typography.Text>
          </Form.Item>
        </FormGrid.Full>
      </>
    );
  }

  return (
    <FormGrid.Full>
      <Form.Item label="Ездки заявки">
        <Space direction="vertical" size={12} style={{ display: 'flex' }}>
          {rows.map((row, index) => {
            const saved = row.id ? savedById.get(row.id) : undefined;
            return (
              <Card
                key={row.key}
                size="small"
                title={
                  <Space size={8} wrap>
                    {/* Номер называется только у сохранённой ездки, и это не мелочь: номера не
                        переиспользуются (Р13а), и «ТС-40/2» у новой строки после удаления второй
                        обещал бы то, чего сервер не сделает. Новой строке номер назначат при
                        сохранении. */}
                    <span>{saved ? saved.displayNumber : 'Новая ездка'}</span>
                    <Typography.Text type="secondary" style={{ fontWeight: 'normal' }}>
                      строка {index + 1} из {rows.length}
                    </Typography.Text>
                  </Space>
                }
                extra={
                  <Space size={4}>
                    <Tooltip title={full ? `Ездок в заявке не больше ${MAX_ROUTE_REQUESTS}` : null}>
                      <Button
                        type="text"
                        size="small"
                        icon={<CopyOutlined />}
                        disabled={full}
                        onClick={() => setRepeatAt(index)}
                      >
                        Повторить
                      </Button>
                    </Tooltip>
                    {/* Убранная сохранённая ездка удаляется мягко (Р13а): на неё может ссылаться
                        выданный лист, и журнал бланков строгой отчётности обязан помнить, что
                        печаталось. Поэтому спрашиваем — и говорим про номер, который не вернётся. */}
                    <Popconfirm
                      title={saved ? `Убрать ездку ${saved.displayNumber}?` : 'Убрать ездку?'}
                      description="Она перестанет ехать и печататься, но останется в истории и в журнале листов. Номер за ней сохранится: следующая ездка получит следующий свободный."
                      okText="Убрать"
                      cancelText="Отмена"
                      // Незаведённую строку спрашивать не о чем: за ней ничего не стоит.
                      disabled={!saved}
                      onConfirm={() => removeTrip(index)}
                    >
                      <Button
                        type="text"
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        // Ездок в заявке не меньше одной: заявка без ездки — заказ, в котором не
                        // сказано, что везти и куда.
                        disabled={rows.length <= 1}
                        onClick={saved ? undefined : () => removeTrip(index)}
                      />
                    </Popconfirm>
                  </Space>
                }
              >
                <FormGrid>
                  <RequestTripFields
                    index={index}
                    saved={saved}
                    suggestObjectIds={suggestObjectIds}
                    cargoRequired={cargoRequired}
                    detailed
                  />
                </FormGrid>
              </Card>
            );
          })}
          <Space size={8} wrap>
            <Button icon={<PlusOutlined />} onClick={addTrip} disabled={full}>
              Ездка
            </Button>
            {/* Порядок строк не значит ничего — ездки упорядочены своим номером, а порядок объезда
                принадлежит рейсу (Р1). Без этой строчки список читается как маршрут. */}
            <Typography.Text type="secondary">
              {full
                ? `Ездок в заявке не больше ${MAX_ROUTE_REQUESTS}: заявка едет одним маршрутом целиком`
                : `${tripsCountLabel(rows.length)} · порядок объезда задаёт рейс, здесь — что и куда везти`}
            </Typography.Text>
          </Space>
        </Space>
      </Form.Item>
      <RepeatModal
        open={repeatAt !== null}
        max={MAX_ROUTE_REQUESTS - rows.length}
        onCancel={() => setRepeatAt(null)}
        onOk={(times) => applyRepeat(repeatAt!, times)}
      />
    </FormGrid.Full>
  );
}
