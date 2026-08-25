import type { ReactNode } from 'react';
import { Button, DatePicker, Input, Select, Space, Tooltip } from 'antd';
import dayjs from 'dayjs';
import {
  OPEN_WASTE_STATUSES,
  REQUEST_TYPES,
  requestStatusLabels,
  requestTypeLabels,
  type ContainerKind,
} from '@technic/contracts';
import type { FilterDefinition, FilterOption, FilterOptionGroup } from '@shared/ui';

/**
 * Отбор рабочего списка заявок на вывоз: полоса полей для десктопа и те же значения описаниями
 * для шита телефона (ADR 0030).
 *
 * Отдельным файлом по той же причине, что и у журнала путевых листов: фильтров семь и собираются
 * они дважды. В самой странице они утопили бы то, ради чего её открывают, — заявку, её статус и
 * действия над ней, — а от списка им нужны только значения и обработчики.
 */

/** Что список спрашивает у сервера: значения фильтров без страницы и сортировки. */
export interface WasteFilterValues {
  status?: string;
  requestType?: string;
  containerTypeId?: string;
  containerKind?: ContainerKind;
  operatorCounterpartyId?: string;
  /** Границы периода подачи — датами `YYYY-MM-DD`; моментами они становятся в запросе. */
  deliveryFrom?: string;
  deliveryTo?: string;
  /** Реестр разбора талонов (ADR 0114, Р24): `pending` — «требуют разбора». */
  ticketReview?: string;
  [key: string]: unknown;
}

interface Options {
  values: WasteFilterValues;
  onChange: (patch: Partial<WasteFilterValues>) => void;
  /**
   * Объект: у роли с единственной площадкой фильтр показан, но заперт, — «все» у неё означало бы
   * ровно её же объект. Пустая строка здесь и есть «все»: список сужает сервер.
   */
  objects: {
    options: FilterOption[];
    loading: boolean;
    value: string;
    disabled: boolean;
    onChange: (value: string) => void;
  };
  /** Контейнер или машина: варианты собирает `subjectFilter` — там же и разбор выбранного. */
  subject: {
    options: FilterOptionGroup[];
    value: string | undefined;
    onChange: (value: string | undefined) => void;
  };
  /**
   * Операторы вывоза. `null` — фильтра нет вовсе: исполнителя выбирает тот, кто назначает, а в
   * списке самого оператора все заявки и так его (ADR 0010).
   */
  operators: { options: FilterOption[]; loading: boolean } | null;
  /** Номер заявки: в поле он живёт строкой («М-128»), в параметрах — числом. */
  num: { text: string; onChange: (raw: string) => void };
  /** Реестр разбора талонов — отдельное право (ADR 0114, Р25): без него нет и фильтра. */
  ticketReview: boolean;
}

const DATE = 'YYYY-MM-DD';

const requestTypeOptions = REQUEST_TYPES.map((t) => ({ value: t, label: requestTypeLabels[t] }));

/**
 * Только рабочие статусы (ADR 0135): завершённые и отменённые живут вкладкой «История», и сервер
 * их в этом списке не отдаёт вовсе — вариант фильтра, кончающийся отказом, хуже его отсутствия.
 */
const statusOptions = OPEN_WASTE_STATUSES.map((s) => ({ value: s, label: requestStatusLabels[s] }));

/** Полоса фильтров: объект, тип, статус, предмет, период подачи, оператор, разбор и номер. */
export function wasteFiltersBar(o: Options): ReactNode {
  return (
    <Space size={[12, 8]} wrap>
      {/* Список раскрывается по своей ширине, а не по ширине поля: с адресом подпись площадки
          длиннее любого разумного фильтра, и обрезанная в многоточие она перестаёт отвечать на
          «та ли это площадка». Само поле остаётся узким — панель от этого не разъезжается.
          Потолок в 90 % ширины экрана нужен на планшете: без него длинный адрес вытолкнул бы
          список за край. */}
      <Select
        style={{ width: 240 }}
        popupMatchSelectWidth={false}
        styles={{ popup: { root: { maxWidth: '90vw' } } }}
        value={o.objects.value}
        onChange={o.objects.onChange}
        options={[{ value: '', label: 'Все объекты' }, ...o.objects.options]}
        showSearch
        optionFilterProp="label"
        disabled={o.objects.disabled}
      />
      <Select
        style={{ width: 190 }}
        allowClear
        placeholder="Все типы заявок"
        options={requestTypeOptions}
        value={o.values.requestType}
        onChange={(v: string | undefined) => o.onChange({ requestType: v })}
      />
      <Select
        style={{ width: 150 }}
        allowClear
        placeholder="Все статусы"
        options={statusOptions}
        value={o.values.status}
        onChange={(v: string | undefined) => o.onChange({ status: v })}
      />
      <Select
        style={{ width: 200 }}
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Контейнер / машина"
        options={o.subject.options}
        value={o.subject.value}
        onChange={o.subject.onChange}
      />
      {/* Период — по дате подачи, как и в журнале «История»: список читают по времени, когда
          вывозили, а не когда завели заявку. Обе границы необязательны — «с начала месяца» и «по
          пятницу» спрашивают не реже полного промежутка. */}
      <DatePicker.RangePicker
        format="DD.MM.YYYY"
        style={{ width: 250 }}
        allowEmpty={[true, true]}
        placeholder={['Подача с', 'по']}
        value={[
          o.values.deliveryFrom ? dayjs(o.values.deliveryFrom) : null,
          o.values.deliveryTo ? dayjs(o.values.deliveryTo) : null,
        ]}
        onChange={(range) =>
          o.onChange({
            deliveryFrom: range?.[0]?.format(DATE),
            deliveryTo: range?.[1]?.format(DATE),
          })
        }
      />
      {o.operators && (
        <Select
          style={{ width: 200 }}
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="Все операторы"
          options={o.operators.options}
          loading={o.operators.loading}
          value={o.values.operatorCounterpartyId}
          onChange={(v: string | undefined) => o.onChange({ operatorCounterpartyId: v })}
        />
      )}
      {/* Рабочий реестр того, кто сверяет бумаги (Р24): в отбор попадает и заявка без единого
          расхождения, если её талоны ещё не подтверждены, — иначе они остались бы неразобранными
          навсегда, а неподтверждённый талон не занимает номер. */}
      {o.ticketReview && (
        <Tooltip title="Заявки, где талоны ждут человека: не подтверждены, спорны, не прочитаны или расходятся с закрытием">
          <Button
            type={o.values.ticketReview ? 'primary' : 'default'}
            onClick={() =>
              o.onChange({ ticketReview: o.values.ticketReview ? undefined : 'pending' })
            }
          >
            Требуют разбора
          </Button>
        </Tooltip>
      )}
      <Input
        style={{ width: 160 }}
        allowClear
        placeholder="Поиск по № заявки"
        value={o.num.text}
        onChange={(e) => o.num.onChange(e.target.value)}
      />
    </Space>
  );
}

/**
 * Те же фильтры описаниями — для шита на телефоне (ADR 0030). Панель выше остаётся панелью: на
 * десктопе она вся на виду, и собирать её из описаний было бы переписыванием ради единообразия.
 * Значения и обработчики здесь общие с ней — расходиться нечему.
 */
export function wasteMobileFilters(o: Options): FilterDefinition[] {
  return [
    {
      kind: 'select',
      key: 'objectId',
      label: 'Объект',
      value: o.objects.value || undefined,
      options: o.objects.options,
      placeholder: 'Все объекты',
      loading: o.objects.loading,
      // С одним объектом фильтр показан, но не меняется; с несколькими — выбор из своих.
      disabled: o.objects.disabled,
      onChange: (v) => o.objects.onChange(v ?? ''),
    },
    {
      kind: 'select',
      key: 'requestType',
      label: 'Тип заявки',
      value: o.values.requestType,
      options: requestTypeOptions,
      placeholder: 'Все типы заявок',
      onChange: (v) => o.onChange({ requestType: v }),
    },
    {
      kind: 'select',
      key: 'status',
      label: 'Статус',
      value: o.values.status,
      options: statusOptions,
      placeholder: 'Все статусы',
      onChange: (v) => o.onChange({ status: v }),
    },
    {
      kind: 'select',
      key: 'containerTypeId',
      label: 'Контейнер / машина',
      value: o.subject.value,
      options: o.subject.options,
      placeholder: 'Любой',
      onChange: o.subject.onChange,
    },
    {
      kind: 'dateRange',
      key: 'delivery',
      label: 'Период подачи',
      from: o.values.deliveryFrom,
      to: o.values.deliveryTo,
      onChange: (deliveryFrom, deliveryTo) => o.onChange({ deliveryFrom, deliveryTo }),
    },
    ...(o.operators
      ? [
          {
            kind: 'select' as const,
            key: 'operatorCounterpartyId',
            label: 'Оператор вывоза',
            value: o.values.operatorCounterpartyId,
            options: o.operators.options,
            placeholder: 'Все операторы',
            loading: o.operators.loading,
            onChange: (v: string | undefined) => o.onChange({ operatorCounterpartyId: v }),
          },
        ]
      : []),
    {
      kind: 'text',
      key: 'num',
      label: '№ заявки',
      value: o.num.text || undefined,
      placeholder: 'Например, М-128',
      onChange: (v) => o.num.onChange(v ?? ''),
    },
    ...(o.ticketReview
      ? [
          {
            kind: 'toggle' as const,
            key: 'ticketReview',
            label: 'Требуют разбора',
            value: o.values.ticketReview === 'pending',
            onChange: (v: boolean) => o.onChange({ ticketReview: v ? 'pending' : undefined }),
          },
        ]
      : []),
  ];
}
