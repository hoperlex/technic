import { useEffect, useState } from 'react';
import { Alert, App, Button, Form, Input, Skeleton, Space, Typography } from 'antd';
import type { Dayjs } from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type KnownFill,
  type MachinistAnchor,
  type RepairPreviewDto,
  type RepairResultDto,
  type SpecialEquipmentRequestDto,
  type TailResolution,
} from '@technic/contracts';
import { FormModal } from '@shared/ui';
import { isApiError } from '@shared/api';
import { garageKeys } from '@entities/garage';
import { vehicleRequestKeys, waybillKeys } from '@entities/vehicle-request';
import { driversApi, vehicleRequestsApi } from '../../api/resources';
import { errorMessage } from '../../utils/format';
import { assignmentSegments } from './assignmentTimeline';
import { MachinistAnchorFields } from './MachinistFields';
import { MachinistChangePreview, MachinistForbiddenAlert } from './MachinistChangePreview';
import { KnownFillFields, KnownFillsMade, TailResolutionField } from './RepairFields';
import { fillFitsGap, repairBody, repairHasWork, type RepairDraft } from './repairCommand';
import { ASSIGNMENT_PREVIEW_STALE } from './ReassignPreview';

/**
 * Окно «Починка истории» (подэтап 6a плана `docs/assignment-periods-plan.md`, Р29, Р31, Ц4).
 *
 * ЗАЧЕМ. Дверь ремонта работает с апреля, а в портале её не было вовсе: «Состав по датам» писал
 * «решают его ремонтом истории» — и отсылал к операции, которой в интерфейсе не существует.
 * Расхождение хвоста и заполнение неизвестных дней приходилось делать запросом мимо портала.
 *
 * ТРИ РАБОТЫ, ОДНА ДВЕРЬ. Пробелы машиниста на **изменяемых** днях правятся якорями; `unknown` на
 * **заблокированных** — заполнением (там бумагу уже не отменить, и назвать человека можно только
 * так); расхождение хвоста — решением о машине. Что чем чинится, знает сервер: это зависит от
 * отменяемости бумаги, и окно спрашивает его первым делом — осмотром.
 *
 * ОСМОТР ОТДЕЛЬНОЙ РУЧКОЙ. Предпросмотром «что чинить» не спросить: его тело нарочно одно с
 * боевым (§8), а пустое тело боевая команда обязана отвергать. Поэтому первый запрос окна — `GET
 * .../repair/state`: та же форма ответа, но без единой мутации.
 *
 * ЧТО ОКНО НЕ ДЕЛАЕТ САМО. Не подставляет ни человека, ни границы отрезка (ADR 0083): заполнение
 * утверждает факт о прошлом, за которым портал выпишет бланки строгой отчётности задним числом.
 * Не решает за сервер, нужна ли причина и хватает ли прав, — и то и другое приходит ответом.
 */

const MACHINISTS_KEY = ['drivers', 'machinists'] as const;

interface FormValues {
  tail?: TailResolution['kind'];
  /** Заполнения по ключу промежутка: человек и границы внутри него. */
  fills?: Record<string, { personId?: string; range?: [Dayjs, Dayjs] } | undefined>;
  /** Имена на границах, которые назвал предпросмотр (Р16): ключ — дата якоря. */
  anchors?: Record<string, string | undefined>;
  reason?: string;
}

interface Props {
  /** `null` — окно закрыто. Только заказ спецтехники: истории назначения у грузоперевозки нет. */
  request: SpecialEquipmentRequestDto | null;
  onCancel: () => void;
  /** Ремонт прошёл: версия сменилась, бумага могла быть переписана — списки за окном устарели. */
  onRepaired: (result: RepairResultDto) => void;
}

export function VehicleRepairModal({ request, onCancel, onRepaired }: Props) {
  const [form] = Form.useForm<FormValues>();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const open = !!request;
  const targetId = request?.id ?? null;

  const [version, setVersion] = useState(0);
  // Ключ операции — один на открытое окно, а не на нажатие (Р9): связь оборвалась, ответа нет,
  // человек жмёт ещё раз — и сервер возвращает прежний результат вместо второго сгоревшего номера.
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  /** Показанные последствия и набор, которым их посчитали: подтверждение отправляет именно его. */
  const [shown, setShown] = useState<{ draft: RepairDraft; dto: RepairPreviewDto } | null>(null);
  const [staleReason, setStaleReason] = useState<string | null>(null);
  /** Отказ по правам (Р32): его показывают текстом в окне, а не тостом в углу. */
  const [forbidden, setForbidden] = useState<string | null>(null);

  useEffect(() => {
    if (!request) return;
    setVersion(request.version);
    setOperationId(crypto.randomUUID());
    setShown(null);
    setStaleReason(null);
    setForbidden(null);
    form.resetFields();
    // Зависимость — идентификатор заявки: перерисовка той же заявки приходит новым объектом и
    // стёрла бы уже набранное.
  }, [targetId]);

  /** Осмотр: что чинить. Первый и единственный запрос, который окно делает само по себе. */
  const state = useQuery({
    queryKey: vehicleRequestKeys.repairState(targetId ?? ''),
    queryFn: () => vehicleRequestsApi.repairState(targetId!),
    enabled: open,
    retry: false,
  });

  const history = useQuery({
    queryKey: vehicleRequestKeys.history(targetId ?? ''),
    queryFn: () => vehicleRequestsApi.assignmentHistory(targetId!),
    enabled: open,
    retry: false,
  });

  const machinists = useQuery({
    queryKey: MACHINISTS_KEY,
    queryFn: () => driversApi.list({ pageSize: 200, sortBy: 'fullName', sortDir: 'asc' }),
    enabled: open,
  });
  const driverName = (personId: string) =>
    machinists.data?.items.find((d) => d.id === personId)?.fullName;

  const previewMut = useMutation({
    mutationFn: async (v: { draft: RepairDraft; stale: string | null }) => ({
      ...v,
      dto: await vehicleRequestsApi.repairPreview(targetId!, repairBody(v.draft, { version })),
    }),
    onSuccess: ({ draft, dto, stale }) => {
      setForbidden(null);
      setStaleReason(stale);
      setShown({ draft, dto });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const applyMut = useMutation({
    mutationFn: (v: { draft: RepairDraft; dto: RepairPreviewDto; reason: string }) =>
      vehicleRequestsApi.repairAssignmentHistory(
        targetId!,
        repairBody(v.draft, {
          version,
          previewFingerprint: v.dto.fingerprint,
          unlockFingerprint: v.dto.unlockFingerprint,
          operation: v.dto.operationRequirement ? { operationId, reason: v.reason.trim() } : null,
          // Архив снимается только там, где сервер сказал, что иначе ремонт не пройдёт (Р29).
          restore: v.dto.restoreRequired,
        }),
      ),
    onSuccess: (res) => {
      message.success(res.repeated ? 'Этот ремонт уже был проведён' : 'История заявки исправлена');
      setVersion(res.version);
      setShown(null);
      setStaleReason(null);
      setOperationId(crypto.randomUUID());
      form.resetFields();
      void qc.invalidateQueries({ queryKey: vehicleRequestKeys.repairState(targetId!) });
      void qc.invalidateQueries({ queryKey: vehicleRequestKeys.history(targetId!) });
      void qc.invalidateQueries({ queryKey: vehicleRequestKeys.root });
      // Ремонт переписывает бумагу: заполнение выписывает листы задним числом, отмена их гасит.
      void qc.invalidateQueries({ queryKey: waybillKeys.root });
      void qc.invalidateQueries({ queryKey: garageKeys.root });
      onRepaired(res);
    },
    onError: (e, v) => {
      /*
       * 409 — не ошибка, а вопрос: между просмотром и нажатием план изменился, не тронув заявку
       * вовсе (чужая команда, аннулированный лист, наступившая полночь). Ответ на него — не тост,
       * а пересчитанный перечень с объяснением, почему окно вернуло человека назад.
       */
      if (isApiError(e) && e.code === ASSIGNMENT_PREVIEW_STALE) {
        previewMut.mutate({
          draft: v.draft,
          stale:
            'Последствия изменились с того момента, как вы их смотрели, — вот что произойдёт теперь. Прочитайте и подтвердите заново.',
        });
        return;
      }
      // Коррекционные права спрашивает сервер и по посчитанному исходу (Р32) — из тела это не
      // видно, поэтому отказ приходит уже после просмотра и показывается текстом в окне.
      if (isApiError(e) && e.status === 403) {
        setForbidden(e.message);
        return;
      }
      message.error(errorMessage(e));
    },
  });

  /*
   * Занятость — только про команды человека. Фоновое обновление осмотра сюда не входит нарочно:
   * оно случается и после чужой правки, и по возврату на вкладку, — а кнопка, крутящаяся от
   * невидимого запроса, читается как «портал думает», хотя нажимать можно.
   */
  const busy = previewMut.isPending || applyMut.isPending;
  const seen = state.data ?? null;
  const dto = shown?.dto ?? null;
  const secondStep = !!dto;
  const asking = dto ? dto.requiredAnchors : (seen?.requiredAnchors ?? []);

  /** Сделанные заполнения: их снимает та же дверь, но другой командой (Ю2). */
  const madeFills =
    request && history.data
      ? assignmentSegments(history.data.changes, {
          dateFrom: request.dateFrom,
          dateTo: request.dateTo,
        })
          .flatMap((segment) => {
            const row = segment.starts.find((s) => s.origin === 'known_fill');
            return row ? [{ changeGroupId: row.changeGroupId, segment }] : [];
          })
          .filter(({ changeGroupId }) =>
            history.data!.changes.some(
              (c) => c.changeGroupId === changeGroupId && c.supersededKind === null,
            ),
          )
      : [];

  const askPreview = (draft: RepairDraft) => {
    setForbidden(null);
    previewMut.mutate({ draft, stale: null });
  };

  /** Что человек набрал: отрезки заполнения, имена на границах и решение о хвосте. */
  const draftOf = (v: FormValues): RepairDraft => {
    const fills: KnownFill[] = [];
    for (const gap of seen?.fillableGaps ?? []) {
      const entry = v.fills?.[gap.from];
      if (!entry?.personId) continue;
      const from = entry.range?.[0]?.format('YYYY-MM-DD') ?? gap.from;
      const to = entry.range?.[1]?.format('YYYY-MM-DD') ?? gap.to;
      if (!fillFitsGap({ from, to }, gap)) continue;
      fills.push({ from, to, personId: entry.personId });
    }
    const anchors: MachinistAnchor[] = asking.flatMap((gap) => {
      const personId = v.anchors?.[gap.effectiveDate];
      return personId ? [{ effectiveDate: gap.effectiveDate, driverPersonId: personId }] : [];
    });
    const tail = v.tail ? ({ kind: v.tail } as TailResolution) : null;
    return { kind: 'repair', anchors, fills, tail };
  };

  const onSubmit = () => {
    if (dto && shown) {
      void form
        .validateFields(dto.operationRequirement ? ['reason'] : [])
        .then((v) => applyMut.mutate({ draft: shown.draft, dto, reason: v.reason ?? '' }))
        .catch(() => undefined);
      return;
    }
    const draft = draftOf(form.getFieldsValue());
    if (!repairHasWork(draft)) {
      message.warning('Назовите, что чинить: человека на неизвестных днях или машину после срока');
      return;
    }
    askPreview(draft);
  };

  return (
    <FormModal
      title={request ? `Починка истории: заявка ${request.displayNumber}` : 'Починка истории'}
      open={open}
      onCancel={onCancel}
      onSubmit={onSubmit}
      confirmLoading={busy}
      okText={secondStep ? 'Подтвердить' : 'Показать последствия'}
      footerExtra={secondStep ? <Button onClick={() => setShown(null)}>Назад</Button> : undefined}
      width={860}
    >
      <Form form={form} layout="vertical">
        <Space direction="vertical" size={12} style={{ display: 'flex' }}>
          {forbidden && <MachinistForbiddenAlert message={forbidden} />}

          {state.isPending && <Skeleton active paragraph={{ rows: 3 }} />}

          {state.isError && (
            <Alert
              type="error"
              showIcon
              message="Осмотреть историю не удалось"
              description={errorMessage(state.error)}
            />
          )}

          {/* Второй шаг — про цену действия: перечни, которые человек уже прочитал, там не
            повторяются, иначе подтверждение читается по диагонали. */}
          {!secondStep && seen && (
            <>
              {seen.archived && (
                <Alert
                  type="warning"
                  showIcon
                  message="Заявка в архиве"
                  description={
                    seen.restoreRequired
                      ? 'Бумага по ней осталась действующей, поэтому ремонт пройдёт только вместе с выводом заявки из архива — это произойдёт той же операцией.'
                      : 'Ремонт правит историю и архива не снимает: бумаги, которую он затронул бы, у заявки нет.'
                  }
                />
              )}
              {seen.requiredVehicleResolution && (
                <TailResolutionField tail={seen.requiredVehicleResolution} />
              )}
              <KnownFillFields
                gaps={seen.fillableGaps}
                machinists={machinists.data?.items ?? []}
                loading={machinists.isFetching}
              />
              <KnownFillsMade
                fills={madeFills}
                driverName={driverName}
                disabled={busy}
                onCancel={(changeGroupId) => askPreview({ kind: 'cancel_fill', changeGroupId })}
              />
              {asking.length > 0 && (
                <MachinistAnchorFields
                  anchors={asking}
                  machinists={machinists.data?.items ?? []}
                  loading={machinists.isFetching}
                />
              )}
              {seen.fillableGaps.length === 0 &&
                asking.length === 0 &&
                !seen.requiredVehicleResolution &&
                madeFills.length === 0 && (
                  <Typography.Text type="secondary">
                    История заявки полна: чинить в ней нечего.
                  </Typography.Text>
                )}
            </>
          )}

          {dto && shown && (
            <MachinistChangePreview
              preview={dto}
              cancelling={null}
              driverName={driverName}
              staleReason={staleReason}
            />
          )}

          {/* Причина спрашивается по `operationRequirement`, а не по календарю (Р32). */}
          {dto?.operationRequirement && (
            <Form.Item
              name="reason"
              label="Причина"
              style={{ marginBottom: 0 }}
              extra="Ремонт задевает уже отработанные дни: он пойдёт записью в журнал коррекций, и без объяснения её там быть не может."
              rules={[{ required: true, message: 'Укажите причину' }]}
            >
              <Input.TextArea
                rows={2}
                maxLength={2000}
                showCount
                placeholder="Например: нашли табель за январь — работал Иванов"
              />
            </Form.Item>
          )}
        </Space>
      </Form>
    </FormModal>
  );
}
