import { Alert, App, Space, Typography } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  attachableServiceFileKinds,
  isServiceRequestClosed,
  SERVICE_FILE_KINDS,
  serviceFileKindLabels,
  type ServiceRequestDto,
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
import { serviceExecutorAssignment } from './serviceRequestRow';
import { errorMessage } from '../../utils/format';

/**
 * Документы заявки по видам (§9.4). Общей кучей их держать нельзя: вопрос к этой вкладке — не
 * «что приложено», а «есть ли чем закрыть», и в списке из восьми файлов ответ на него теряется.
 *
 * Чего не хватает — сказано прямо: «закрыто, но акта нет» — рабочее состояние, из-за которого и
 * заведена очередь «Ожидаются документы».
 */
export function ServiceRequestDocuments({ request }: { request: ServiceRequestDto }) {
  const { message } = App.useApp();
  const { can, user } = useAuth();
  const qc = useQueryClient();
  /*
   * Виды подшивки считает КОНТРАКТ (ADR 0160, решение 7), а не портал: своей копии правила здесь
   * больше нет. Копий было три — таблица маршрута (`FILE_KIND_STATUSES`), эта и матрица видимости,
   * — и две из них уже разошлись: портал предлагал «Вложение» в любом незакрытом статусе, а сервер
   * принимал его только в «Новая», «В работе» и «Решена». Расхождение читалось как поломка портала
   * («выбрал вид — получил отказ»), и чинить его в третий раз копией значило бы завести четвёртую.
   *
   * ПОВЕДЕНИЕ ПОРТАЛА ОТ ЭТОГО МЕНЯЕТСЯ, и намеренно: «Вложение» здешняя копия разрешала в любом
   * незакрытом статусе, а серверная таблица — только в «Новая», «В работе» и «Решена». Разница
   * выпадает на статусы «Согласована ИТ», «Назначена», «Диагностика» и «Смета на согласовании» —
   * все четыре мёртвые (Р1, Р2, 0197), и живой заявки в них не бывает, но заявки-наследие и
   * история в них есть. Это не потеря возможности: сервер на такую подшивку и раньше отвечал
   * `422` — портал перестал обещать то, чего не бывает.
   *
   * Аудитория — второй сомножитель того же вопроса (Р9): заявителю положен единственный вид,
   * «Вложение», и берётся она из DTO, а не считается по правам. Иначе выходит «подшил и потерял» —
   * человек кладёт файл видом «Счёт», и тот исчезает из его же карточки.
   *
   * Статус — «эффективный» (Р110): у отложенной заявки виды документов считаются по тому статусу,
   * из которого её отложили. Заморозка останавливает ход заявки, а не жизнь вокруг неё — вложение
   * к отложенной «В работе» то же самое, — и тем же правилом решает сервер
   * (`assertFileKindAllowed`). Считай портал по `on_hold`, он предлагал бы вид, на котором придёт
   * отказ, а нужный не предложил бы вовсе.
   *
   * Сторона — третий сомножитель (план аудита исполнителей, Р3): акт и счёт кладёт исполнитель либо
   * тот, кто ведёт заявку, а `serviceRequests.finance` сам по себе подшивку не разрешает. Признаки
   * назначения считает общий адаптер (`serviceExecutorAssignment`) — тот же, каким их читают меню
   * действий и вкладка объёма работ; своей формулы здесь нет, иначе форма предлагала бы ИТ-службе
   * «Акт», на котором сервер ответит 403.
   */
  const kinds = attachableServiceFileKinds(
    request.heldFromStatus ?? request.status,
    request.audience,
    user,
    serviceExecutorAssignment(request, user),
  );

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
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      {/* Планка одна и та же везде (Р112): перечисление недостающих видов читалось бы как
          «нужны все три», а приёмку снимает любой один.

          Заявителю её нет вовсе (ADR 0160, Р12), и отдельным условием это здесь не написано:
          ответ «нет» даёт сам предикат — он спрашивает аудиторию первым делом. Вторая проверка
          рядом означала бы два правила на один вопрос, а разошлись бы они молча: плашка на
          вкладке и красный тег в списке спрашивают одну и ту же функцию. */}
      {isAwaitingDocuments(request) && (
        <Alert
          type="warning"
          showIcon
          title={SERVICE_CLOSING_DOCUMENT_HINT}
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
