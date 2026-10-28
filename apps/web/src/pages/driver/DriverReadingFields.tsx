import type { ReactNode } from 'react';
import { Input, Typography } from 'antd';
import { durationLabel, shiftSpanMinutes, type DriverPreviousReading } from '@technic/contracts';
import { previousHintText, type ReadingField } from '@entities/vehicle-reading';
import type { DraftItem } from './api';
import { fieldLabelStyle, hintStyle, keepVisible } from './readingFieldStyles';
import { TimeField } from './DriverTimeField';
import { parseTime } from './readingStops';
import { fuelStartHint } from './readingChecks';
import { timeFields } from './readingsTimes';

/**
 * Числовые поля показания и их раскладка по ходу смены (ADR 0163, Р7).
 *
 * Отдельным файлом от [блока](DriverReadingBlock.tsx) не по смыслу, а по размеру: пять полей с
 * тремя заголовками групп не помещаются рядом с состоянием, предупреждениями и файлами в 400
 * строк — порог бюджета качества (`scripts/quality.mjs`). Граница честная: здесь ни своего
 * состояния, ни сети, ни решений об отправке — только ввод чисел и то, чем они подписаны.
 *
 * The groups follow the shift, not "counters first": the form is read top to bottom as the shift
 * went. Since ADR 0237 it is filled at the END of the shift, whole — both fuel levels and one of the
 * two counters are required; only «Заправлено» may stay empty (nothing was refuelled). The group
 * titles are a working part of the layout, not decoration: two fields captioned «Топливо» differ only
 * by them. Without titles the captions would have to grow («Топливо на начало смены»), and in a cab,
 * on the move, two long similar captions read as the same field (Р7).
 *
 * An ESM-2 item also records its shift time here (ADR 0234, D9 variant A): «Время начала» opens the
 * start group, «Время окончания» the end group, because the time is taken at the same moment as the
 * numbers next to it. A route's times are per stop and live in the route block above the counters
 * ([DriverRouteTimes](DriverRouteTimes.tsx)); a relocation has none (D8).
 */

/** Заголовок группы — тоже заголовок, и жирный отличает его от подписи поля под ним. */
const groupTitleStyle = { display: 'block' } as const;

/**
 * Запятая нормализуется в точку прямо на вводе: на телефоне десятичный разделитель зависит от
 * раскладки, и человек набирает тот, что есть на клавише, — отказывать ему за это нельзя.
 * `integer` — про одометр: он целый по схеме, и не принять дробную часть на вводе лучше, чем
 * отклонить отправкой целого дня.
 *
 * Разряды при наборе не группируются (П2): пробел, вставленный между цифрами во время ввода,
 * сдвигает позицию курсора, и человек дописывает пробег в середину числа. Группировка — только
 * при выводе, в подписях и предупреждениях.
 */
function normalizeDecimal(raw: string, integer: boolean): string {
  const cleaned = raw.replace(/\s/gu, '').replace(',', '.');
  if (!integer) return cleaned.replace(/[^\d.]/gu, '');
  // Целое поле отбрасывает дробную часть, а не склеивает её с целой: «145 320,7», превращённое
  // выбрасыванием разделителя в «1453207», — это молча выросший в десять раз пробег, который и
  // схему пройдёт, и в учёт ляжет. Отбросить десятые честнее: одометр целый по схеме.
  return cleaned.split('.')[0]!.replace(/\D/gu, '');
}

/** Ошибка стоит под своим полем, а не тостом в углу: отказ обязан называть поле (ADR 0094). */
function FieldError({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <Typography.Text type="danger" style={hintStyle}>
      {text}
    </Typography.Text>
  );
}

function NumberField({
  label,
  value,
  hint,
  error,
  integer,
  suffix,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  /** «предыдущее: 145 320 (10.08)» — то, с чем водитель сверяет набранное (П1). */
  hint?: string;
  error?: string;
  integer: boolean;
  suffix: string;
  disabled: boolean;
  onChange: (next: string) => void;
}) {
  return (
    <label style={{ display: 'block' }}>
      <Typography.Text style={fieldLabelStyle}>{label}</Typography.Text>
      <Input
        className="driver-number"
        // `decimal`, а не `numeric`: моточасы и литры дробные, и клавиатура без разделителя
        // сделала бы их ввод невозможным.
        inputMode="decimal"
        size="large"
        value={value}
        suffix={suffix}
        disabled={disabled}
        status={error ? 'error' : undefined}
        onFocus={keepVisible}
        onChange={(e) => onChange(normalizeDecimal(e.target.value, integer))}
      />
      {/* Подпись с предыдущим значением остаётся и при ошибке: именно она подсказывает, каким
          число должно быть, — убрать её там, где она нужнее всего, было бы странно. */}
      {hint && (
        <div>
          <Typography.Text type="secondary" style={hintStyle}>
            {hint}
          </Typography.Text>
        </div>
      )}
      <FieldError text={error} />
    </label>
  );
}

/** Группа полей одного момента смены: заголовок и то, что в этот момент снимают. */
function FieldGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Typography.Text strong style={groupTitleStyle}>
        {title}
      </Typography.Text>
      {children}
    </div>
  );
}

export interface ReadingFieldsProps {
  value: DraftItem;
  /** Предыдущий снимок счётчиков этой машины; `null` — начало ряда, сравнивать не с чем. */
  previous: DriverPreviousReading | null;
  /** Ошибки по именам полей схемы: их же именами их и подсвечивает форма. */
  errors: Record<string, string>;
  /** Грубое предупреждение по полю — считает блок той же проверкой, которой лист не пускает день. */
  hardOf: (field: ReadingField) => string | undefined;
  /** Читающий режим гасит все пять полей разом: выключать их поимённо — забыть шестое (Р10). */
  disabled: boolean;
  /** An ESM-2 item: the shift pair is typed here. A route keeps its times in the route block. */
  timed: boolean;
  onChange: (patch: Partial<DraftItem>) => void;
}

/**
 * «смена 12 ч» under the end time, read by `shiftSpanMinutes` — the one reading of a pair
 * the site's shift window uses too. An end earlier than the start is the next day, and the hint
 * says so, since that is the one case a typo and a night shift look alike. Equal times get no
 * hint: the submit refuses them («начало и конец смены совпадают»).
 */
function spanHint(startedAt: string, endedAt: string): string | undefined {
  const start = parseTime(startedAt);
  const end = parseTime(endedAt);
  if (!start || !end || start === 'invalid' || end === 'invalid' || start === end) return undefined;
  const minutes = shiftSpanMinutes(start, end);
  if (minutes === null) return undefined;
  const night = end < start ? ' · ночная — конец раньше начала' : '';
  return `смена ${durationLabel(minutes * 60)}${night}`;
}

export function ReadingFields({
  value,
  previous,
  errors,
  hardOf,
  disabled,
  timed,
  onChange,
}: ReadingFieldsProps) {
  return (
    <>
      <FieldGroup title="Начало смены">
        {timed && (
          <TimeField
            label="Время начала"
            value={value.startedAt}
            error={errors[timeFields.startedAt]}
            disabled={disabled}
            onChange={(next) => onChange({ startedAt: next })}
          />
        )}
        {/* The level in the tank, not a flow: it is not summed over a period. Under it stands the end
            of the previous shift (ADR 0237) — the number it must equal; a different one is not
            refused, the submit window asks about it. */}
        <NumberField
          label="Топливо"
          suffix="л"
          integer={false}
          value={value.fuelStartLiters}
          hint={fuelStartHint(previous)}
          error={errors.fuelStartLiters ?? hardOf('fuelStartLiters')}
          disabled={disabled}
          onChange={(next) => onChange({ fuelStartLiters: next })}
        />
      </FieldGroup>

      <FieldGroup title="За смену">
        {/* Заправлено ЗА СМЕНУ, а не остаток в баке: две заправки водитель складывает сам (Р4).
            Предыдущего снимка у заправки нет вовсе — она разовая, сравнивать её не с чем. */}
        <NumberField
          label="Заправлено"
          suffix="л"
          integer={false}
          value={value.fuelFilledLiters}
          error={errors.fuelFilledLiters ?? hardOf('fuelFilledLiters')}
          disabled={disabled}
          onChange={(next) => onChange({ fuelFilledLiters: next })}
        />
      </FieldGroup>

      <FieldGroup title="Конец смены">
        {timed && (
          <TimeField
            label="Время окончания"
            value={value.endedAt}
            hint={spanHint(value.startedAt, value.endedAt)}
            error={errors[timeFields.endedAt]}
            disabled={disabled}
            onChange={(next) => onChange({ endedAt: next })}
          />
        )}
        {/* Показание счётчика НА КОНЕЦ СМЕНЫ, а не работа за смену: хранится снимок, разности
            считает сервер — вычитать в уме водителю не за чем (ADR 0103). Теперь это сказано
            заголовком группы, и подписи полей коротки настолько, что читаются на ходу. */}
        <NumberField
          label="Одометр"
          suffix="км"
          integer
          value={value.odometerKm}
          hint={previousHintText(previous, 'odometerKm')}
          error={errors.odometerKm ?? hardOf('odometerKm')}
          disabled={disabled}
          onChange={(next) => onChange({ odometerKm: next })}
        />
        <NumberField
          label="Моточасы"
          suffix="ч"
          integer={false}
          value={value.engineHours}
          hint={previousHintText(previous, 'engineHours')}
          error={errors.engineHours ?? hardOf('engineHours')}
          disabled={disabled}
          onChange={(next) => onChange({ engineHours: next })}
        />
        <NumberField
          label="Топливо"
          suffix="л"
          integer={false}
          value={value.fuelEndLiters}
          error={errors.fuelEndLiters ?? hardOf('fuelEndLiters')}
          disabled={disabled}
          onChange={(next) => onChange({ fuelEndLiters: next })}
        />
      </FieldGroup>
    </>
  );
}
