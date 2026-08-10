import { useState, type ReactNode } from 'react';
import { App, Form, Select, Tag, Typography } from 'antd';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import {
  formatWeeklyRequestNumber,
  moscowDateKeyOf,
  selectableWeeks,
  type WeeklyItemCounts,
  type WeeklyItemWarning,
  type WeeklyPreviousWeekDto,
  type WeeklyRequestItemDto,
  type WeeklyRequestStatus,
  weeklyRequestStatusColors,
  weeklyRequestStatusLabels,
  weeklyWeekLabel,
} from '@technic/contracts';
import { weeklyRequestsApi } from '../../api/resources';
import { FormModal } from '@shared/ui';
import { isApiError } from '@shared/api';
import { errorMessage } from '../../utils/format';
import { useObjectScope } from '../../hooks/useObjectScope';
import { useObjectOptions } from './shared';

/**
 * Общее недельной заявки на портале: адрес страницы, подписи состава, разбор отказов и вход
 * «Заявка на неделю». Входов у сборки два — вкладка «Недельные заявки» и вкладка «На объекте»
 * (§5 шаг 1), — и разъедься они по двум файлам, разошлись бы и поведением: в одном месте открывали
 * бы существующий черновик, в другом получали бы отказ `UNIQUE (object_id, week_start)`.
 *
 * Понятие недели берётся только из контрактов (`selectableWeeks`, `weeklyWeekLabel`): второй
 * реализации на клиенте быть не должно — иначе портал обещал бы не те листы, которые появятся.
 */

/** Ключ запросов раздела: им же перерисовывается список после действий на странице. */
export const WEEKLY_QUERY_KEY = ['weekly-vehicle-requests'] as const;

/** Адрес страницы сборки и карточки — отдельной, а не модального окна (§5 шаг 1). */
export const weeklyRequestPath = (id: string): string => `/vehicle-requests/weekly/${id}`;

/**
 * Сегодня по Москве. Считается тем же выражением, что и на сервере (`moscowDateKeyOf`): у
 * диспетчера из другого региона своя граница суток, и «эта неделя» у него разошлась бы с ответом
 * API — ровно в тот момент, когда просроченный черновик решают, можно ли ещё подать.
 */
export const weeklyToday = (): string => moscowDateKeyOf(new Date());

/** Недели, на которые заводят заявку, — подписанные по-человечески («10–16 августа 2026»). */
export function weekSelectOptions(today = weeklyToday()) {
  return selectableWeeks(today).map((week) => ({ value: week, label: weeklyWeekLabel(week) }));
}

/** Русское склонение счётного слова: 1 продление, 2 продления, 5 продлений. */
function plural(n: number, one: string, few: string, many: string): string {
  const tail = n % 100;
  const last = n % 10;
  if (tail >= 11 && tail <= 14) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

/**
 * Итог состава словами: «8 единиц: 5 продлений, 2 новых, 1 уезжает» (§5 шаг 3). Пустые виды строк
 * не перечисляются: «0 новых» отвечает на вопрос, которого никто не задавал, и удлиняет строку,
 * которую читают одним взглядом.
 */
export function weeklyCountsText(counts: WeeklyItemCounts): string {
  const total = counts.extend + counts.new + counts.leave;
  if (total === 0) return 'Состав пуст';
  const parts: string[] = [];
  if (counts.extend > 0) {
    parts.push(`${counts.extend} ${plural(counts.extend, 'продление', 'продления', 'продлений')}`);
  }
  if (counts.new > 0) {
    parts.push(`${counts.new} ${plural(counts.new, 'новая', 'новых', 'новых')}`);
  }
  if (counts.leave > 0) {
    parts.push(`${counts.leave} ${plural(counts.leave, 'уезжает', 'уезжают', 'уезжают')}`);
  }
  return `${total} ${plural(total, 'единица', 'единицы', 'единиц')}: ${parts.join(', ')}`;
}

/**
 * Отчёт по прошлой неделе одной строкой: «Из НЗ-15 (10–16 августа 2026): 6 позиций продлеваются,
 * 2 выбыли — ТС-341 — заказ закрыт фактом; ТС-352 — вывоз оформлен рейсом Р-12».
 *
 * Выбывшие перечисляются поимённо и с причиной, а не считаются числом: цифра «2 выбыли» заставит
 * штаб сверять состав с прошлой неделей глазами — а именно этого преемственность и должна была
 * избавить. Причины приходят с сервера теми же текстами, что и остальные отказы модуля.
 */
export function weeklyPreviousText(previous: WeeklyPreviousWeekDto): string {
  const from = `Из ${formatWeeklyRequestNumber(previous.num)} (${previous.weekLabel})`;
  const carried =
    previous.carried === 0
      ? 'ни одна позиция не продлевается'
      : `${previous.carried} ${plural(
          previous.carried,
          'позиция продлевается',
          'позиции продлеваются',
          'позиций продлеваются',
        )}`;
  if (previous.dropped.length === 0) return `${from}: ${carried}`;
  const dropped = previous.dropped.map((d) => `${d.displayNumber} — ${d.reason}`).join('; ');
  return (
    `${from}: ${carried}, ${previous.dropped.length} ` +
    `${plural(previous.dropped.length, 'выбыла', 'выбыли', 'выбыли')} — ${dropped}`
  );
}

export function WeeklyStatusTag({ status }: { status: WeeklyRequestStatus }) {
  return (
    <Tag color={weeklyRequestStatusColors[status]} style={{ marginInlineEnd: 0 }}>
      {weeklyRequestStatusLabels[status]}
    </Tag>
  );
}

/**
 * Предупреждения строки — готовым текстом из контрактов (`itemWarnings`): он один и в форме, и в
 * очереди визы, и в ответе API. Аренда показывается нейтральным серым, остальное — оранжевым:
 * «ЭСМ-2 ведёт арендодатель» не недоделка, а порядок вещей (Р19).
 */
export function ItemWarnings({ warnings }: { warnings: WeeklyItemWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <div style={{ lineHeight: 1.35 }}>
      {warnings.map((w) => (
        <div key={w.kind}>
          <Typography.Text
            type={w.kind === 'rental' ? 'secondary' : 'warning'}
            style={{ fontSize: 12 }}
          >
            {w.text}
          </Typography.Text>
        </div>
      ))}
    </div>
  );
}

/** Ответ сервера с этим кодом состояния — 409 конфликта версий, 404 исчезнувшей заявки. */
export function hasStatus(error: unknown, status: number): boolean {
  return isApiError(error) && error.status === status;
}

/**
 * Причины отказа по строкам из ответа 422 «не применилось ни по одной строке» (§9). Показывать их
 * общим всплывающим сообщением нельзя: править нужно конкретные строки, и человек должен видеть
 * какие, не сверяя список с таблицей глазами.
 *
 * Ключом сервер называет либо саму строку (её идентификатор), либо её место в присланном массиве
 * (`items.3` — путь, каким адресует поля zod). Разбираются оба: маршрут пишет другой поток, и
 * привязываться к одному написанию значило бы потерять причины молча.
 */
export function skipReasonsFromError(
  error: unknown,
  items: WeeklyRequestItemDto[],
): Map<string, string> {
  const reasons = new Map<string, string>();
  if (!isApiError(error) || !error.fields) return reasons;
  for (const [path, text] of Object.entries(error.fields)) {
    const byId = items.find((i) => i.id === path);
    if (byId) {
      reasons.set(byId.id, text);
      continue;
    }
    const index = /(?:^|\.)(\d+)(?:\.|$)/.exec(path)?.[1];
    const byIndex = index != null ? items[Number(index)] : undefined;
    if (byIndex) reasons.set(byIndex.id, text);
  }
  return reasons;
}

/**
 * Вход «Заявка на неделю» — общий для обеих кнопок. Заявка не заводится вслепую: сначала
 * спрашивается предложение состава, и, если черновик на эту пару «объект + неделя» уже есть,
 * портал открывает его (Р3). Второй заявки `UNIQUE` всё равно не даст, а отказ «уже есть» без
 * возможности открыть — тупик, из которого выходят через администратора.
 *
 * Состав при заведении не переносится: черновик заводится пустым, а предложение страница
 * пересчитывает сама — отмеченным приходит то, что действительно стоит на площадке сегодня.
 */
export function useWeeklyRequestCreate(): {
  open: () => void;
  /** Завести (или открыть) заявку на названную неделю без вопросов — «Создать на следующую неделю». */
  openWeek: (objectId: string, weekStart: string) => void;
  pending: boolean;
  node: ReactNode;
} {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [form] = Form.useForm<{ objectId: string; weekStart: string }>();
  const [open, setOpen] = useState(false);
  const { soleObjectId, objectFieldDisabled, limitObjectOptions } = useObjectScope();
  const { options: allObjectOptions, loading: objectsLoading } = useObjectOptions();
  const objectOptions = limitObjectOptions(allObjectOptions);
  const weeks = weekSelectOptions();

  const mut = useMutation({
    mutationFn: async (v: { objectId: string; weekStart: string }) => {
      const suggestion = await weeklyRequestsApi.suggestion(v);
      if (suggestion.existingRequestId) {
        return { id: suggestion.existingRequestId, existed: true };
      }
      try {
        const created = await weeklyRequestsApi.create({ ...v, items: [] });
        return { id: created.id, existed: false, num: created.num };
      } catch (e) {
        // Гонка двух сборщиков: пока спрашивали предложение, заявку завёл сосед. Отказ здесь
        // означает не ошибку, а «открывайте ту» — второй раз спрашиваем именно за этим.
        if (!hasStatus(e, 409)) throw e;
        const again = await weeklyRequestsApi.suggestion(v);
        if (!again.existingRequestId) throw e;
        return { id: again.existingRequestId, existed: true };
      }
    },
    onSuccess: (res) => {
      setOpen(false);
      if (res.existed) message.info('Заявка на эту неделю уже собирается — открываем её');
      else if (res.num) message.success(`Заведена заявка ${formatWeeklyRequestNumber(res.num)}`);
      void navigate(weeklyRequestPath(res.id));
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const node = (
    <FormModal
      title="Заявка на неделю"
      open={open}
      okText="Собрать состав"
      confirmLoading={mut.isPending}
      onCancel={() => setOpen(false)}
      onSubmit={() => form.submit()}
    >
      <Form form={form} layout="vertical" onFinish={(v) => mut.mutate(v)}>
        <Form.Item
          name="objectId"
          label="Объект"
          rules={[{ required: true, message: 'Выберите объект' }]}
        >
          <Select
            showSearch
            optionFilterProp="label"
            placeholder="Выберите объект"
            loading={objectsLoading}
            disabled={objectFieldDisabled}
            options={objectOptions}
          />
        </Form.Item>
        {/* Недели — только будущие: то, что нужно на этой неделе, заказывают обычной заявкой (Р2). */}
        <Form.Item
          name="weekStart"
          label="Неделя"
          tooltip="Заявку заводят на будущую неделю: продление задним числом означало бы согласовать уже отработанные дни"
          rules={[{ required: true, message: 'Выберите неделю' }]}
        >
          <Select options={weeks} placeholder="Выберите неделю" />
        </Form.Item>
      </Form>
    </FormModal>
  );

  return {
    open: () => {
      form.setFieldsValue({ objectId: soleObjectId ?? undefined, weekStart: weeks[0]?.value });
      setOpen(true);
    },
    openWeek: (objectId, weekStart) => mut.mutate({ objectId, weekStart }),
    pending: mut.isPending,
    node,
  };
}
