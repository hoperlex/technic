import type { ReactNode } from 'react';
import { Form, Select, Space, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  trailerTitle,
  type VehicleTrailerDto,
  vehicleStatusColors,
  vehicleStatusLabels,
} from '@technic/contracts';
import { foreignHitchWarning, TRAILER_DIRECTORY_HINT } from '@entities/vehicle-route';
import { trailerPickerQuery } from '@entities/vehicle-trailer';

/**
 * Выбор прицепа из реестра для одной пары граф рейса (план `docs/vehicle-trailers-plan.md`, §13).
 *
 * **Выбор — не закрепление (Р18).** Список кладёт марку и госномер в те же текстовые графы, что
 * человек набрал бы руками, и больше не делает ничего: справочник от рейса не меняется. Закрепление
 * живёт в карточке прицепа и означает «стоит за этой машиной постоянно», а выбор в рейсе — «сегодня
 * едем с этим». Иначе один выезд чужим полуприцепом молча переписал бы реестр.
 *
 * Отсюда и устройство поля: своего значения в форме у него нет — оно **выводится** из граф
 * сопоставлением госномера с реестром (Р17, пункт 3). Поэтому переключение режима ничего не теряет
 * и правка граф руками не расходится с показанным выбором: показывать нечего, кроме того, что в
 * графах стоит.
 *
 * Отдельным файлом, а не внутри `TrailerFields`: блок граф общий на пять окон, и список с поиском,
 * пометками состояния и предупреждением увёл бы его за бюджет качества (`scripts/quality.mjs`).
 */
export function TrailerPicker({
  slot,
  vehicleId,
  excludeRegNumber,
}: {
  /** Пара граф бланка 4-П: 1 — первая, 2 — вторая. Ею же названы поля формы и подпись. */
  slot: 1 | 2;
  /**
   * Машина рейса: с ней сверяется закрепление выбранного прицепа. Чужое — предупреждение (Р19),
   * своё — обычный случай, ровно его портал и подставляет.
   */
  vehicleId?: string | null;
  /**
   * Госномер прицепа из соседней графы: одна единица не стоит в двух слотах сразу, и второй слот
   * не предлагает того, кто уже выбран в первом (§13.6).
   */
  excludeRegNumber?: string;
}) {
  const form = Form.useFormInstance();
  const modelField = `trailer${slot}Model`;
  const regField = `trailer${slot}RegNumber`;
  // Наблюдение обычное: графы остаются полями формы и в этом режиме — `TrailerFields` их прячет,
  // а не снимает, иначе выбранное не доехало бы ни до показа здесь, ни до тела рейса.
  const model = Form.useWatch<string | undefined>(modelField, form);
  const regNumber = Form.useWatch<string | undefined>(regField, form);

  const { data, isFetching, isError } = useQuery(trailerPickerQuery());
  const trailers = data ?? [];

  /**
   * Что стоит в графах — как строка списка. Госномер сравнивается без пробелов и регистра: в
   * бланке он печатается по-разному («АВ1234 77» и «ав123477» — один прицеп), а графы наполняют и
   * руками, и подстановкой.
   */
  const regKey = squash(regNumber);
  const picked = regKey ? trailers.find((t) => squash(t.registrationNumber) === regKey) : undefined;
  const typedTitle = trailerTitle({
    model: model ?? '',
    registrationNumber: regNumber ?? '',
  });

  const excluded = squash(excludeRegNumber);
  const options: PickerEntry[] = trailers
    // Собственный выбор из отбора не выпадает: стой в обеих графах одно и то же (наследство или
    // чужая правка) — поле обязано показать, что там стоит, а не опустеть.
    .filter((t) => !excluded || t.id === picked?.id || squash(t.registrationNumber) !== excluded)
    .map((t) => ({ value: t.id, label: rowOf(t), search: squash(trailerTitle(t)) }));

  /*
   * Графы, за которыми записи реестра не нашлось, поле показывает как есть — своей группой. Иначе
   * включённая галочка выглядела бы так, будто стёрла набранное: текст в графах остаётся, а поле
   * пусто. Сюда же попадает списанный прицеп — в списке его нет, а в графах рейса он законен (Р11).
   */
  if (!picked && typedTitle) {
    options.push({
      label: TYPED_GROUP_LABEL,
      options: [{ value: TYPED_VALUE, label: typedTitle, search: squash(typedTitle) }],
    });
  }

  const warning = foreignHitchWarning(picked, vehicleId);

  /*
   * Подпись связывается с полем руками: `htmlFor` `Form.Item` подставляет сам — из `name`, — а у
   * списка `name` нет и быть не может (своего значения в форме он не держит, см. выше). Без этой
   * пары клик по подписи никуда не ведёт, а озвучиватель читает поле безымянным.
   */
  const controlId = `trailer${slot}Picker`;

  return (
    <Form.Item
      label={`Прицеп ${slot}`}
      htmlFor={controlId}
      // Подсказка объясняет, что в списке и чего выбор из него не делает, — тем же приёмом, каким
      // объясняет себя выбор адреса из справочника (ADR 0069). Предупреждение встаёт под ней:
      // относится оно к выбранной строке, а не к списку, и молчать о нём поле не вправе (Р19).
      extra={
        <>
          {TRAILER_DIRECTORY_HINT}
          {warning && (
            <div>
              <Typography.Text type="warning">{warning}</Typography.Text>
            </div>
          )}
        </>
      }
    >
      <Select
        id={controlId}
        value={picked?.id ?? (typedTitle ? TYPED_VALUE : undefined)}
        options={options}
        showSearch
        // Подпись строки — узел с меткой состояния, и отбор по ней сравнивал бы разметку. Поэтому
        // ищется по своей строке: марка и госномер вместе, без пробелов и регистра.
        filterOption={(input, option) => {
          const needle = squash(input);
          return !needle || (option?.search ?? '').includes(needle);
        }}
        onChange={(id: string) => {
          const t = trailers.find((x) => x.id === id);
          // «Вписано в графы» выбирать не за чем: это и есть то, что в графах стоит.
          if (!t) return;
          form.setFieldsValue({ [modelField]: t.model, [regField]: t.registrationNumber });
        }}
        loading={isFetching}
        style={{ width: '100%' }}
        placeholder="Выберите прицеп из реестра"
        // Пустой список и несостоявшийся запрос — разные ответы: «ничего не нашлось» на месте
        // второго читалось бы как пустой реестр, и человек снял бы галочку вместо повтора.
        notFoundContent={
          isError
            ? 'Не удалось загрузить реестр прицепов'
            : isFetching
              ? 'Загружаем реестр…'
              : 'Ничего не нашлось'
        }
      />
    </Form.Item>
  );
}

/** Значение строки «вписано в графы»: идентификатором ему быть нечем — в реестре такой записи нет. */
const TYPED_VALUE = '__typed__';

/** Подпись группы для набранного руками — она же объясняет, почему строка стоит отдельно. */
const TYPED_GROUP_LABEL = 'Вписано в графы';

interface PickerOption {
  value: string;
  label: ReactNode;
  /** По чему ищут: марка и госномер одной строкой, приведённой к сравнимому виду. */
  search: string;
}

/**
 * Группа списка — сегодня она одна: строка, вписанная в графы руками. `search` объявлен и здесь,
 * потому что отбор списка получает элемент как есть: без общего поля обращение к нему в
 * `filterOption` пришлось бы прикрывать приведением типа, то есть обещанием, которого никто не
 * проверяет.
 */
interface PickerGroup {
  label: string;
  options: PickerOption[];
  search?: undefined;
}

type PickerEntry = PickerOption | PickerGroup;

/** Госномер и марка под сравнение: регистр и пробелы в графе бланка ничего не значат. */
function squash(v: string | null | undefined): string {
  return (v ?? '').toLowerCase().replace(/\s+/g, '');
}

/**
 * Строка списка: та же подпись, какой прицеп зовут в реестре и в подписи под графами
 * (`trailerTitle`), плюс состояние, если оно не рабочее.
 *
 * Прицеп в обслуживании предлагается **с пометкой** (§4.2.3): он закреплён и выезжает законно, но
 * планируют такой выезд осознанно. Рабочее состояние молчит — гори метка у каждой строки, среди
 * них не заметить ту одну, что в ремонте.
 */
function rowOf(t: VehicleTrailerDto): ReactNode {
  return (
    <Space size={8} wrap>
      <span>{trailerTitle(t)}</span>
      {t.status !== 'active' && (
        <Tag color={vehicleStatusColors[t.status]} style={{ marginInlineEnd: 0 }}>
          {vehicleStatusLabels[t.status]}
        </Tag>
      )}
    </Space>
  );
}
