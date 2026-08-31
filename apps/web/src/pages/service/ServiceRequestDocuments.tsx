import { Alert, App, Space, Typography } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  isServiceRequestClosed,
  SERVICE_FILE_KINDS,
  type ServiceFileKind,
  serviceFileKindLabels,
  type ServiceRequestDto,
  type ServiceRequestStatus,
} from '@technic/contracts';
import {
  isAwaitingDocuments,
  SERVICE_CLOSING_DOCUMENT_HINT,
  ServiceDocumentUpload,
  serviceRequestKeys,
  serviceRequestsApi,
} from '@entities/service-request';
import { officeEquipmentKeys } from '@entities/office-equipment';
import { filesApi } from '../../api/resources';
import { FileLinkList } from '../../components/FileLinks';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage } from '../../utils/format';

/**
 * Какие виды документов заявка принимает в этом статусе (§8.3). Портал не решает — решает
 * сервер; здесь этот же перечень (`FILE_KIND_STATUSES`), чтобы человек не выбирал вид, на котором
 * получит отказ.
 *
 * Правило одной строкой: до терминального статуса файлы живут обычной жизнью; после него заявка
 * принимает бумаги и ничего не отдаёт (Р16, Р29) — акт и счёт присылают и через неделю.
 *
 * Объём работ и гарантийный талон принимаются и в «В работе» (план §7.3). У объёма работ это
 * следствие Р8: предъявляют его оттуда и не двигая статус, значит и файл кладут оттуда же — второго
 * статуса у этого документа больше нет вовсе. У талона — следствие Н8: закрывающим документом он
 * считается, а без закрывающего документа сервисный ремонт в «Решена» не уходит, — разреши мы талон
 * только после неё, заявка, чья единственная бумага гарантийная, не закрылась бы вовсе.
 */
function attachableKinds(status: ServiceRequestStatus): ServiceFileKind[] {
  const closed = isServiceRequestClosed(status);
  const afterWork = status === 'in_work' || status === 'done' || closed;
  return SERVICE_FILE_KINDS.filter((kind) => {
    switch (kind) {
      case 'attachment':
        return !closed;
      case 'estimate':
        // Только «В работе» (Р14): «Смета на согласовании» снята вместе со статусом, и оставленная
        // здесь она открывала бы вид документа в состоянии, которого не бывает.
        return status === 'in_work';
      case 'act':
      case 'invoice':
      case 'warranty_card':
        return afterWork;
    }
  });
}

/**
 * Документы заявки по видам (§9.4). Общей кучей их держать нельзя: вопрос к этой вкладке — не
 * «что приложено», а «есть ли чем закрыть», и в списке из восьми файлов ответ на него теряется.
 *
 * Чего не хватает — сказано прямо: «закрыто, но акта нет» — рабочее состояние, из-за которого и
 * заведена очередь «Ожидаются документы».
 */
export function ServiceRequestDocuments({ request }: { request: ServiceRequestDto }) {
  const { message } = App.useApp();
  const { can } = useAuth();
  const qc = useQueryClient();
  /*
   * Статус — «эффективный» (Р110): у отложенной заявки виды документов считаются по тому статусу,
   * из которого её отложили. Заморозка останавливает ход заявки, а не жизнь вокруг неё — вложение
   * к отложенной «В работе» то же самое, — и тем же правилом решает сервер
   * (`assertFileKindAllowed`). Считай портал по `on_hold`, он предлагал бы вид, на котором придёт
   * отказ, а нужный не предложил бы вовсе.
   */
  const kinds = attachableKinds(request.heldFromStatus ?? request.status);

  // Снятие документа после приёмки — только у распорядителя файлов: заявка закрыта, и подшитая
  // бумага из неё не исчезает по решению стороны (Р29).
  const canAttach = can('serviceRequests.files') && kinds.length > 0 && !request.deletedAt;
  const canDetach =
    !request.deletedAt &&
    (can('files.manageAny') ||
      (can('serviceRequests.files') && !isServiceRequestClosed(request.status)));

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
    void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
  };

  const detach = useMutation({
    mutationFn: (fileId: string) => serviceRequestsApi.detachFile(request.id, fileId),
    onSuccess: () => {
      message.success('Документ снят');
      refresh();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {/* Планка одна и та же везде (Р112): перечисление недостающих видов читалось бы как
          «нужны все три», а приёмку снимает любой один. */}
      {isAwaitingDocuments(request) && (
        <Alert
          type="warning"
          showIcon
          message={SERVICE_CLOSING_DOCUMENT_HINT}
          description="Пока нет ни одного, заявка стоит в очереди «Ожидаются документы»: работу сервисной компании без закрывающего документа не закрыть, и портал такую заявку не закроет сам — сутки на возражение отсчитываются от подшитой бумаги."
        />
      )}

      {SERVICE_FILE_KINDS.map((fileKind) => {
        const files = request.files.filter((file) => file.kind === fileKind);
        if (files.length === 0) return null;
        return (
          <div key={fileKind}>
            <Typography.Text strong>{serviceFileKindLabels[fileKind]}</Typography.Text>
            <FileLinkList
              files={files}
              maxNameWidth={420}
              onRemove={canDetach ? (file) => detach.mutate(file.id) : undefined}
            />
          </div>
        );
      })}

      {request.files.length === 0 && (
        <Typography.Text type="secondary">К заявке ничего не подшито</Typography.Text>
      )}

      {canAttach && (
        <ServiceDocumentUpload
          requestId={request.id}
          kinds={kinds}
          upload={filesApi.upload}
          // Свежая заявка из ответа вкладке не нужна — её перерисует список: карточка живёт
          // запросом, и гасить кэш здесь честнее, чем держать второй источник той же заявки.
          onUploaded={refresh}
        />
      )}
    </Space>
  );
}
