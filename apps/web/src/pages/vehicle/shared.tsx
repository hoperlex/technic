import { useState, type ReactNode } from 'react';
import { App, Button, Form, Select, Tag, Tooltip, Typography, Upload } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import {
  assignmentTitle,
  type VehicleRequestAssignmentDto,
  type VehicleRequestEarlyEndDto,
  vehicleOptionLabel,
} from '@technic/contracts';
import { counterpartiesApi, counterpartyKeys } from '@entities/counterparty';
import { driverKeys, driversApi } from '@entities/driver';
import { filesApi } from '@entities/file';
import { vehicleKeys, vehiclesApi } from '@entities/vehicle';
import type {
  VehicleClassificationGroup,
  VehicleClassificationOption,
} from '../../hooks/useVehicleClassifications';
import { AutoSelect, ExpandableCell, type FilterDefinition } from '@shared/ui';
import { FileLinkList } from '../../components/FileLinks';
import { errorMessage } from '../../utils/format';
import { formatDateOnly } from '../../utils/date';
import { objectsApi, objectKeys } from '@entities/object';

export const FILE_MAX_COUNT = 20;
export const FILE_MAX_SIZE = 52_428_800; // 50 МБ

/**
 * Дата без времени переехала к остальным правилам дат (`utils/date`): её печатает и гараж
 * (ADR 0076), которому эта страница не видна. Реэкспорт — для прежних потребителей.
 */
export { formatDateOnly };

export interface EditorFile {
  id: string;
  filename: string;
  /** Нужен ссылке в списке: фото и PDF открываются окном просмотра, остальное скачивается. */
  contentType: string;
  size: number;
  isNew: boolean;
}

/** Опции активных объектов для Select (грузятся разом, pageSize=500). */
export function useObjectOptions() {
  const { data, isFetching } = useQuery({
    queryKey: objectKeys.options({ activeOnly: true }),
    queryFn: () =>
      objectsApi.list({
        page: 1,
        pageSize: 500,
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
  });
  return {
    options: (data?.items ?? []).map((o) => ({ value: o.id, label: `${o.code} — ${o.name}` })),
    loading: isFetching,
  };
}

/**
 * Собственная техника для фильтров маршрутов и журнала листов.
 *
 * Только `own`: рейс ведётся и лист выписывается лишь на свою машину — арендную ведёт
 * арендодатель, и в этих двух списках её не бывает вовсе. Списанная и стоящая в ремонте из
 * фильтра не убираются: вчерашние рейсы и выданные листы никуда не делись, а фильтр, не находящий
 * собственной строки списка, читается как поломка.
 *
 * Подпись — `vehicleOptionLabel`, парой «госномер — марка/модель» (ADR 0098): машину выбирают
 * двумя приметами сразу, и ровно так она представлена в справочнике техники.
 */
export function useOwnVehicleOptions() {
  const { data, isFetching } = useQuery({
    queryKey: vehicleKeys.ownOptions(),
    queryFn: () =>
      vehiclesApi.list({ page: 1, pageSize: 500, ownership: 'own', sortBy: 'createdAt' }),
  });
  return {
    options: (data?.items ?? [])
      .map((v) => ({ value: v.id, label: vehicleOptionLabel(v) }))
      .sort((a, b) => a.label.localeCompare(b.label, 'ru')),
    loading: isFetching,
  };
}

/**
 * Фильтр по назначенной машине — для списка заказов и журнала закрытых (ADR 0098).
 *
 * Спрашивает единицу парка, а не позицию классификатора: «где сейчас мой КамАЗ» и «какие заявки им
 * закрыли» — вопросы к конкретной машине, и рядом стоящий фильтр по типу на них не отвечает.
 * Классификатор остаётся своим фильтром (`useVehicleClassificationFilter`) — он отвечает на «какую
 * технику заказывали», а заказывают тип, а не машину.
 *
 * В списке и своя техника, и арендная: заявку закрывают любой — арендную берут ровно тогда, когда
 * своей не хватило, — и искать по ней надо тем же полем. Отбор списанных и стоящих в ремонте не
 * убирает, как и в фильтре маршрутов: вчерашние заявки никуда не делись.
 *
 * Заявка без назначенной машины под такой фильтр не попадает — машины у неё ещё нет, а не «строка
 * пропала»: «Новая» заявка отвечает на «что заказали», и техники в ней не бывает по существу.
 */
export function useVehicleFilter({
  vehicleId,
  onChange,
}: {
  vehicleId: string | undefined;
  onChange: (patch: { vehicleId?: string }) => void;
}): { controls: ReactNode; mobileFilter: FilterDefinition } {
  const { data, isFetching } = useQuery({
    queryKey: vehicleKeys.allOptions(),
    queryFn: () => vehiclesApi.list({ page: 1, pageSize: 500, sortBy: 'createdAt' }),
  });
  // Порядок — по подписи, а не по заведению в справочнике: машину ищут глазами по госномеру.
  const options = (data?.items ?? [])
    .map((v) => ({ value: v.id, label: vehicleOptionLabel(v) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ru'));

  const controls = (
    <Select
      allowClear
      showSearch
      optionFilterProp="label"
      placeholder="Вся техника"
      style={{ width: 240 }}
      options={options}
      loading={isFetching}
      value={vehicleId}
      onChange={(v: string | undefined) => onChange({ vehicleId: v })}
    />
  );

  /** Тот же фильтр описанием — для шита на телефоне (ADR 0030). */
  const mobileFilter: FilterDefinition = {
    kind: 'select',
    key: 'vehicleId',
    label: 'Техника',
    value: vehicleId,
    options,
    placeholder: 'Вся техника',
    loading: isFetching,
    onChange: (v) => onChange({ vehicleId: v }),
  };

  return { controls, mobileFilter };
}

/**
 * Арендодатели для фильтра журнала — контрагенты роли «Арендодатель (ТС)»: по ним и сводят расходы
 * на аренду. Неактивные из списка не убираем: журнал читают и про тех, с кем уже не работают.
 *
 * Живёт здесь, рядом с прочими опциями фильтров раздела, а не в самом журнале: список читается
 * теми же двумя строками, что объекты и водители, и в странице он был запросом посреди экрана.
 */
export function useLessorOptions() {
  const { data, isFetching } = useQuery({
    queryKey: counterpartyKeys.vehicleLessorOptions(),
    queryFn: () =>
      counterpartiesApi.list({
        page: 1,
        pageSize: 500,
        type: 'vehicle_lessor',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
  });
  return {
    options: (data?.items ?? []).map((c) => ({ value: c.id, label: c.name })),
    loading: isFetching,
  };
}

/**
 * Водители для фильтров: весь действующий справочник, по алфавиту. Ни категория, ни полнота
 * документов здесь никого не убирают — это фильтр списка, а не подбор под машину (ADR 0064).
 *
 * `enabled` — для страниц, открытых тому, у кого `drivers.read` нет (ADR 0192: журнал путевых
 * листов площадке). Умолчание `true` оставляет прежних потребителей нетронутыми, а выключенный
 * запрос не уходит вовсе: карточки водителей — персональные данные (ADR 0037), и просить их «на
 * всякий случай», чтобы получить 403 и нарисовать пустой список, значит держать в журнале сервера
 * отказ на каждое открытие страницы.
 */
export function useDriverOptions(enabled = true) {
  const { data, isFetching } = useQuery({
    queryKey: driverKeys.options(),
    queryFn: () =>
      driversApi.list({ page: 1, pageSize: 500, sortBy: 'fullName', sortOrder: 'asc' }),
    enabled,
  });
  return {
    options: (data?.items ?? []).map((d) => ({ value: d.id, label: d.fullName })),
    loading: isFetching,
  };
}

/**
 * Фильтр по заказанной технике переехал к самому классификатору (`useVehicleClassificationFilter`):
 * его спрашивает и гараж (ADR 0076), а импорт чужой страницы запрещён границами слоёв. Реэкспорт
 * держится для прежних потребителей — они берут его отсюда вместе с остальным общим этой страницы.
 */
export { useVehicleClassificationFilter } from '../../hooks/useVehicleClassificationFilter';

/** Редактор прикреплённых файлов (загрузка в S3 + список add/remove). */
export function useFileEditor() {
  const { message } = App.useApp();
  const [files, setFiles] = useState<EditorFile[]>([]);
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);

  const reset = (initial: EditorFile[] = []) => {
    setFiles(initial);
    setRemovedIds([]);
  };
  const upload = async (file: File) => {
    if (files.length >= FILE_MAX_COUNT) {
      message.error(`Не более ${FILE_MAX_COUNT} файлов`);
      return;
    }
    if (file.size > FILE_MAX_SIZE) {
      message.error('Файл больше 50 МБ');
      return;
    }
    setUploading(true);
    try {
      const dto = await filesApi.upload(file);
      setFiles((p) => [
        ...p,
        {
          id: dto.id,
          filename: dto.filename,
          contentType: dto.contentType,
          size: dto.size,
          isNew: true,
        },
      ]);
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setUploading(false);
    }
  };
  const remove = (id: string) => {
    const f = files.find((x) => x.id === id);
    setFiles((p) => p.filter((x) => x.id !== id));
    if (!f) return;
    if (f.isNew) void filesApi.remove(id).catch(() => undefined);
    else setRemovedIds((p) => [...p, id]);
  };
  const newFileIds = () => files.filter((f) => f.isNew).map((f) => f.id);

  return { files, removedIds, uploading, reset, upload, remove, newFileIds };
}

export function FileEditor({ editor }: { editor: ReturnType<typeof useFileEditor> }) {
  return (
    <div>
      <Upload
        multiple
        showUploadList={false}
        beforeUpload={(f) => {
          void editor.upload(f);
          return false;
        }}
      >
        <Button icon={<UploadOutlined />} loading={editor.uploading}>
          Прикрепить файлы
        </Button>
      </Upload>
      <div style={{ marginTop: 8 }}>
        <FileLinkList
          files={editor.files}
          emptyText="Нет файлов"
          onRemove={(f) => editor.remove(f.id)}
        />
      </div>
    </div>
  );
}

/*
 * Контакты заявки и счёт ездок живут своим модулем (`requestContacts.tsx`), а отсюда
 * переизлучаются: их зовут восемь экранов по имени из `shared`, и переучивать их разом — правка
 * шире самой причины.
 */
export { requestContacts, RequestContactsCell, tripsCountLabel } from './requestContacts';

/**
 * Назначенная техника в строке списка (ADR 0027): чем заявку взяли, а под этим — приписка, ради
 * которой колонку читают дальше. Саму приписку задаёт вкладка, и намеренно: в работе спрашивают
 * «во сколько встало» и там стоит ставка, а в журнале стоимость разнесена по своим колонкам, и на
 * этом месте полезнее арендодатель. Общей вынесена оболочка ячейки — иначе одна и та же колонка
 * «Техника» держала бы высоту строки по-разному на каждой вкладке.
 *
 * Ячейка сворачивается (`ExpandableCell`): у назначения ровно две строки, замер скрытого ничего не
 * найдёт и кнопки не покажет, — фиксированная высота заведена не ради него, а ради состава
 * недельной заявки, который ложится в эту же колонку строкой на каждую единицу техники.
 *
 * Заявка без назначения — прочерк без обёртки: сворачивать в нём нечего, а лишний замер и
 * позиционирование кнопки пришлись бы на каждую «Новую» заявку списка.
 */
export function RequestAssignmentCell({
  assignment,
  detail,
}: {
  assignment: VehicleRequestAssignmentDto | null;
  /** Вторая строка. Функцией, а не строкой: у вкладок она разная и считается по назначению. */
  detail: (assignment: VehicleRequestAssignmentDto) => string;
}) {
  if (!assignment) return <Typography.Text type="secondary">—</Typography.Text>;
  return (
    <ExpandableCell>
      <div>{assignmentTitle(assignment)}</div>
      <div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {detail(assignment)}
        </Typography.Text>
      </div>
    </ExpandableCell>
  );
}

/**
 * Выбор заказываемой техники (ADR 0028): одна позиция классификатора — категория типа
 * («Автокраны, г/п 130 т») либо сам тип, если ТТХ у него нет («Ямобур»). Список сгруппирован по
 * виду ТС и сужен типом заявки, поэтому до его выбора поле недоступно. В форме лежит ключ
 * позиции, в API уходит пара «тип + категория».
 *
 * Справа от наименования — порядок цены позиции: средняя ставка её техники. Приписка живёт только
 * в раскрытом списке (`optionRender`): поиск идёт по наименованию, и выбранная позиция называется
 * им же — цена в свёрнутом поле читалась бы как согласованная ставка, а она справочная.
 */
export function VehicleClassificationSelect({
  groups,
  loading,
  disabled,
  placeholder = 'Выберите тип или категорию',
}: {
  groups: VehicleClassificationGroup[];
  loading: boolean;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <Form.Item
      name="classificationKey"
      label="Тип/категория ТС"
      tooltip="У типа с характеристиками выбирают категорию — «Автокран, г/п 130 т»; тип без характеристик выбирается целиком. Список сужен типом заявки: грузоперевозку выполняет только грузовая техника"
      rules={[{ required: true, message: 'Выберите тип или категорию' }]}
    >
      <AutoSelect
        options={groups}
        showSearch
        optionFilterProp="label"
        loading={loading}
        disabled={disabled}
        placeholder={placeholder}
        optionRender={(option) => {
          const hint = (option.data as VehicleClassificationOption).priceHint;
          if (!hint) return option.label;
          return (
            <div className="option-row">
              <span className="option-row__label">{option.label}</span>
              <Typography.Text type="secondary" className="option-row__hint">
                {hint}
              </Typography.Text>
            </div>
          );
        }}
      />
    </Form.Item>
  );
}

/**
 * Досрочное завершение в строке списка (ADR 0044): ожидание визы — оранжевым, состоявшееся
 * сокращение — серой припиской «срок сокращён с …».
 *
 * Ожидающий визы запрос показывается везде, где видно заявку: пока визы нет, срок в строке
 * прежний, и без тега площадка узнавала бы об отъезде техники в день отъезда. Отклонённый
 * запрос в списке не показывается — заявка живёт по заказанному сроку, и объяснение к этому
 * лежит в карточке.
 */
export function EarlyEndTag({ earlyEnd }: { earlyEnd: VehicleRequestEarlyEndDto | null }) {
  if (!earlyEnd || earlyEnd.status === 'rejected') return null;
  if (earlyEnd.status === 'pending') {
    return (
      <Tooltip title={`Запросил ${earlyEnd.requestedByName}: ${earlyEnd.reason}`}>
        <Tag color="orange" style={{ marginInlineEnd: 0 }}>
          досрочно до {formatDateOnly(earlyEnd.newDateTo)} · ждёт визы
        </Tag>
      </Tooltip>
    );
  }
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      срок сокращён с {formatDateOnly(earlyEnd.previousDateTo)}
    </Typography.Text>
  );
}
