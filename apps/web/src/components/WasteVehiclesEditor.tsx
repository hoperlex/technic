import { Button, InputNumber, Tooltip, Typography } from 'antd';
import { DeleteOutlined, PlusCircleOutlined } from '@ant-design/icons';
import {
  type ContainerKind,
  containerKindLabels,
  MAX_VEHICLE_COUNT_PER_ROW,
  MAX_VEHICLE_ROWS_PER_REQUEST,
  type WasteRequestVehicleInput,
  type WasteVehicleCountInput,
} from '@technic/contracts';
import { AutoSelect } from './AutoSelect';
import { useIsMobile } from '../hooks/useIsMobile';
import { formatMoney } from '../utils/format';

/**
 * Строка факта вывоза: тип техники и сколько таких машин (ADR 0024). Заведённая строка несёт
 * `id` — у неё правится только количество: тип и есть тождество строки, а сумма посчитана по
 * снимку цены именно для него.
 */
export interface VehicleDraft {
  /** Локальный ключ строки (в БД не уходит). */
  key: string;
  /** id заведённой машины; undefined — строка ещё не сохранена. */
  id?: string;
  containerTypeId?: string;
  count: number;
}

/** Тип техники с вместимостью: из неё считается объём строки, поэтому в опции нужна явно. */
export interface VehicleTypeOption {
  value: string;
  label: string;
  /** Вместимость одной машины, м³; null — у типа не задана, выбрать его нельзя. */
  volumeM3: number | null;
  /** Вид техники: список разложен по группам — самосвалы и контейнеры вперемешку не читаются. */
  kind: ContainerKind;
}

/**
 * Цена за м³ для типа: число — тариф найден, null — прайс для типа не задан, undefined — цена
 * ещё грузится. Три состояния различаются намеренно: «цены нет» и «цена не доехала» требуют от
 * человека разного.
 */
export type PriceLookup = (containerTypeId: string) => number | null | undefined;

let draftSeq = 0;
export function emptyVehicleDraft(): VehicleDraft {
  draftSeq += 1;
  return { key: `v${draftSeq}`, containerTypeId: undefined, count: 1 };
}

/** Заведённая машина → строка формы: количество правится, тип остаётся прежним. */
export function existingVehicleDraft(v: {
  id: string;
  containerTypeId: string;
  count: number;
}): VehicleDraft {
  draftSeq += 1;
  return { key: `e${draftSeq}`, id: v.id, containerTypeId: v.containerTypeId, count: v.count };
}

/**
 * Заполненность строк: тип обязателен, количество — не меньше одной машины. Талон здесь не
 * спрашивается: он общий на заявку (ADR 0024) и живёт отдельным блоком окна.
 * Один тип — одна строка: две строки того же типа сложились бы в расчёте как разные машины,
 * а сервер такую пару всё равно не примет.
 */
export function validateVehicleDrafts(drafts: readonly VehicleDraft[]): string | null {
  const seen = new Set<string>();
  for (const [i, d] of drafts.entries()) {
    const num = i + 1;
    if (!d.containerTypeId) return `Строка ${num}: выберите тип машины`;
    if (!Number.isInteger(d.count) || d.count < 1) return `Строка ${num}: укажите количество`;
    if (seen.has(d.containerTypeId)) {
      return `Строка ${num}: этот тип уже указан выше — сложите их в одну строку`;
    }
    seen.add(d.containerTypeId);
  }
  return null;
}

/** Новые строки → тело запроса. Вызывать после validateVehicleDrafts. */
export function draftsToInput(drafts: readonly VehicleDraft[]): WasteRequestVehicleInput[] {
  return drafts
    .filter((d) => !d.id)
    .map((d) => ({ containerTypeId: d.containerTypeId!, count: d.count }));
}

/** Заведённые строки, у которых поменяли количество, — только они и уходят на сервер. */
export function changedCounts(
  drafts: readonly VehicleDraft[],
  original: readonly { id: string; count: number }[],
): WasteVehicleCountInput[] {
  const was = new Map(original.map((v) => [v.id, v.count]));
  return drafts
    .filter((d) => d.id != null && was.get(d.id) !== d.count)
    .map((d) => ({ vehicleId: d.id!, count: d.count }));
}

/** Вместимость выбранного типа; 0 — тип не выбран или вместимость не задана. */
function typeVolume(draft: VehicleDraft, typeOptions: readonly VehicleTypeOption[]): number {
  return typeOptions.find((t) => t.value === draft.containerTypeId)?.volumeM3 ?? 0;
}

/** Объём строки = вместимость типа × количество; тот же расчёт делает сервер при сохранении. */
export function draftVolume(
  draft: VehicleDraft,
  typeOptions: readonly VehicleTypeOption[],
): number {
  return Math.round(typeVolume(draft, typeOptions) * draft.count * 1000) / 1000;
}

export function sumDraftVolume(
  drafts: readonly VehicleDraft[],
  typeOptions: readonly VehicleTypeOption[],
): number {
  const sum = drafts.reduce((acc, d) => acc + draftVolume(d, typeOptions), 0);
  return Math.round(sum * 1000) / 1000;
}

/** Стоимость строки по прайсу: объём × цена за м³. null — цены для типа нет либо она ещё грузится. */
export function draftAmount(
  draft: VehicleDraft,
  typeOptions: readonly VehicleTypeOption[],
  priceOf: PriceLookup,
): number | null {
  if (!draft.containerTypeId) return null;
  const price = priceOf(draft.containerTypeId);
  if (price == null) return null;
  return Math.round(draftVolume(draft, typeOptions) * price * 100) / 100;
}

interface Props {
  value: VehicleDraft[];
  onChange: (next: VehicleDraft[]) => void;
  typeOptions: VehicleTypeOption[];
  /** Цена за м³ по типу: с ней в строке видно, во что обходится этот вывоз (ADR 0024). */
  priceOf?: PriceLookup;
}

/**
 * Чем вывезли заявку (ADR 0011, ADR 0024). Строка — «тип техники × количество», а не рейс:
 * оператор отчитывается «два самосвала 25 м³ и контейнер 8 м³», и объём считается из
 * вместимости типа, а не вводится руками. Талоны к строкам не крепятся — они общий пул заявки.
 */
export function WasteVehiclesEditor({ value, onChange, typeOptions, priceOf }: Props) {
  const isMobile = useIsMobile();
  const patch = (key: string, fields: Partial<VehicleDraft>) =>
    onChange(value.map((d) => (d.key === key ? { ...d, ...fields } : d)));

  const usedTypeIds = new Set(value.map((d) => d.containerTypeId).filter(Boolean) as string[]);

  const addRow = () => onChange([...value, emptyVehicleDraft()]);

  const removeRow = (key: string) => onChange(value.filter((d) => d.key !== key));

  /**
   * Список типов — оба вида сразу (ADR 0024), но по группам: самосвалами вывозят объём,
   * контейнерами — тару, и вперемешку в одном списке их не разобрать. Занятый другой строкой
   * тип выбрать нельзя: один тип живёт в заявке одной строкой с количеством.
   */
  const optionsFor = (draft: VehicleDraft) => {
    const groups = new Map<ContainerKind, { value: string; label: string; disabled: boolean }[]>();
    for (const t of typeOptions) {
      const taken = t.value !== draft.containerTypeId && usedTypeIds.has(t.value);
      const noVolume = t.volumeM3 == null;
      const list = groups.get(t.kind) ?? [];
      list.push({
        value: t.value,
        // Тип без вместимости выбрать нельзя: объём строки брать было бы неоткуда.
        label: noVolume
          ? `${t.label} — вместимость не задана`
          : taken
            ? `${t.label} — уже в списке`
            : t.label,
        disabled: noVolume || taken,
      });
      groups.set(t.kind, list);
    }
    return [...groups].map(([kind, options]) => ({ label: containerKindLabels[kind], options }));
  };

  const limitReached = value.length >= MAX_VEHICLE_ROWS_PER_REQUEST;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {value.map((d) => {
        const amount = priceOf ? draftAmount(d, typeOptions, priceOf) : null;
        const priceMissing =
          priceOf != null && d.containerTypeId != null && priceOf(d.containerTypeId) === null;

        /**
         * На телефоне строка разворачивается в блок (ADR 0030): пять элементов в ряд ужимают
         * выбор типа до трёх слов, а количество набирают степпером — по нему и попадают пальцем,
         * не целясь в стрелки размером со спичечную головку.
         */
        if (isMobile) {
          return (
            <div key={d.key} className="vehicle-draft">
              <div className="vehicle-draft__head">
                <AutoSelect
                  style={{ flex: 1, minWidth: 0 }}
                  placeholder="Тип машины"
                  options={optionsFor(d)}
                  showSearch
                  optionFilterProp="label"
                  value={d.containerTypeId}
                  disabled={d.id != null}
                  onChange={(v: string) => patch(d.key, { containerTypeId: v })}
                />
                <Button
                  danger
                  type="text"
                  icon={<DeleteOutlined />}
                  aria-label="Убрать строку"
                  disabled={d.id != null}
                  onClick={() => removeRow(d.key)}
                />
              </div>
              <div className="vehicle-draft__foot">
                <div className="stepper">
                  <Button
                    aria-label="Меньше на одну"
                    disabled={d.count <= 1}
                    onClick={() => patch(d.key, { count: d.count - 1 })}
                  >
                    −
                  </Button>
                  <InputNumber
                    style={{ width: 64 }}
                    min={1}
                    max={MAX_VEHICLE_COUNT_PER_ROW}
                    precision={0}
                    controls={false}
                    value={d.count}
                    onChange={(v) => patch(d.key, { count: typeof v === 'number' ? v : 1 })}
                    aria-label="Количество машин"
                  />
                  <Button
                    aria-label="Больше на одну"
                    disabled={d.count >= MAX_VEHICLE_COUNT_PER_ROW}
                    onClick={() => patch(d.key, { count: d.count + 1 })}
                  >
                    +
                  </Button>
                </div>
                <Typography.Text type={priceMissing ? 'warning' : 'secondary'}>
                  {d.containerTypeId ? `${draftVolume(d, typeOptions)} м³` : '— м³'}
                  {priceOf
                    ? priceMissing
                      ? ' · цены в прайсе нет — с этим типом заявку не закрыть'
                      : amount != null
                        ? ` · ${formatMoney(amount)}`
                        : ''
                    : ''}
                </Typography.Text>
              </div>
            </div>
          );
        }

        return (
          <div key={d.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <AutoSelect
              style={{ flex: 3, minWidth: 0 }}
              placeholder="Тип машины"
              options={optionsFor(d)}
              showSearch
              optionFilterProp="label"
              value={d.containerTypeId}
              // Тип заведённой строки не меняется: сумма по ней посчитана по снимку цены
              // именно этого типа, и подмена превратила бы её в цифру без происхождения.
              disabled={d.id != null}
              onChange={(v: string) => patch(d.key, { containerTypeId: v })}
            />
            <InputNumber
              style={{ width: 90 }}
              min={1}
              max={MAX_VEHICLE_COUNT_PER_ROW}
              precision={0}
              prefix="×"
              value={d.count}
              onChange={(v) => patch(d.key, { count: typeof v === 'number' ? v : 1 })}
              aria-label="Количество машин"
            />
            <Typography.Text style={{ minWidth: 76, textAlign: 'right', whiteSpace: 'nowrap' }}>
              {d.containerTypeId ? `${draftVolume(d, typeOptions)} м³` : '— м³'}
            </Typography.Text>
            {priceOf && (
              <Typography.Text
                type={priceMissing ? 'warning' : 'secondary'}
                style={{ minWidth: 110, textAlign: 'right', whiteSpace: 'nowrap' }}
              >
                {priceMissing ? (
                  <Tooltip title="Для этого типа цена в прайсе не задана — заявку с ним не закрыть">
                    цены нет
                  </Tooltip>
                ) : amount != null ? (
                  formatMoney(amount)
                ) : (
                  '—'
                )}
              </Typography.Text>
            )}
            {/* Заведённую строку убирают правкой заявки: там у неё есть пометка на удаление,
                возврат и удаление насовсем — здесь остаётся только количество. */}
            <Button
              danger
              type="text"
              icon={<DeleteOutlined />}
              aria-label="Убрать строку"
              disabled={d.id != null}
              onClick={() => removeRow(d.key)}
            />
          </div>
        );
      })}
      <Button
        type="text"
        icon={<PlusCircleOutlined style={{ fontSize: 18 }} />}
        onClick={addRow}
        disabled={limitReached}
        style={{ alignSelf: 'flex-start', paddingInline: 4 }}
      >
        {limitReached ? `Не более ${MAX_VEHICLE_ROWS_PER_REQUEST} строк` : 'Добавить тип'}
      </Button>
    </div>
  );
}

/** Сверка «заявлено ↔ вывезено»: подсказка, а не запрет (ADR 0011). */
export function VolumeSummary({ planned, actual }: { planned: number | null; actual: number }) {
  if (planned == null) {
    return <Typography.Text type="secondary">По машинам: {actual} м³</Typography.Text>;
  }
  const diff = Math.round((actual - planned) * 1000) / 1000;
  if (diff === 0) {
    return (
      <Typography.Text type="success">
        По машинам: {actual} м³ — совпадает с заявкой
      </Typography.Text>
    );
  }
  return (
    <Typography.Text type="warning">
      По машинам: {actual} м³ из {planned} м³ в заявке ({diff > 0 ? `+${diff}` : diff} м³)
    </Typography.Text>
  );
}
