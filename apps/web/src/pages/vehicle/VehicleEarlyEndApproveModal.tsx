import { useEffect, useEffectEvent, useState } from 'react';
import { Alert, App, Skeleton, Space, Typography } from 'antd';
import { useMutation } from '@tanstack/react-query';
import type {
  DecideVehicleEarlyEndBody,
  EarlyEndApprovalPreviewDto,
  SpecialEquipmentRequestDto,
} from '@technic/contracts';
import { FormModal } from '@shared/ui';
import { vehicleRequestsApi } from '../../api/resources';
import { errorMessage } from '../../utils/format';
import { EarlyEndConsequences } from './EarlyEndConsequences';
import { reassignStaleReason } from './ReassignPreview';
import { formatDateOnly } from './shared';

/**
 * Виза на досрочное завершение: последствия чужого запроса и подтверждение (ADR 0178, Р19).
 *
 * ЗАЧЕМ ОКНО ТАМ, ГДЕ БЫЛА КНОПКА. Виза применяет сокращение — двигает срок, гасит решения о
 * технике и переписывает бумагу, — но делает это спустя часы или дни после обращения, и делает
 * другой человек. Уходя прямо из строки списка, она ставилась вслепую: что именно сгорит и что
 * погаснет, визирующий узнавал уже из журнала.
 *
 * ПОЧЕМУ ПРЕДПРОСМОТР СВОЙ, А НЕ ЗАЯВИТЕЛЯ. Между запросом и решением состояние меняется, а
 * отпечаток, снятый чужими глазами и по чужому состоянию, подтверждает не то. Имя двери входит в
 * отпечаток, поэтому чужой предпросмотр не подойдёт физически, а не по проверке.
 *
 * Причину окно не спрашивает: она уже названа самим запросом («что случилось на объекте»), и второе
 * поле под неё означало бы два разных объяснения одного действия (Р19).
 */
interface Props {
  /** `null` — окно закрыто. Только заказ спецтехники: у грузоперевозки срока работ нет. */
  request: SpecialEquipmentRequestDto | null;
  confirmLoading: boolean;
  onCancel: () => void;
  /** Виза уходит телом вызывающего: мутация и её сообщения живут в общем хуке действий. */
  onSubmit: (body: DecideVehicleEarlyEndBody) => Promise<unknown> | undefined;
}

export function VehicleEarlyEndApproveModal({
  request,
  confirmLoading,
  onCancel,
  onSubmit,
}: Props) {
  const { message } = App.useApp();
  /**
   * Ключ операции — один на открытое окно, а не на нажатие (Р25): связь оборвалась, ответа нет,
   * человек жмёт ещё раз — и сервер по тому же ключу возвращает прежний результат вместо второго
   * сокращения с новыми сгоревшими номерами.
   */
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [preview, setPreview] = useState<EarlyEndApprovalPreviewDto | null>(null);
  const [staleReason, setStaleReason] = useState<string | null>(null);

  const previewMut = useMutation({
    mutationFn: (r: SpecialEquipmentRequestDto) =>
      vehicleRequestsApi.earlyEndDecisionPreview(r.id, r.version),
    onSuccess: (dto) => setPreview(dto),
    onError: (e) => message.error(errorMessage(e)),
  });

  /*
   * Последствия спрашиваются на каждое открытие и заново: между вчерашним просмотром и сегодняшним
   * нажатием план меняется, не тронув заявку (чужая команда заняла дату, лист аннулировали своей
   * ручкой, наступила полночь), а отпечаток такой предпросмотр уже не подтвердит.
   */
  const targetId = request?.id ?? null;
  const askPreview = useEffectEvent((_id: string | null) => {
    if (!request) return;
    setPreview(null);
    setStaleReason(null);
    setOperationId(crypto.randomUUID());
    previewMut.mutate(request);
  });
  // Зависимость — идентификатор заявки: перерисовка той же заявки приходит новым объектом и
  // спрашивала бы план по кругу.
  useEffect(() => askPreview(targetId), [targetId]);

  const submit = async () => {
    if (!request || !preview) return;
    try {
      await onSubmit({
        approved: true,
        // Слово визирующего окно не спрашивает (см. шапку), но поле остаётся тем единственным
        // местом, где оно живёт, — и потому уезжает пустым явно, а не отсутствием.
        comment: '',
        operationId,
        previewFingerprint: preview.fingerprint,
        // Присутствие подтверждения задаёт **ответ сервера**, а не желание клиента: лишний
        // отпечаток отвергается так же строго, как недостающий.
        ...(preview.cancelGroupsFingerprint
          ? { cancelGroupsFingerprint: preview.cancelGroupsFingerprint }
          : {}),
        version: request.version,
      });
    } catch (e) {
      /*
       * Последствия изменились между просмотром и нажатием — сервер отвечает 409, и правильный
       * ответ окна не «повторите», а «посмотрите заново»: перечень мог стать другим, и подтверждать
       * прежний визирующий больше не вправе. Прочие отказы показывает тостом общий хук.
       */
      const stale = reassignStaleReason(e);
      if (!stale) return;
      setStaleReason(stale);
      previewMut.mutate(request);
    }
  };

  const earlyEnd = request?.earlyEnd ?? null;

  return (
    <FormModal
      title={
        request
          ? `Досрочное завершение ${request.displayNumber}: виза`
          : 'Досрочное завершение: виза'
      }
      open={!!request}
      onCancel={onCancel}
      onSubmit={() => void submit()}
      confirmLoading={confirmLoading || previewMut.isPending}
      okText="Согласовать"
      // Пока последствия не посчитаны, подтверждать нечего: отпечатка у окна ещё нет, и сервер
      // отверг бы визу без него.
      okDisabled={!preview}
      width={720}
    >
      <Space orientation="vertical" size={12} style={{ display: 'flex' }}>
        {/* Что и почему просили — основание решения: визирующий площадку в этот момент не видит и
          решает по тому, что ему написали. */}
        {earlyEnd && (
          <div style={{ lineHeight: 1.6 }}>
            <Typography.Text strong>
              Просят закончить {formatDateOnly(earlyEnd.newDateTo)} вместо{' '}
              {formatDateOnly(earlyEnd.previousDateTo)}
            </Typography.Text>
            <div>
              <Typography.Text type="secondary">
                {earlyEnd.requestedByName}: {earlyEnd.reason}
              </Typography.Text>
            </div>
          </div>
        )}

        {previewMut.isPending && <Skeleton active paragraph={{ rows: 4 }} />}
        {previewMut.isError && !preview && (
          <Alert
            type="error"
            showIcon
            title="Последствия посчитать не удалось"
            description={errorMessage(previewMut.error)}
          />
        )}
        {preview && <EarlyEndConsequences preview={preview} staleReason={staleReason} />}
      </Space>
    </FormModal>
  );
}
