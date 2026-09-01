import { useEffect, useState } from 'react';
import { Alert, App, Button, Form, Input, Space } from 'antd';
import type { Dayjs } from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  moscowDateKeyOf,
  type AssignmentPreviewDto,
  type MachinistAnchor,
  type SpecialEquipmentRequestDto,
} from '@technic/contracts';
import { FormModal } from '@shared/ui';
import { isApiError } from '@shared/api';
import { garageKeys } from '@entities/garage';
import { vehicleRequestKeys, waybillKeys } from '@entities/vehicle-request';
import {
  driversApi,
  vehicleRequestsApi,
  type AssignmentCommandResultDto,
} from '../../api/resources';
import { errorMessage } from '../../utils/format';
import { AssignmentHistoryPanel } from './AssignmentHistoryPanel';
import { MachinistAnchorFields, MachinistPickFields } from './MachinistFields';
import {
  assignmentVehicle,
  cancelTargetOf,
  esm2Report,
  hasRequiredAnchors,
  machinistCommandBody,
  type MachinistCommandDraft,
} from './machinistCommand';
import {
  MachinistChangePreview,
  MachinistForbiddenAlert,
  machinistPreviewIsSilent,
} from './MachinistChangePreview';
// Код отказа берётся у соседней двери, а не объявляется второй раз: рукопожатие у модуля одно
// (§8), и два своих написания одной строки разошлись бы молча (волна 4a).
import { ASSIGNMENT_PREVIEW_STALE } from './ReassignPreview';

/**
 * Окно «Сменить машиниста» (этап 6 плана `docs/assignment-periods-plan.md`, §9).
 *
 * ЗАЧЕМ. Сервер меняет человека внутри срока заявки с апреля, а в портале такой двери не было:
 * машиниста меняли, переписывая назначение целиком, — то есть вместе с машиной, ставками и рейсом.
 * Здесь спрашивают одно: кто садится за технику и **с какого числа**.
 *
 * ДВЕ ФАЗЫ, А ИНОГДА ТРИ. Порядок тот же, что у смены техники: сперва последствия, потом
 * подтверждение. Третья фаза появляется, когда предпросмотр отвечает `requiredAnchors` (Р16): на
 * каких-то границах свёртка осталась бы без человека, и пока их не назвали, набор последствий ещё
 * неизвестен — подтверждать нечего, и окно спрашивает имена, а не показывает половину плана.
 *
 * ЕСЛИ ПОСЛЕДСТВИЙ НЕТ, ВТОРОГО ЭКРАНА НЕ ПОКАЗЫВАЮТ. Пустое «ничего не произойдёт, нажмите ещё
 * раз» приучает нажимать не читая, и тогда экран не срабатывает в тот единственный раз, когда
 * сказать ему есть что. Отпечаток при этом всё равно уезжает с командой.
 *
 * ЧТО ОКНО СЧИТАЕТ САМО. Ничего из решений: последствия, исход, права и рукопожатия приходят
 * предпросмотром и проверяются сервером под блокировкой. Портал складывает отрезки только чтобы
 * показать состав по датам — ни одна кнопка от этого расчёта не зависит.
 */

const MACHINISTS_KEY = ['drivers', 'machinists'] as const;

/** Аргумент предпросмотра: команда, уже названные имена и причина возврата к последствиям. */
interface PreviewArgs {
  draft: MachinistCommandDraft;
  anchors: MachinistAnchor[];
  /** `null` — человек пришёл сюда сам; текст — сервер ответил, что показанное устарело. */
  stale: string | null;
}

interface FormValues {
  driverPersonId?: string;
  effectiveDate?: Dayjs;
  /** Имена на границах, которые назвал предпросмотр (Р16): ключ — дата якоря. */
  anchors?: Record<string, string | undefined>;
  reason?: string;
}

interface Props {
  /** `null` — окно закрыто. Только заказ спецтехники: состава по датам у грузоперевозки нет. */
  request: SpecialEquipmentRequestDto | null;
  onCancel: () => void;
  /** Команда прошла: версия заявки сменилась, бумага переписана — списки за окном устарели. */
  onApplied: (result: AssignmentCommandResultDto) => void;
}

export function VehicleMachinistModal({ request, onCancel, onApplied }: Props) {
  const [form] = Form.useForm<FormValues>();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const open = !!request;
  const targetId = request?.id ?? null;

  // Версия — своим состоянием, а не пропом: окно остаётся открытым после команды, и вторая смена
  // подряд обязана идти уже с новой версией; проп к этому моменту ещё прежний.
  const [version, setVersion] = useState(0);
  // Ключ операции — один на открытое окно, а не на нажатие (Р9): связь оборвалась, ответа нет,
  // человек жмёт ещё раз — и сервер возвращает прежний результат вместо второго сгоревшего номера.
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  /** Показанные последствия и команда, которой их посчитали: подтверждение отправляет именно её. */
  const [shown, setShown] = useState<{
    draft: MachinistCommandDraft;
    dto: AssignmentPreviewDto;
  } | null>(null);
  /** Якоря, уже названные человеком: они уезжают и в предпросмотр, и в команду. */
  const [anchors, setAnchors] = useState<MachinistAnchor[]>([]);
  const [staleReason, setStaleReason] = useState<string | null>(null);
  /** Отказ по правам (Р32): его показывают текстом в окне, а не тостом в углу. */
  const [forbidden, setForbidden] = useState<string | null>(null);

  useEffect(() => {
    if (!request) return;
    setVersion(request.version);
    setOperationId(crypto.randomUUID());
    setShown(null);
    setAnchors([]);
    setStaleReason(null);
    setForbidden(null);
    form.resetFields();
    // Зависимость — идентификатор заявки: перерисовка той же заявки приходит новым объектом и
    // стёрла бы уже набранное.
  }, [targetId]);

  const history = useQuery({
    queryKey: vehicleRequestKeys.history(targetId ?? ''),
    queryFn: () => vehicleRequestsApi.assignmentHistory(targetId!),
    enabled: open,
    retry: false,
  });

  /**
   * Справочник водителей целиком — тот же список, что у поля машиниста в окне назначения: в бланке
   * ЭСМ-2 нет ни СНИЛС, ни удостоверения, и отбирать по ним некого (ADR 0055). Он же даёт имена
   * составу по датам: строка истории носит состояние, а не человека.
   */
  const machinists = useQuery({
    queryKey: MACHINISTS_KEY,
    queryFn: () => driversApi.list({ pageSize: 200, sortBy: 'fullName', sortDir: 'asc' }),
    enabled: open,
  });
  const driverName = (personId: string) =>
    machinists.data?.items.find((d) => d.id === personId)?.fullName;

  const previewMut = useMutation({
    mutationFn: async (v: PreviewArgs) => ({
      ...v,
      dto: await vehicleRequestsApi.assignmentChangePreview(
        targetId!,
        machinistCommandBody(v.draft, { version, anchors: v.anchors }),
      ),
    }),
    onSuccess: ({ draft, dto, anchors: named, stale }) => {
      setForbidden(null);
      setAnchors(named);
      /*
       * Говорить не о чем — команда уходит сразу, вместе с отпечатком. После 409 это правило
       * снимается: молча повторить команду, которую сервер только что не принял, значит сделать её
       * за спиной у человека, даже если пересчитанный план опустел.
       */
      if (!stale && machinistPreviewIsSilent(dto)) {
        applyMut.mutate({ draft, dto, anchors: named, reason: '' });
        return;
      }
      setStaleReason(stale);
      setShown({ draft, dto });
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const applyMut = useMutation({
    mutationFn: (v: {
      draft: MachinistCommandDraft;
      dto: AssignmentPreviewDto;
      anchors: MachinistAnchor[];
      reason: string;
    }) =>
      vehicleRequestsApi.changeAssignmentMachinist(
        targetId!,
        machinistCommandBody(v.draft, {
          version,
          anchors: v.anchors,
          previewFingerprint: v.dto.fingerprint,
          // Присутствие подтверждения задаёт **ответ сервера**, а не желание клиента: лишний
          // отпечаток отвергается так же строго, как недостающий.
          unlockFingerprint: v.dto.unlockFingerprint,
          operation: v.dto.operationRequirement ? { operationId, reason: v.reason.trim() } : null,
        }),
      ),
    onSuccess: (res) => {
      message.success(
        res.repeated ? 'Эта команда уже была проведена' : esm2Report(res) || 'Машинист изменён',
      );
      setVersion(res.version);
      setShown(null);
      setStaleReason(null);
      form.setFieldsValue({ driverPersonId: undefined, effectiveDate: undefined, reason: '' });
      setAnchors([]);
      // История возвращается в ответе, но берётся заново: между ответом и показом окна стоит тот же
      // кэш, которым пользуются соседние экраны, и держать в нём две редакции одной истории нельзя.
      void qc.invalidateQueries({ queryKey: vehicleRequestKeys.history(targetId!) });
      void qc.invalidateQueries({ queryKey: vehicleRequestKeys.root });
      // Смена машиниста переписывает бумагу: недельные листы уходят на другую фамилию.
      void qc.invalidateQueries({ queryKey: waybillKeys.root });
      void qc.invalidateQueries({ queryKey: garageKeys.root });
      onApplied(res);
    },
    onError: (e, v) => {
      /*
       * 409 — не ошибка, а вопрос: между просмотром и нажатием план изменился, не тронув заявку
       * вовсе (чужая команда заняла дату, лист аннулировали своей ручкой, наступила полночь), и
       * `version` ни одного из этих случаев не ловит. Ответ на него — не тост, а пересчитанный
       * перечень с объяснением, почему окно вернуло человека назад.
       */
      if (isApiError(e) && e.code === ASSIGNMENT_PREVIEW_STALE) {
        previewMut.mutate({
          draft: v.draft,
          anchors: v.anchors,
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
      // Сервер пересчитал пробелы: спрашиваем имена, а не показываем «anchors: Нужны якоря».
      if (isApiError(e) && hasRequiredAnchors(e.details)) {
        previewMut.mutate({ draft: v.draft, anchors: [], stale: null });
        return;
      }
      message.error(errorMessage(e));
    },
  });

  const busy = previewMut.isPending || applyMut.isPending;
  const dto = shown?.dto ?? null;
  const asking = dto ? dto.requiredAnchors : [];
  /** Второй шаг: дальше окно говорит не про подбор, а про цену действия либо про пробелы. */
  const secondStep = !!dto;

  /** Спросить последствия: тело собирается один раз и им же потом уедет команда. */
  const askPreview = (draft: MachinistCommandDraft, named: MachinistAnchor[]) => {
    setForbidden(null);
    previewMut.mutate({ draft, anchors: named, stale: null });
  };
  const submitForm = (v: FormValues) => {
    const date = v.effectiveDate?.format('YYYY-MM-DD');
    if (!date || !v.driverPersonId) return;
    askPreview({ kind: 'set', effectiveDate: date, driverPersonId: v.driverPersonId }, []);
  };

  /** Нажатие на основную кнопку: у трёх шагов оно означает три разных действия. */
  const onSubmit = () => {
    if (!dto || !shown) {
      void form.submit();
      return;
    }
    // Проверяются названные поля, а не форма целиком: у отмены решения поля подбора не
    // заполняются вовсе, и общий `validateFields` потребовал бы машиниста, которого у неё нет.
    if (asking.length > 0) {
      const names = asking.map((gap) => ['anchors', gap.effectiveDate]);
      void form
        .validateFields(names)
        .then((v) =>
          askPreview(
            shown.draft,
            asking.map((gap) => ({
              effectiveDate: gap.effectiveDate,
              driverPersonId: v.anchors![gap.effectiveDate]!,
            })),
          ),
        )
        .catch(() => undefined);
      return;
    }
    void form
      .validateFields(dto.operationRequirement ? ['reason'] : [])
      .then((v) => applyMut.mutate({ draft: shown.draft, dto, anchors, reason: v.reason ?? '' }))
      .catch(() => undefined);
  };

  const term = request ? { dateFrom: request.dateFrom, dateTo: request.dateTo } : null;
  const today = moscowDateKeyOf(new Date());

  return (
    <FormModal
      title={request ? `Сменить машиниста: заявка ${request.displayNumber}` : 'Сменить машиниста'}
      open={open}
      onCancel={onCancel}
      onSubmit={onSubmit}
      confirmLoading={busy}
      // Кнопка называет то, что произойдёт на этом шаге: подтверждают не «смену машиниста»
      // вообще, а вот эти последствия — либо отвечают на вопрос, кто работал в неназванные дни.
      okText={
        asking.length > 0
          ? 'Показать последствия'
          : secondStep
            ? 'Подтвердить'
            : 'Сменить машиниста'
      }
      footerExtra={
        // «Назад» уводит от отправки — потому и стоит по другую сторону от основного действия.
        secondStep ? <Button onClick={() => setShown(null)}>Назад</Button> : undefined
      }
      width={860}
    >
      <Form form={form} layout="vertical" onFinish={submitForm}>
        <Space orientation="vertical" size={12} style={{ display: 'flex' }}>
          {forbidden && <MachinistForbiddenAlert message={forbidden} />}

          {/* Состав по датам виден на всех шагах, кроме подтверждения: там человек читает цену
            действия, и второй перечень рядом отвлекал бы от неё. */}
          {!secondStep && term && (
            <AssignmentHistoryPanel
              history={history.data}
              loading={history.isPending}
              term={term}
              assignment={assignmentVehicle(request)}
              driverName={driverName}
              today={today}
              onCancelGroup={({ segment }) => {
                const target = cancelTargetOf(segment);
                if (target) askPreview({ kind: 'cancel', target, segment }, []);
              }}
            />
          )}

          {history.isError && (
            <Alert
              type="error"
              showIcon
              title="Состав по датам прочитать не удалось"
              description={errorMessage(history.error)}
            />
          )}

          {asking.length > 0 && (
            <MachinistAnchorFields
              anchors={asking}
              machinists={machinists.data?.items ?? []}
              loading={machinists.isFetching}
            />
          )}

          {dto && asking.length === 0 && shown && (
            <MachinistChangePreview
              preview={dto}
              cancelling={shown.draft.kind === 'cancel' ? shown.draft.segment : null}
              driverName={driverName}
              staleReason={staleReason}
            />
          )}

          {/* Причина спрашивается по `operationRequirement`, а не по календарю (Р32): её требует
            отмена дремлющего решения с прошлогодней датой и не требует плановая смена на будущее. */}
          {dto?.operationRequirement && asking.length === 0 && (
            <Form.Item
              name="reason"
              label="Причина"
              style={{ marginBottom: 0 }}
              extra={
                dto.operationRequirement.kind === 'crew'
                  ? 'Команда задевает уже отработанные дни: она пойдёт записью в журнал коррекций, и без объяснения её там быть не может.'
                  : 'Команда правит уже принятое решение: она пойдёт записью в журнал коррекций, и без объяснения её там быть не может.'
              }
              rules={[{ required: true, message: 'Укажите причину' }]}
            >
              <Input.TextArea
                rows={2}
                maxLength={2000}
                showCount
                placeholder="Например: с понедельника на кране работает сменщик"
              />
            </Form.Item>
          )}

          {/* Форма подбора. На втором шаге она прячется, а не размонтируется: «Назад» обязан
            вернуть окно заполненным. */}
          {request && (
            <div style={{ display: secondStep ? 'none' : undefined }}>
              <MachinistPickFields
                request={request}
                machinists={machinists.data?.items ?? []}
                loading={machinists.isFetching}
              />
            </div>
          )}
        </Space>
      </Form>
    </FormModal>
  );
}
