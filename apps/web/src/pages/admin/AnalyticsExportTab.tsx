import { useState } from 'react';
import { Alert, Button, Card, DatePicker, Select, Space, Typography } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import {
  ANALYTICS_STEPS,
  MAX_ANALYTICS_PERIOD_DAYS,
  MAX_ANALYTICS_STEPS,
  analyticsStepLabels,
  roleScopeAxis,
  roleScopeAxisLabels,
  type AnalyticsStep,
} from '@technic/contracts';
import { analyticsApi } from '@entities/analytics';
import { objectOptionsQuery } from '@entities/object';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage } from '../../utils/format';

/**
 * Сводная аналитика по заказчикам (`docs/analytics-summary-export-plan.md`): работа заказа
 * техники, вывоза мусора и механизации за крупный период в разрезе «объект / отдел».
 *
 * Панель реестра выгрузок, а не своя вкладка (Р1): вопрос «какую книгу выгрузить» один, и
 * отвечать на него двумя вкладками значило бы заводить третью на следующей книге.
 *
 * Состав книги подписан прямо здесь, до нажатия, — приёмом соседней панели показаний. Но здесь у
 * него есть и второе основание: книга сводит три модуля, и три её правила счёта заказчик обязан
 * прочесть **до** того, как поверит цифрам, а не после того, как сведёт их с бухгалтерией.
 */

const DATE = 'YYYY-MM-DD';
const SHOWN_DATE = 'DD.MM.YYYY';

/**
 * Месяц от начала времён: ось, на которой одинаково режутся месяц, квартал, полугодие и год.
 *
 * Кварталы и полугодия считаются ею, а не `startOf('quarter')`: плагина `quarterOfYear` в портале
 * нет, а заводить его ради двух делений незачем — `year * 12 + month` кратно 3, 6 и 12, поэтому
 * целочисленное деление и даёт границы, выровненные по календарному году.
 */
const monthIndex = (d: Dayjs): number => d.year() * 12 + d.month();

/** Понедельник, от которого отсчитываются ISO-недели: 05.01.1970 — первый понедельник эпохи. */
const EPOCH_MONDAY = dayjs('1970-01-05');
const weekIndex = (d: Dayjs): number => Math.floor(d.startOf('day').diff(EPOCH_MONDAY, 'day') / 7);

/** Сколько месяцев в шаге. Недели считаются иначе — они не кратны месяцу. */
const STEP_MONTHS: Record<Exclude<AnalyticsStep, 'week'>, number> = {
  month: 1,
  quarter: 3,
  half: 6,
  year: 12,
};

/**
 * Сколько отрезков шага накрывает период.
 *
 * Формула обязана совпадать с серверной (`analytics/periods.ts`): потолок шагов проверяют обе
 * стороны, и разойдись они — форма пустила бы запрос, который сервер отвергнет уже после сборки,
 * либо погасила бы кнопку там, где сервер книгу собрал бы. Поэтому считается не «сколько
 * поместится», а число границ между началом и концом: отрезок считается целиком, даже если период
 * задел его одним днём, — ровно так книга и режет динамику.
 */
function stepCount(from: Dayjs, to: Dayjs, step: AnalyticsStep): number {
  if (step === 'week') return weekIndex(to) - weekIndex(from) + 1;
  const months = STEP_MONTHS[step];
  return Math.floor(monthIndex(to) / months) - Math.floor(monthIndex(from) / months) + 1;
}

/** Умолчание — прошедший месяц целиком: свод за крупный период заказывают, когда месяц закрылся. */
function defaultPeriod(): [Dayjs, Dayjs] {
  const previous = dayjs().startOf('month').subtract(1, 'month');
  return [previous, previous.endOf('month')];
}

/**
 * Пресеты периода. Календарные, а не «последние 30 дней»: свод сравнивают с отчётностью, а она
 * живёт месяцами и кварталами — отрезок, начатый посреди месяца, не сравним ни с чем.
 *
 * Считаются при отрисовке, а не константой модуля: вкладка живёт открытой днями, и «текущий
 * месяц», замороженный при загрузке портала, к утру назвал бы прошлый.
 */
function periodPresets(): { label: string; value: [Dayjs, Dayjs] }[] {
  const month = dayjs().startOf('month');
  const previousMonth = month.subtract(1, 'month');
  const quarter = month.subtract(month.month() % 3, 'month');
  const previousQuarter = quarter.subtract(3, 'month');
  const half = month.subtract(month.month() % 6, 'month');
  const span = (start: Dayjs, months: number): [Dayjs, Dayjs] => [
    start,
    start.add(months - 1, 'month').endOf('month'),
  ];
  return [
    { label: 'Текущий месяц', value: span(month, 1) },
    { label: 'Прошлый месяц', value: span(previousMonth, 1) },
    { label: 'Текущий квартал', value: span(quarter, 3) },
    { label: 'Прошлый квартал', value: span(previousQuarter, 3) },
    { label: 'Полугодие', value: span(half, 6) },
    { label: 'Год', value: [month.startOf('year'), month.endOf('year')] },
  ];
}

/**
 * Семь листов книги и их состав (§3 плана) — одной строкой на лист.
 *
 * Имена — те самые, что стоят на корешках в книге (`services/analytics-export.ts`), а не названия
 * из плана: у Excel потолок 31 знак на имя листа, и при сборке «Качество данных» и «Параметры и
 * методика» сократились до «Качества» и «Параметров». Обещать здесь имя, которого в книге нет, —
 * значит отправить человека искать несуществующий корешок; поэтому полное название живёт в
 * описании рядом, а не в имени.
 */
const SHEETS: [string, string][] = [
  [
    'Свод',
    'строка на заказчика (объект или отдел): смены, единицы техники, ездки, объём и масса, вывозы и контейнерные операции, аренды механизации и пять денежных колонок; подытоги по объектам и отделам и строка «Всего».',
  ],
  [
    'Детализация',
    'те же числа по площадкам и по позициям внутри модуля — машина с гос. номером, вид отхода с типом контейнера, модель механизации; перегоны техники к своему заказу идут отдельным счётчиком. Уровни сворачиваются кнопкой слева.',
  ],
  [
    'Инфографика',
    'по одной выбранной площадке: таблица-источник по отрезкам шага и графики к ней — загрузка, структура вывоза, аренды и деньги. Площадка не выбрана — листа в книге нет.',
  ],
  [
    'Данные',
    'скрытый лист: плоские строки-источники, ровно те, из которых собраны остальные листы, — период, дата, заказчик, отдел-плательщик, модуль, позиция, номер заявки, статус и все числа.',
  ],
  [
    'Сводная',
    'готовая сводная таблица: заказчики по строкам, отрезки шага по колонкам, значения — деньги и смены. Разрезы по модулю, статусу, отделу-плательщику и позиции собираются мышью.',
  ],
  [
    'Качество',
    'чему в книге можно верить: смены без визы площадки, закрытия без фактической даты, вывозы без принятого талона, заявки без цены, аренды без итоговой суммы.',
  ],
  [
    'Параметры',
    'период, шаг, кто и когда выгрузил, счётчики строк — и определение каждой колонки: что считается, из какой таблицы, каким днём и что в неё не входит.',
  ],
];

/**
 * Оговорки, без которых цифрам верить нельзя. Стоят в форме, а не только на листе «Методика»:
 * лист читают после того, как книгу свели с бухгалтерией, а расхождение объясняют до.
 */
const CAVEATS: string[] = [
  'Смена перевозки — это пара «машина и день», в которой участвовала хотя бы одна заявка заказчика: один рейс везёт заявки нескольких площадок, и делить машино-смену между ними книга не берётся. Поэтому сумма по строкам больше числа машино-смен парка.',
  'Деньги идут вилкой: факт закрытий, нижняя оценка (цена × заполненные смены) и верхняя (цена × дни срока). Незакрытая заявка лежит между ними, и одного числа у неё нет; заявки, которые не удалось оценить ни фактом, ни расчётом, стоят счётчиком «без цены».',
  'Объём и масса не складываются никогда: мусор меряют кубометрами, лом принимают по весу, часы и смены механизации — разные единицы. Это разные колонки, а не одна с единицей в подписи.',
];

export function AnalyticsExportTab() {
  const { user } = useAuth();
  /*
   * Область у права всегда общая (Р3): свод, в котором часть площадок невидима, несравним сам с
   * собой между двумя людьми, поэтому держателю права с суженной осью ручка отвечает отказом, а не
   * усечённой книгой (`assertWholeOrganizationScope` в `routes/analytics.ts`).
   *
   * Сочетание редкое, но достижимое: полномочие выдали роли без оси, а потом роль учётки сменили
   * на площадочную — право осталось, ось появилась. Без этой проверки такой человек заполнял бы
   * период, шаг и площадку и узнавал об отказе только по нажатию.
   *
   * Спрашивается тот же предикат контрактов, которым спрашивает сервер, а не свой список ролей:
   * вторая классификация ролей по осям разошлась бы с первой молча и ровно в ту сторону, где
   * ошибка дороже — роль с осью попала бы в «оси нет».
   */
  const scopeAxis = roleScopeAxis(user?.role);
  const wholeOrganizationOnly = scopeAxis !== 'none';

  const [period, setPeriod] = useState<[Dayjs, Dayjs]>(defaultPeriod);
  const [step, setStep] = useState<AnalyticsStep>('month');
  const [chartObjectId, setChartObjectId] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  /*
   * Закрытые площадки в списке нужны: свод берут и за прошлый год, а площадка, закрытая с тех пор,
   * при умолчании `activeOnly: true` не пришла бы вовсе — инфографику нельзя было бы построить по
   * той самой стройке, ради которой книгу и заказали.
   */
  const { data: objectOptions = [], isFetching: objectsLoading } = useQuery({
    ...objectOptionsQuery({ activeOnly: false }),
    // Книги не будет — справочник и не спрашиваем: запрос за списком, из которого нечего выбрать.
    enabled: !wholeOrganizationOnly,
  });

  const [from, to] = period;
  const days = to.startOf('day').diff(from.startOf('day'), 'day') + 1;
  const steps = stepCount(from, to, step);
  /*
   * Оба потолка проверяются до запроса и теми же числами, что стоят на сервере: отказ, пришедший
   * после десяти секунд сборки, ничего не добавляет к тому, что видно в форме сразу.
   */
  const tooLong = days > MAX_ANALYTICS_PERIOD_DAYS;
  const tooManySteps = steps > MAX_ANALYTICS_STEPS;
  const blocked = tooLong || tooManySteps;

  const download = async () => {
    if (blocked) return;
    setBusy(true);
    setFailure(null);
    try {
      await analyticsApi.exportBook({
        from: from.format(DATE),
        to: to.format(DATE),
        step,
        // Площадка уходит, только когда выбрана: пустой параметр схема запроса отвергает, а не
        // пропускает молча, — и правильно, «инфографика ни по какой площадке» не вопрос.
        ...(chartObjectId ? { chartObjectId } : {}),
      });
    } catch (e: unknown) {
      // Отказ остаётся во вкладке, как у соседней книги: сервер отвечает «сузьте период», когда
      // атомов больше предела, — это указание, что делать дальше, и читают его там же, где
      // выбирают период.
      setFailure(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (wholeOrganizationOnly) {
    /*
     * Вместо формы — объяснение, а не погашенная кнопка под заполненными полями: поля, которые всё
     * равно ни к чему не приведут, сами по себе обещание. Слова те же, что в отказе сервера, и ось
     * названа теми же подписями контрактов — иначе портал и сервер объясняли бы одно и то же
     * по-разному, и человек решал бы, какому из двух объяснений верить.
     */
    return (
      <div style={{ padding: 16, maxWidth: 760 }}>
        <Alert
          type="info"
          showIcon
          title="Выгрузка бывает только по всей организации"
          description={`Свод сводит все площадки и отделы компании, а у вашей учётки область ограничена (${roleScopeAxisLabels[scopeAxis]}). Книги по своим объектам не бывает: свод, в котором часть площадок невидима, несравним сам с собой между двумя людьми, и сервер отвечает на такой запрос отказом, а не усечённой книгой. Нужна эта книга — право выдают учётке, область которой ничем не ограничена.`}
        />
      </div>
    );
  }

  return (
    <div style={{ padding: 16, maxWidth: 760 }}>
      <Space orientation="vertical" size="middle" style={{ display: 'flex' }}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Книга Excel по работе трёх модулей — заказа техники, вывоза мусора и механизации — за
          выбранный период. Строка книги — заказчик: объект строительства или отдел; в свод попадают
          только те, у кого в периоде есть хоть одна цифра.
        </Typography.Paragraph>

        <Space wrap align="end" size="middle">
          {/* Подписи стоят рядом с полями, а не оборачивают их: обёрнутая подпись вбирает в себя
              текст выбранного варианта, и имя поля перестаёт быть именем поля для всех, кто ищет
              его текстом, — от программы чтения с экрана до теста. */}
          <div>
            <label htmlFor="analytics-export-period" style={{ display: 'block', marginBottom: 4 }}>
              Период
            </label>
            <DatePicker.RangePicker
              id="analytics-export-period"
              value={period}
              format={SHOWN_DATE}
              allowClear={false}
              presets={periodPresets()}
              onChange={(value) => {
                if (value?.[0] && value[1]) setPeriod([value[0], value[1]]);
              }}
            />
          </div>
          <div>
            <label htmlFor="analytics-export-step" style={{ display: 'block', marginBottom: 4 }}>
              Шаг
            </label>
            <Select
              id="analytics-export-step"
              value={step}
              style={{ width: 160 }}
              onChange={setStep}
              options={ANALYTICS_STEPS.map((value) => ({
                value,
                label: analyticsStepLabels[value],
              }))}
            />
          </div>
          <Button
            type="primary"
            icon={<DownloadOutlined />}
            loading={busy}
            disabled={blocked}
            onClick={() => void download()}
          >
            Скачать книгу
          </Button>
        </Space>

        <div>
          <label htmlFor="analytics-export-object" style={{ display: 'block', marginBottom: 4 }}>
            Площадка для листа инфографики
          </label>
          <Select
            id="analytics-export-object"
            value={chartObjectId}
            onChange={setChartObjectId}
            options={objectOptions}
            loading={objectsLoading}
            showSearch
            allowClear
            optionFilterProp="label"
            placeholder="Не выбрана — листа инфографики не будет"
            style={{ width: '100%', maxWidth: 460 }}
          />
        </div>
        <Typography.Paragraph type="secondary" style={{ marginTop: -8, marginBottom: 0 }}>
          Инфографика строится по одной площадке; не выбрана — листа в книге нет. Графиков,
          сравнивающих площадки между собой, в книге нет вовсе: на вопрос «кто сколько отработал»
          отвечает свод, а график на два десятка объектов не читается.
        </Typography.Paragraph>

        {/* Число отрезков названо до нажатия: по нему видно, что даст лист инфографики, и почему
            кнопка погасла, когда их стало больше потолка. Двоеточием, а не согласованием слов:
            «52 отрезка» и «54 отрезка» склоняются по-разному, и считать это ради подсказки
            незачем. */}
        <Typography.Text type="secondary">
          Шаг режет только лист инфографики — на своде и детализации период один, целиком. Отрезков
          в периоде: {steps}.
        </Typography.Text>

        {tooLong && (
          <Alert
            type="warning"
            showIcon
            title="Период больше года"
            description={`Дней в периоде: ${days}, а книга собирается целиком в памяти сервера — возьмите отрезок не длиннее ${MAX_ANALYTICS_PERIOD_DAYS} дней.`}
          />
        )}

        {tooManySteps && (
          <Alert
            type="warning"
            showIcon
            title="Шагов больше, чем помещается в динамику"
            description={`Отрезков при таком шаге получается ${steps}, а лист инфографики вмещает ${MAX_ANALYTICS_STEPS}. Возьмите шаг крупнее или период короче.`}
          />
        )}

        {failure && <Alert type="error" showIcon title={failure} />}

        <Card size="small" title="Что внутри книги">
          <Space orientation="vertical" size={8} style={{ display: 'flex' }}>
            {SHEETS.map(([name, composition]) => (
              <div key={name}>
                <Typography.Text strong>{name}</Typography.Text>{' '}
                <Typography.Text type="secondary">— {composition}</Typography.Text>
              </div>
            ))}
          </Space>
        </Card>

        <Card size="small" title="Что надо знать до того, как поверить цифрам">
          <Space orientation="vertical" size={8} style={{ display: 'flex' }}>
            {CAVEATS.map((text) => (
              <Typography.Text key={text} type="secondary">
                {text}
              </Typography.Text>
            ))}
          </Space>
        </Card>

        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Отменённые и удалённые заявки не считаются нигде — ни количествами, ни деньгами. Прочерк
          «—» означает «значение неизвестно» и в суммы не входит. Данных о людях в книге нет: ни
          водителей, ни машинистов, ни ответственных на площадках — только площадки, техника,
          количества и деньги. Единственное имя в книге — ваше: лист «Параметры» подписывает, кто и
          когда её выгрузил.
        </Typography.Paragraph>
      </Space>
    </div>
  );
}
