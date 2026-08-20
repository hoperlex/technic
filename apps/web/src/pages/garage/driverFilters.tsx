import type { ReactNode } from 'react';
import { Select, Space } from 'antd';
import {
  GARAGE_DRIVER_STATES,
  garageDriverStateLabels,
  type GarageDriverState,
} from '@technic/contracts';
import { useWaybillFormFilter } from '@features/waybill-form-filter';
import { type FilterDefinition } from '@shared/ui';
import { useObjectsFilter } from './objectsFilter';

/**
 * Отбор вкладки «Водители»: полоса над таблицей и те же четыре фильтра описаниями для шита
 * телефона (`FilterDefinition`). Обе половины собирает одна функция — расходиться им негде: фильтр,
 * появившийся на десктопе и не появившийся в шите, здесь просто не заводится порознь.
 *
 * Отдельным файлом, а не строками в `GarageDriversTab.tsx`: у вкладки бюджет длины
 * (`quality-budget.json`), и разметка отбора вместе с описаниями в него не помещалась.
 *
 * Хук, а не обычная функция: площадки приходят запросом справочника, и звать его вкладка обязана
 * по правилам хуков — на верхнем уровне и всегда.
 */

const STATE_OPTIONS = GARAGE_DRIVER_STATES.map((state) => ({
  value: state,
  label: garageDriverStateLabels[state],
}));

const DOCUMENT_OPTIONS = [
  { value: 'complete', label: 'Комплект полный' },
  { value: 'incomplete', label: 'Есть пробелы' },
];

/** Что отбор берёт из параметров списка: страницу и сортировку он не спрашивает. */
export interface DriverFilterParams {
  state?: GarageDriverState;
  documents?: 'complete' | 'incomplete';
  /**
   * Площадки работы дня набором — `objects=<uuid>,<uuid>` (Р8). Строкой, а не массивом: в
   * параметрах списка значения лежат ровно в том виде, в каком уходят в адрес запроса.
   */
  objects?: string;
  /**
   * Бланки работы дня набором — `forms=4p,esm2` (Р6). Ключ ведёт только эта вкладка: на «Технике»
   * отбора по бланку нет и схема его запрещает (Р20).
   */
  forms?: string;
}

export function useDriverFilters({
  params,
  applyFilter,
}: {
  params: DriverFilterParams;
  /** Правка отбора: страницу на первую возвращает вкладка, у неё же живут остальные параметры. */
  applyFilter: (patch: DriverFilterParams) => void;
}): { bar: ReactNode; mobile: FilterDefinition[] } {
  const objectsFilter = useObjectsFilter({ objects: params.objects, onChange: applyFilter });
  const formFilter = useWaybillFormFilter({ forms: params.forms, onChange: applyFilter });

  const bar = (
    <Space size={[12, 8]} wrap>
      <Select<GarageDriverState>
        allowClear
        placeholder="Любое состояние"
        style={{ width: 180 }}
        options={STATE_OPTIONS}
        value={params.state}
        onChange={(v) => applyFilter({ state: v })}
      />
      <Select<'complete' | 'incomplete'>
        allowClear
        placeholder="Любые документы"
        style={{ width: 190 }}
        options={DOCUMENT_OPTIONS}
        value={params.documents}
        onChange={(v) => applyFilter({ documents: v })}
      />
      {objectsFilter.controls}
      {formFilter.controls}
    </Space>
  );

  const mobile: FilterDefinition[] = [
    {
      kind: 'select',
      key: 'state',
      label: 'Состояние',
      value: params.state,
      options: [...STATE_OPTIONS],
      placeholder: 'Любое состояние',
      onChange: (v) => applyFilter({ state: v as GarageDriverState | undefined }),
    },
    {
      kind: 'select',
      key: 'documents',
      label: 'Документы',
      value: params.documents,
      options: DOCUMENT_OPTIONS,
      placeholder: 'Любые документы',
      onChange: (v) => applyFilter({ documents: v as 'complete' | 'incomplete' | undefined }),
    },
    objectsFilter.mobileFilter,
    formFilter.mobileFilter,
  ];

  return { bar, mobile };
}
