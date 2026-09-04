import type { FocusEvent, ReactNode } from 'react';
import { Input, Typography } from 'antd';
import type { DriverPreviousReading } from '@technic/contracts';
import { previousHintText, type ReadingField } from '@entities/vehicle-reading';
import type { DraftItem } from './api';

/**
 * Числовые поля показания и их раскладка по ходу смены (ADR 0163, Р7).
 *
 * Отдельным файлом от [блока](DriverReadingBlock.tsx) не по смыслу, а по размеру: пять полей с
 * тремя заголовками групп не помещаются рядом с состоянием, предупреждениями и файлами в 400
 * строк — порог бюджета качества (`scripts/quality.mjs`). Граница честная: здесь ни своего
 * состояния, ни сети, ни решений об отправке — только ввод чисел и то, чем они подписаны.
 *
 * Порядок групп — по ходу дня, а не «сначала счётчики»: форму заполняют сверху вниз тем, что уже
 * есть на руках, и утром это остаток в баке. Заголовки групп — рабочая часть раскладки, а не
 * оформление: два поля с подписью «Топливо» различаются только ими. Без заголовков подписи
 * пришлось бы удлинять («Топливо на начало смены»), и в кабине, на ходу, два длинных похожих
 * заголовка читаются как одно и то же поле (Р7).
 */

/**
 * Подсказка под полем и текст отказа (план типографики, Р4). `0.9em`, а не прежние `0.85`: строку
 * «предыдущее: 145 320 (10.08)» водитель СВЕРЯЕТ с набранным, стоя у машины, — она мельче
 * набранного намеренно, но читаться обязана без прищура.
 */
export const hintStyle = { fontSize: '0.9em' } as const;

/**
 * Подпись поля — заголовок поля, а не примечание к нему: базовым размером кабинета и обычным
 * цветом (Р4). Серым и мельче основного текста, как было, она читалась как сноска к чужому полю —
 * а это единственное, что называет вводимое число.
 */
export const fieldLabelStyle = { display: 'inline-block', marginBottom: 2 } as const;

/** Заголовок группы — тоже заголовок, и жирный отличает его от подписи поля под ним. */
const groupTitleStyle = { display: 'block' } as const;

/**
 * Экранная клавиатура перекрывает поле, к которому её и вызвали. Браузер прокручивает к нему сам
 * не всегда и не сразу, поэтому доводим сами — с задержкой, за которую клавиатура успевает
 * появиться и сжать окно.
 */
export function keepVisible(event: FocusEvent<HTMLElement>): void {
  const target = event.currentTarget;
  setTimeout(() => target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
}

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
  onChange: (patch: Partial<DraftItem>) => void;
}

export function ReadingFields({
  value,
  previous,
  errors,
  hardOf,
  disabled,
  onChange,
}: ReadingFieldsProps) {
  /*
   * Подсказка о недосданном вечере (Р8) считается из показанных значений — ни поля в базе, ни
   * состояния у неё нет. Состояние пришлось бы гасить при всякой правке, и первое же расхождение
   * оставило бы подсказку висеть над уже заполненным концом смены.
   *
   * Условие смотрит на утро ИЛИ дневную заправку и на отсутствие ВСЕХ трёх вечерних чисел: день, в
   * котором сняли хотя бы один вечерний счётчик, недосданным больше не считается — что снимать
   * дальше, решает машина, а не портал.
   */
  const started = Boolean(value.fuelStartLiters || value.fuelFilledLiters);
  const ended = Boolean(value.odometerKm || value.engineHours || value.fuelEndLiters);

  return (
    <>
      <FieldGroup title="Начало смены">
        {/* Остаток в баке — уровень, а не поток: за период он не суммируется, и подсказки
            «предыдущий остаток» под ним нет намеренно (Р9). Сравнение остатков между сменами —
            это уже расход, а его портал не считает. */}
        <NumberField
          label="Топливо"
          suffix="л"
          integer={false}
          value={value.fuelStartLiters}
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
        {/* Словами, а не запретом: передать одно утро — законный день (Р6), и отказывать за него
            нельзя. Формулировка намеренно не говорит «сдано начало»: водитель мог передать одну
            дневную заправку, и «начала» у него нет. */}
        {started && !ended && (
          <Typography.Text type="secondary" style={hintStyle}>
            Вечерние показания ещё не переданы — снимите их в конце смены
          </Typography.Text>
        )}
      </FieldGroup>
    </>
  );
}
