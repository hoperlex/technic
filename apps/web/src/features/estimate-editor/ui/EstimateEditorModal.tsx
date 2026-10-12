import { useEffect, useState } from 'react';
import { App, Input, Typography } from 'antd';
import {
  canCoordinateServiceRequests,
  type ServiceActionRequest,
  type ServiceExecutorAssignment,
  type ServiceRequestDto,
} from '@technic/contracts';
import { useAuth } from '@entities/session';
import { StaleRecordNotice, ViewModal } from '@shared/ui';
import { useEstimateEditor, type EstimateEditorIntent } from '../model/useEstimateEditor';
import { EstimateComposition } from './EstimateComposition';
import { EstimateDocumentFiles, EstimateDocumentSwitch } from './EstimateDocumentMode';
import {
  estimateEditorModalTitle,
  WorkCompletedActStep,
  WorkDoneNotice,
} from './EstimateDocumentWorkflow';
import { EstimateEditorFooter } from './EstimateEditorFooter';
import { EstimateEditorHint } from './EstimateEditorHint';
import { EstimateExemption } from './EstimateExemption';

/**
 * Presents four doors over one revision model: legacy item editing, coordinator breakdown,
 * direct document submission, and completed work with automatic approval. The model hook owns
 * commands and revision locks; this component only selects the visible workflow. A pending
 * revision locks every door because an approver must sign exactly what was presented.
 */
export function EstimateEditorModal({
  request,
  intent = 'estimate',
  actionRow,
  assignment,
  onClose,
}: {
  /**
   * `null` — окно закрыто. Открывается в «В работе»: до неё объёму работ взяться неоткуда, а
   * после закрытия работ он уже не правится.
   */
  request: ServiceRequestDto | null;
  /**
   * The caller names the workflow door: legacy rows, coordinator breakdown, direct document, or
   * completed work with automatic approval. The legacy default preserves direct test callers.
   */
  intent?: EstimateEditorIntent;
  /**
   * Перевод карточки в то, чем её видят предикаты контрактов, и признаки назначения на неё —
   * ГОТОВЫМИ ОТ ВЫЗЫВАЮЩЕГО (Р3): единственный такой перевод живёт на слое разделов
   * (`serviceActionRow`, `serviceExecutorAssignment`), а второй, собранный окном, разошёлся бы с
   * ним молча. Не передали — чекбокса освобождения нет: показанный не тому, он обещал бы денежное
   * решение, за которым стоит 403.
   */
  actionRow?: ServiceActionRequest;
  assignment?: ServiceExecutorAssignment;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const { user } = useAuth();
  const breakdown = intent === 'breakdown';
  const directDocument = intent === 'document' || intent === 'work_done';
  const workDone = intent === 'work_done';
  const [submittedRequest, setSubmittedRequest] = useState<ServiceRequestDto | null>(null);
  useEffect(() => setSubmittedRequest(null), [request?.id, intent]);
  const editor = useEstimateEditor({
    request,
    intent,
    actionRow,
    assignment,
    onClose,
    onDocumentSubmitted: workDone ? setSubmittedRequest : undefined,
  });
  /*
   * Кому положены пояснения (Р11): признак считает вызывающий, а не `ServiceHint`, — слой
   * сущностей `AuthContext` не видит, и правило живёт единственной функцией контрактов.
   */
  const coordinator = canCoordinateServiceRequests(user);
  const warrantyMode = !!request?.warrantyClaim && !breakdown;
  const { locked, mode, rows, issue, pending } = editor;
  /*
   * ПОДАЧА СЧЁТОМ УБИРАЕТ ПОЛЯ С ЭКРАНА, А НЕ ГАСИТ ИХ (Р10). У окна уже есть настоящий погашенный
   * режим — замок висящего предъявления, — и означает он совсем другое: «сначала отзовите
   * предъявление». Два состояния, выглядящих одинаково, отправили бы человека искать несуществующую
   * кнопку; здесь же полей не гасят, а не заполняют вовсе — их у документной ревизии нет.
   */
  const documentOn = editor.documentOn;
  /*
   * Что мешает отправке ПРЯМО СЕЙЧАС: у документной подачи спрашивается один документ, у
   * построчной — полнота состава. Строка под кнопкой одна, потому что вопрос один.
   */
  const problem = documentOn ? editor.documentIssue : issue;

  /**
   * Отказ по незаполненному — тостом, и это исключение записано в воротах поимённо (ADR 0094,
   * `check-form-blockers`): полей формы у окна нет — состав живёт состоянием ради итога на лету, —
   * помечать нечего, а список пропусков читается одной строкой под кнопкой. Стоит он ЗДЕСЬ, у
   * разметки, а не в хуке: послабление ворот выдано этому файлу, и разъехавшись, оно потребовало
   * бы второго.
   */
  const refuse = (problem: string | null): boolean => {
    if (!problem) return false;
    message.warning(problem);
    return true;
  };
  /*
   * У ЧЕРНОВИКА СВОЙ ВОПРОС, А НЕ «БЕЗ ВОПРОСОВ» (дефект Д1 тестовой волны). Прежде здесь стояло
   * `if (!asDraft && …)`: черновик уходил как есть — незаконченный набор законно сохранять. В
   * свободном режиме это оказалось дырой: описание без стоимости уходило строкой с подставленным
   * нулём, а при следующем открытии ноль приезжал готовым значением и предъявлялся уже молча. То
   * есть «пусто = 0», отменённое ответом В10, возвращалось в два шага. Черновик остался
   * черновиком: пустую свободную запись сохранять по-прежнему можно, начатую без стоимости —
   * нельзя.
   */
  const submit = (asDraft: boolean) => {
    if (refuse(asDraft ? editor.draftIssue : issue)) return;
    editor.submit(asDraft);
  };
  /*
   * Одна кнопка на два формата, потому что действие одно — «предъявить»: расходится не оно, а то,
   * что уезжает в теле (строки либо страницы счёта, Р2). Второй кнопкой рядом окно спрашивало бы
   * формат дважды — галочкой и нажатием.
   */
  const present = () => {
    if (!documentOn) {
      submit(false);
      return;
    }
    editor.submitDocument();
  };
  const runBreakdown = () => {
    if (refuse(issue)) return;
    editor.runBreakdown();
  };

  if (submittedRequest) {
    return <WorkCompletedActStep request={submittedRequest} onClose={onClose} />;
  }

  return (
    <ViewModal
      title={estimateEditorModalTitle(request, intent)}
      open={!!request}
      onClose={onClose}
      width={860}
      destroyOnHidden
      /*
       * У раскладки подвал СВОЙ, а не общий с погашенными кнопками: ни черновика, ни предъявления
       * у «Ведения» нет — прав на них у него не бывает вовсе, — и выключенные кнопки обещали бы
       * действия, которых за этой дверью не существует.
       */
      footer={
        <EstimateEditorFooter
          breakdown={breakdown}
          warrantyMode={warrantyMode}
          documentOn={documentOn}
          workDone={workDone}
          directDocument={directDocument}
          locked={locked}
          filled={editor.filled}
          pending={pending}
          saving={editor.saving}
          warrantyPending={editor.warrantyPending}
          breakdownPending={editor.breakdownPending}
          documentPending={editor.documentPending}
          documentIssue={editor.documentIssue}
          onBreakdown={runBreakdown}
          onWarranty={editor.runWarranty}
          onDraft={() => submit(true)}
          onPresent={present}
        />
      }
    >
      {request && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <StaleRecordNotice session={editor.staleRecord} />
          <EstimateEditorHint
            request={request}
            coordinator={coordinator}
            locked={locked}
            breakdown={breakdown}
            directDocument={directDocument}
            workDone={workDone}
            warrantyMode={warrantyMode}
          />

          {/* Способ подачи решают ДО набора, поэтому галочка стоит выше переключателя: поставленная
              после, она убрала бы с экрана только что набранное. Рубильник выключен — способа не
              видно вовсе (§7): кнопка, ведущая в 422, хуже отсутствующей. */}
          {!directDocument && editor.documentOffered && (
            <EstimateDocumentSwitch
              checked={documentOn}
              allowed={editor.documentFits}
              disabled={locked}
              onChange={editor.switchDocumentMode}
            />
          )}

          {documentOn ? (
            <EstimateDocumentFiles
              files={editor.files}
              uploading={editor.uploading}
              disabled={locked}
              onUpload={editor.addFile}
              onRemove={editor.removeFile}
            />
          ) : (
            <EstimateComposition
              mode={mode}
              rows={rows}
              total={editor.total}
              disabled={locked}
              onSwitchMode={editor.switchMode}
              onAddRow={editor.addRow}
              onChangeRow={editor.changeRow}
              onRemoveRow={editor.removeRow}
            />
          )}

          {/* Комментарий уходит с ПРЕДЪЯВЛЕНИЕМ, поэтому у раскладки его нет: «Ведение» ничего не
              предъявляет своими словами — предъявление ставит сама ручка, и поле, чей текст никуда
              не уедет, было бы обещанием несказанного. */}
          {!breakdown && (
            <Input.TextArea
              rows={2}
              maxLength={1000}
              disabled={locked}
              value={editor.comment}
              placeholder={
                directDocument
                  ? 'Комментарий к выполненным работам'
                  : 'Комментарий к объёму работ: что нашли при диагностике'
              }
              onChange={(e) => editor.setComment(e.target.value)}
            />
          )}
          {/* Чекбокс освобождения виден в ОБОИХ форматах: «строки плюс освобождение» — законное
              сочетание и главный сценарий разбора (Р2), а не приложение к счёту. Рубильника в
              условии показа нет намеренно (§7): он гасит ИСХОД, а не команду, — при выключенном
              заявление проходит и записывается как «наблюдение». Спрятанный чекбокс убил бы режим
              наблюдения целиком, поэтому ключ уходит текстом рядом, а не условием показа. */}
          {workDone && <WorkDoneNotice />}
          {!workDone && editor.exemptionOffered && (
            <EstimateExemption
              checked={editor.exemption}
              note={editor.exemptionNote}
              applies={editor.exemptionApplies}
              disabled={locked}
              onChange={editor.setExemption}
              onNote={editor.setExemptionNote}
            />
          )}
          {problem && <Typography.Text type="warning">{problem}</Typography.Text>}
        </div>
      )}
    </ViewModal>
  );
}
