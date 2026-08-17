import { Alert, App, Form, Input, Radio, Typography } from 'antd';
import dayjs from 'dayjs';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  readingInputSchema,
  type DriverPreviousReading,
  type DriverReportDto,
  type ReadingInput,
  type ReadingKind,
  type ReportItemDto,
} from '@technic/contracts';
import {
  parseReadingNumber,
  previousHintText,
  readingWarnings,
  vehicleReadingKeys,
  vehicleReadingsApi,
  type ReadingField,
} from '@entities/vehicle-reading';
import { isApiError } from '@shared/api';
import { errorMessage } from '@shared/lib';
import { FormModal } from '@shared/ui';

/**
 * Внесение показания за работника (ADR 0103; план «Показания техники», §7, Р26).
 *
 * Форма нужна с первого дня и по прозаической причине: у части водителей учётки не будет ещё
 * долго, а показания их машин гаражу нужны тогда же, когда и остальные. Второй случай — правка:
 * водитель списал цифру с ошибкой, и её меняет диспетчер.
 *
 * Три правила, и все три — не оформление.
 *
 * 1. **Причина обязательна там, где правят уже существующее число.** Требует её сервис
 *    (`Правка сданного показания требует причины`), и причина уезжает в историю показания, а не в
 *    аудит. Портал спрашивает её у всякой закрытой строки, а не только у изменившихся полей:
 *    отказ после набора хуже поля, которое видно заранее, а «правка, ничего не изменившая» и без
 *    того ничего не записывает.
 * 2. **Предупреждения показываются при вводе, а не приходят отказом.** Грубое — значение вне
 *    абсолютных границ — отправку не пускает: это опечатка в разряде, и подтверждать её
 *    бессмысленно. Мягкое — невероятный прирост — **не держит ничего**: странное число бывает
 *    правдой, а аномалию всё равно запишет сервер, и день без её подтверждения не примут.
 * 3. **Вид «нет возможности снять показания» ставит персонал, и только он** (план кабинета, Р4).
 *    Это закрытие строки с причиной, которую знает человек, а не пропуск: у водителя такого поля
 *    нет вовсе, и сервер его отправку с этим видом отклоняет.
 *
 * Подтверждения аномалии в теле нет намеренно (`confirm*Anomaly` уходят умолчанием `false`):
 * подтверждение приходит следующей волной и снятой подписи не снимает — сервер применяет его
 * только там, где подписи ещё нет.
 */

/** Числа показания — обратно в строку поля. Пусто — счётчика нет, а не ноль. */
const show = (value: number | null | undefined): string => (value == null ? '' : String(value));

/**
 * Предыдущий снимок счётчиков — тот, **с которым сравнивал сервер**.
 *
 * В кабинете он приходит в задании (`DriverAssignmentEntry.previous`) и есть всегда; в отчёте дня
 * его нет — `ReportItemDto` предшественника не несёт. Известен он ровно там, где сервер уже нашёл
 * аномалию: тогда в ответе лежит и значение, и его дата. Этого хватает на подсказку под полем и на
 * предупреждение о приросте там, где прирост уже вызвал вопросы.
 *
 * Где сравнения не было, остаются абсолютные границы — и это не потеря: суточный порог сервер
 * применит сам при записи, а портальные пороги предупреждают, а не решают (см. `readingLimits`).
 */
function previousOf(item: ReportItemDto, reportDate: string): DriverPreviousReading | null {
  const odometer = item.reading?.odometerAnomaly ?? null;
  const engineHours = item.reading?.engineHoursAnomaly ?? null;
  const measuredOn = odometer?.previousDate ?? engineHours?.previousDate ?? null;
  if (!measuredOn) return null;
  return {
    odometerKm: odometer?.previousValue ?? null,
    engineHours: engineHours?.previousValue ?? null,
    measuredOn,
    // Расстояние до предшественника масштабирует порог. Отрицательным оно не бывает: снимок
    // прошлого дня не может оказаться позже своего.
    daysAgo: Math.max(0, dayjs(reportDate).diff(dayjs(measuredOn), 'day')),
  };
}

/**
 * Запятая нормализуется в точку прямо на вводе: десятичный разделитель зависит от раскладки, и
 * отказывать за него нельзя. Целое поле отбрасывает дробную часть, а не склеивает её с целой:
 * «145 320,7» без разделителя стало бы «1453207» — молча выросшим в десять раз пробегом.
 */
function normalizeDecimal(raw: string, integer: boolean): string {
  const cleaned = raw.replace(/\s/gu, '').replace(',', '.');
  if (!integer) return cleaned.replace(/[^\d.]/gu, '');
  return cleaned.split('.')[0]!.replace(/\D/gu, '');
}

interface Values {
  kind: ReadingKind;
  odometerKm?: string;
  engineHours?: string;
  fuelFilledLiters?: string;
  noDataReason?: string;
  comment?: string;
  reason?: string;
}

export function IntakeReadingForm({
  report,
  item,
  onClose,
}: {
  /** Отчёт целиком: из него берутся адрес отправки (работник и день) и версия шапки. */
  report: DriverReportDto;
  item: ReportItemDto;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<Values>();

  const reading = item.reading;
  /** Строка уже закрыта — значит правят чужое число, и причина обязательна. */
  const editing = reading !== null;
  const previous = previousOf(item, report.reportDate);

  const kind = Form.useWatch('kind', form) ?? reading?.kind ?? 'values';
  const odometerKm = Form.useWatch('odometerKm', form);
  const engineHours = Form.useWatch('engineHours', form);
  const fuelFilledLiters = Form.useWatch('fuelFilledLiters', form);

  /*
   * Предупреждения считаются на каждом наборе символа и той же чистой проверкой, которой правило
   * не пускает отправку: одно правило на показ и на запрет. Мягкие собираются здесь и только
   * показываются — блокирует лишь грубое, и делает это правило поля.
   */
  const soft =
    kind === 'values'
      ? readingWarnings(
          {
            odometerKm: parseReadingNumber(odometerKm ?? ''),
            engineHours: parseReadingNumber(engineHours ?? ''),
            fuelFilledLiters: parseReadingNumber(fuelFilledLiters ?? ''),
          },
          previous,
        ).filter((w) => !w.hard)
      : [];

  /** Грубая ошибка живёт правилом поля: antd сам не даст отправить и сам подпишет поле. */
  const hardRule = (field: ReadingField) => ({
    validator: (_rule: unknown, raw: string | undefined) => {
      const value = parseReadingNumber(raw ?? '');
      if (value === 'invalid') return Promise.reject(new Error('Введите число'));
      const hard = readingWarnings({ [field]: value }, previous).find((w) => w.hard);
      return hard ? Promise.reject(new Error(hard.text)) : Promise.resolve();
    },
  });

  const save = useMutation({
    mutationFn: ({ reading: input, reason }: { reading: ReadingInput; reason: string }) =>
      vehicleReadingsApi.submitDay(report.personId, report.reportDate, {
        // Версия шапки, которую видел вносящий: оптимистическая блокировка отчёта.
        version: report.version,
        reason,
        items: [{ itemId: item.id, reading: input }],
      }),
    onSuccess: () => {
      message.success('Показание внесено');
      /*
       * Гасится корень слайса (Р19): те же числа показывают реестр, сводка парка, карточка машины
       * и журнал. Оставь их на своих ключах — и статистика, открытая рядом, показывала бы
       * вчерашнее до перезагрузки страницы.
       */
      void qc.invalidateQueries({ queryKey: vehicleReadingKeys.root });
      onClose();
    },
    onError: (e) => {
      // 409 — отчёт правили, пока форма была открыта. Повторять своё не по чему: та же версия
      // даст тот же отказ, — поэтому карточка перечитывается, а форма закрывается.
      if (isApiError(e) && e.status === 409) {
        message.error(
          'Отчёт изменили в другом окне — карточка перечитана, откройте строку заново и повторите',
        );
        void qc.invalidateQueries({ queryKey: vehicleReadingKeys.root });
        onClose();
        return;
      }
      message.error(errorMessage(e));
    },
  });

  /** Что уходит на сервер: разбирает контракт, а не форма — вторых правил у показания нет. */
  const submit = (v: Values) => {
    const numberOf = (raw: string | undefined) => {
      const value = parseReadingNumber(raw ?? '');
      // 'invalid' сюда не доходит: его отвергло правило поля. Оговорка нужна типу, а не логике.
      return value === 'invalid' ? null : value;
    };
    const parsed = readingInputSchema.safeParse(
      v.kind === 'no_data'
        ? { kind: 'no_data', noDataReason: v.noDataReason ?? '', comment: v.comment ?? '' }
        : {
            kind: 'values',
            odometerKm: numberOf(v.odometerKm),
            engineHours: numberOf(v.engineHours),
            fuelFilledLiters: numberOf(v.fuelFilledLiters),
            comment: v.comment ?? '',
          },
    );
    if (!parsed.success) {
      // Отказ схемы называет поле и встаёт под ним: «заполните хотя бы одно значение» относится
      // к трём полям сразу и приходит с путём первого из них.
      form.setFields(
        parsed.error.issues.map((issue) => ({
          // Имена полей формы и полей схемы совпадают намеренно: отказ обязан встать под тем
          // полем, о котором он говорит, а сопоставление «путь схемы → поле» — это второй словарь.
          name: (issue.path[0] ?? 'comment') as keyof Values,
          errors: [issue.message],
        })),
      );
      return;
    }
    save.mutate({ reading: parsed.data, reason: v.reason?.trim() ?? '' });
  };

  return (
    <FormModal
      title={`Показания — ${item.sourceLabel}`}
      open
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={save.isPending}
      width={520}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          kind: reading?.kind ?? 'values',
          odometerKm: show(reading?.odometerKm),
          engineHours: show(reading?.engineHours),
          fuelFilledLiters: show(reading?.fuelFilledLiters),
          noDataReason: reading?.noDataReason ?? '',
          comment: reading?.comment ?? '',
          reason: '',
        }}
        onFinish={submit}
      >
        <Typography.Text type="secondary">
          {`${item.vehicleLabel} · смена ${item.shiftOrder} · ${report.personName}`}
        </Typography.Text>

        <Form.Item name="kind" style={{ marginTop: 12 }}>
          <Radio.Group
            options={[
              { value: 'values', label: 'Показания' },
              // Закрытие строки с причиной — право персонала (Р4): у водителя такого поля нет.
              { value: 'no_data', label: 'Нет возможности снять' },
            ]}
            optionType="button"
          />
        </Form.Item>

        {kind === 'values' ? (
          <>
            <Form.Item
              name="odometerKm"
              label="Одометр на конец смены, км"
              rules={[hardRule('odometerKm')]}
              extra={previousHintText(previous, 'odometerKm')}
              getValueFromEvent={(e) => normalizeDecimal(e.target.value, true)}
            >
              <Input inputMode="decimal" suffix="км" />
            </Form.Item>
            <Form.Item
              name="engineHours"
              label="Моточасы на конец смены"
              rules={[hardRule('engineHours')]}
              extra={previousHintText(previous, 'engineHours')}
              getValueFromEvent={(e) => normalizeDecimal(e.target.value, false)}
            >
              <Input inputMode="decimal" suffix="ч" />
            </Form.Item>
            {/* Заправлено ЗА СМЕНУ, а не остаток в баке: остатков портал не хранит и расхода не
                считает (ADR 0103, решение 12) — подпись обязана называть то, что спрашивают. */}
            <Form.Item
              name="fuelFilledLiters"
              label="Заправлено за смену, л"
              rules={[hardRule('fuelFilledLiters')]}
              getValueFromEvent={(e) => normalizeDecimal(e.target.value, false)}
            >
              <Input inputMode="decimal" suffix="л" />
            </Form.Item>
          </>
        ) : (
          <Form.Item
            name="noDataReason"
            label="Почему показаний нет"
            rules={[{ required: true, message: 'Укажите причину' }]}
            extra="Счётчик неисправен, машину увёл сменщик, кабина опечатана — то, что знает человек"
          >
            <Input.TextArea rows={2} maxLength={500} />
          </Form.Item>
        )}

        {/* Мягкое предупреждение — вопрос, а не отказ: странное число бывает правдой (счётчик
            заменили, машина неделю стояла в поле). Отправку оно не держит, а аномалию всё равно
            запишет сервер — и день без её подтверждения не примут. */}
        {soft.length > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message="Проверьте показание"
            description={
              <>
                {soft.map((w) => (
                  <div key={w.text}>{w.text}</div>
                ))}
                <div>
                  Внести можно и так — аномалию сервер отметит сам, а день без её подтверждения не
                  примут.
                </div>
              </>
            }
          />
        )}

        <Form.Item name="comment" label="Комментарий">
          <Input.TextArea rows={2} maxLength={500} />
        </Form.Item>

        {/* Причина правки — только там, где правят уже закрытую строку: у первого ввода объяснять
            нечего, и пустое обязательное поле просило бы назвать причину того, что делают впервые. */}
        {editing && (
          <Form.Item
            name="reason"
            label="Причина правки"
            rules={[{ required: true, message: 'Чужое число меняют с объяснением' }]}
            extra="Уедет в историю показания: по ней потом отвечают, откуда взялась цифра"
          >
            <Input maxLength={500} placeholder="Водитель списал с прицепа, сверено по фото" />
          </Form.Item>
        )}
      </Form>
    </FormModal>
  );
}
