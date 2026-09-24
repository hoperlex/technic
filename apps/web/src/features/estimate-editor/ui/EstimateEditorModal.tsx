import { useEffect, useState } from 'react';
import { App, Button, Input, Tooltip, Typography } from 'antd';
import {
  canCoordinateServiceRequests,
  type ServiceActionRequest,
  type ServiceExecutorAssignment,
  type ServiceRequestDto,
} from '@technic/contracts';
import { ServiceHint } from '@entities/service-request';
import { ViewModal } from '@shared/ui';
import { useAuth } from '../../../auth/AuthContext';
import { useEstimateEditor, type EstimateEditorIntent } from '../model/useEstimateEditor';
import { EstimateComposition } from './EstimateComposition';
import { EstimateDocumentFiles, EstimateDocumentSwitch } from './EstimateDocumentMode';
import {
  DirectDocumentIntro,
  estimateEditorModalTitle,
  WorkCompletedActStep,
  WorkDoneNotice,
} from './EstimateDocumentWorkflow';
import { EstimateExemption } from './EstimateExemption';

/**
 * Что окно не даст сделать, пока висит предъявление (Р9). Одна строка на оба замка, потому что
 * замок один по смыслу: согласующий подписывает то, что видит.
 *
 * Ключ от него тоже один — «Вернуть объём работ в правку»: ручка возврата снимает и подпись, и
 * само предъявление, и потому названа здесь дословно. Скажи мы просто «нельзя» — исполнитель
 * искал бы выход в кнопках этого окна, где его нет вовсе.
 */
const LOCKED_HINT =
  'Отзовите его действием «Вернуть объём работ в правку» — оно снимает и предъявление, и подпись, — и правка откроется снова.';

/**
 * Чем раскладка отличается от правки — словами и до нажатия (Р2, ответ В9 заказчика от
 * 09.09.2026). Ревизию поднимает не человек, а сама ручка, и узнать об этом он обязан здесь: под
 * согласованной сметой стоит подпись, и «Разложить» отправляет заявку за новой.
 */
const BREAKDOWN_HINT =
  'Раскладка переиздаёт объём работ: у согласованной ревизии поднимется номер, подпись снимется, ' +
  'а заявка уйдёт на согласование заново — под новым составом подписываются отдельно.';

/**
 * Откуда брать позиции, когда раскладывают ДОКУМЕНТНУЮ ревизию (Р8) — единственный путь такой
 * заявки к сумме, гарантиям и построчному факту, и обещан он человеку в трёх местах портала.
 *
 * Сказано именно здесь, потому что окно раскладки открывается пустым: строк у документной ревизии
 * нет вовсе, и без этой строки «Ведение» смотрело бы на пустую таблицу, не понимая, что переносить
 * и откуда. Счёт лежит на вкладке «Документы» — самим окном он не показывается: вложенная читалка
 * файла внутри окна раскладки была бы третьим слоем поверх карточки.
 */
const BREAKDOWN_DOCUMENT_HINT =
  'Объём работ подан счётом: строк у ревизии нет, и переносить позиции нужно из самого документа — ' +
  'он на вкладке «Документы» карточки. После раскладки заявка вернётся в обычный порядок: появятся ' +
  'сумма, построчный факт и гарантии.';

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
   * Раскладывают ДОКУМЕНТНУЮ ревизию (Р8): строк на экране нет и не будет — их переносят из счёта.
   * Формат берётся полем карточки, а не выводом «строк ноль»: пустой черновик выглядел бы так же, и
   * подсказка звала бы «Ведение» искать документ, которого нет.
   */
  const documentBreakdown = breakdown && request?.estimateFormat === 'document';
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
        breakdown
          ? [
              <Button
                key="breakdown"
                type="primary"
                loading={editor.breakdownPending}
                disabled={locked}
                onClick={runBreakdown}
              >
                Разложить по графам
              </Button>,
            ]
          : [
              /*
               * У ПОДАЧИ СЧЁТОМ ПОДВАЛ КОРОЧЕ, И ОБЕ ПРОПАВШИЕ КНОПКИ ПРОПАЛИ ПО ДЕЛУ (Р10).
               * Черновика у неё нет: сохранять нечего — счёт уже в хранилище, а строк, которые
               * ложились бы черновиком, режим не набирает вовсе, и нажатие унесло бы спрятанный
               * состав, которого человек на экране не видит. Гарантийный ремонт — третий формат
               * ревизии, несобираемый вместе с документом по типу тела: предложенный рядом с
               * галочкой, он обещал бы выбор, которого нет.
               */
              ...(warrantyMode && !documentOn
                ? [
                    <Tooltip
                      key="warranty"
                      title={
                        locked
                          ? 'Объём работ уже предъявлен: пока идёт согласование, предъявить заново нельзя'
                          : editor.filled
                            ? 'Уберите строки: гарантийный ремонт предъявляется без оплаты'
                            : 'Работы по гарантии: заявка уйдёт на согласование с нулевой суммой'
                      }
                    >
                      <span>
                        <Button
                          disabled={locked || editor.filled || pending}
                          loading={editor.warrantyPending}
                          onClick={editor.runWarranty}
                        >
                          Гарантийный ремонт без оплаты
                        </Button>
                      </span>
                    </Tooltip>,
                  ]
                : []),
              ...(documentOn
                ? []
                : [
                    <Button key="draft" disabled={locked || pending} onClick={() => submit(true)}>
                      Сохранить черновик
                    </Button>,
                  ]),
              /*
               * Без единой страницы кнопка ЗАПЕРТА, а не отвечает тостом по нажатию, — в отличие
               * от пропусков состава. Разница в том, что здесь нечего дозаполнять глазами: пустой
               * список приложенного виден рядом, и причина названа строкой под кнопкой. Отправить
               * такое тело нельзя и по схеме (`fileIds` минимум один) — кнопка вела бы в 400.
               */
              <Tooltip key="submit" title={documentOn ? editor.documentIssue : null}>
                <span>
                  <Button
                    type="primary"
                    loading={editor.saving || editor.documentPending}
                    disabled={
                      locked || editor.warrantyPending || (documentOn && !!editor.documentIssue)
                    }
                    onClick={present}
                  >
                    {workDone
                      ? 'Работы выполнены'
                      : directDocument
                        ? 'Передать документ на согласование'
                        : 'Предъявить на согласование'}
                  </Button>
                </span>
              </Tooltip>,
            ]
      }
    >
      {request && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {locked ? (
            /*
             * Замок объясняется до нажатия, а не 409-й в ответ. Поля и кнопки погашены, и без этой
             * врезки окно выглядело бы сломанным: состав виден, а тронуть его нечем — причину
             * этого портал обязан назвать сам, ответ сервера сюда уже не придёт.
             *
             * Это причина блокировки, поэтому у некоординатора она сворачивается, но НЕ исчезает
             * (Р11): исчезни она — исполнитель остался бы с погашенными полями без единого слова.
             * Ключ от замка при этом уходит вместе с описанием, и это осознанная цена свёртки:
             * снять предъявление всё равно вправе не он, а «Ведение», у которого текст остался
             * целым.
             */
            <ServiceHint
              coordinator={coordinator}
              level="warning"
              title={`Ревизия ${request.estimatePendingRevision} предъявлена и ждёт ответа — правка закрыта`}
              description={`Пока предъявление висит, сервер не примет ни изменённый состав, ни повторное предъявление: согласующий подписывает то, что видит. ${LOCKED_HINT}`}
            />
          ) : directDocument ? (
            <DirectDocumentIntro workDone={workDone} />
          ) : (
            // Как считается итог и что случится со старой подписью — пояснение о правилах цикла:
            // вне «Ведения» его не рисуют вовсе, сумма же видна в самом окне и без плашки.
            <ServiceHint
              coordinator={coordinator}
              level="info"
              title={
                breakdown
                  ? documentBreakdown
                    ? 'Перенесите позиции счёта в графы: строка на позицию, цена на строку'
                    : 'Перенесите присланный перечень в графы: строка на позицию, цена на строку'
                  : request.estimateRevision > 0
                    ? `Ревизия ${request.estimateRevision} уже предъявлялась — следующее предъявление уйдёт ревизией ${request.estimateRevision + 1}`
                    : 'Черновик можно сохранять сколько угодно: на согласование уйдёт то, что предъявите'
              }
              description={
                [
                  breakdown ? BREAKDOWN_HINT : null,
                  documentBreakdown ? BREAKDOWN_DOCUMENT_HINT : null,
                  warrantyMode
                    ? 'Заявка заведена как гарантийная — работы можно предъявить без оплаты.'
                    : null,
                  // Подпись обесценивается новым предъявлением (ревизии сверяются при закрытии
                  // работ), и узнать об этом надо до нажатия, а не по отказу на закрытии.
                  request.approval && !breakdown
                    ? `Согласована ревизия ${request.approval.revision}: новое предъявление снимет эту подпись — объём работ придётся согласовать заново.`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' ') || undefined
              }
            />
          )}

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
