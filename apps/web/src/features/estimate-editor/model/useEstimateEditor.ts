import { useRef, useState } from 'react';
import {
  serviceEstimatePending,
  type ServiceActionRequest,
  type ServiceExecutorAssignment,
  type ServiceItemKind,
  type ServiceRequestDto,
} from '@technic/contracts';
import { useRecordSession } from '@shared/lib';
import { useEstimatePresentation } from './useEstimatePresentation';
import { useEstimateCommands } from './useEstimateCommands';
import {
  newEstimateRow,
  rowsForSave,
  rowsTotal,
  type EstimateMode,
  type EstimateRow,
} from './rows';
import { estimateDraftIssue, estimateIssue } from './estimateRules';
import { estimateFill, switchedRows } from './estimateForm';

/**
 * The entry intent selects both the presentation and the command semantics.
 *
 * `estimate` keeps the legacy row editor for existing flows and tests. `breakdown` lets the
 * coordinator reissue a document revision as item rows. `document` is the direct file flow with
 * normal approval, while `work_done` adds the service-company exemption and continues to the act.
 */
export type EstimateEditorIntent = 'estimate' | 'breakdown' | 'document' | 'work_done';

/**
 * Всё, чем живёт окно объёма работ: строки, режим ввода, версия заявки и четыре пути отправки —
 * черновик, построчное предъявление, гарантийный ремонт и подача счётом.
 *
 * ОТДЕЛЬНО ОТ РАЗМЕТКИ, потому что предметы разные: здесь — что происходит с составом и куда он
 * уходит, там — как это выглядит. Разрез появился, когда у окна прибавились режим ввода (Р1) и
 * вторая дверь (Р2): вместе они перерастали бюджет длины файла, а главное — размётка перестала
 * читаться целиком, ради чего бюджет и заведён.
 *
 * СОСТАВ ЖИВЁТ СОСТОЯНИЕМ, А НЕ ФОРМОЙ с `Form.List`: итог считается на каждое нажатие клавиши и
 * показывается тут же — это главное, что окно делает, — а объём работ есть разговор о деньгах, и
 * сумма не должна появляться только после отправки (ADR 0094, исключение ворот названо поимённо).
 *
 * THE REQUEST VERSION IS A SNAPSHOT OF THE WINDOW SESSION (stage 5 plan §4.5): taken when the
 * window fills, moved by this window's own answers — saving the composition raises it, and a
 * submission right after the save with the old version would get 409 out of nowhere (R30). A
 * reread of the card neither refills the window nor moves the version: an untouched window is
 * refilled silently, a changed one shows the notice, and "Reload" is the only way to drop the rows.
 */
export function useEstimateEditor({
  request,
  intent,
  actionRow,
  assignment,
  onClose,
  onDocumentSubmitted,
}: {
  /** `null` — окно закрыто; состояние всё равно живёт, чтобы не пересоздавать хук на открытии. */
  request: ServiceRequestDto | null;
  intent: EstimateEditorIntent;
  /**
   * Карточка глазами предикатов контрактов и признаки назначения на неё — ПЕРЕВОД ДЕЛАЕТ
   * ВЫЗЫВАЮЩИЙ, а не окно (Р3 плана
   * `docs/office-equipment-on-site-and-invoice-estimate-plan.md`).
   *
   * Так, а не «сложим четыре поля из DTO здесь», по двум причинам сразу. Перевод в этом портале
   * ровно один — `serviceActionRow`/`serviceExecutorAssignment` на слое разделов, — и второй,
   * собранный окном по-своему, разошёлся бы с ним молча на первом же поле (там это записано
   * прямо: «дешевле держать один перевод, чем ловить расхождение на экране»). А достать тот
   * перевод сюда нельзя: слой сценариев разделов не видит.
   *
   * НЕОБЯЗАТЕЛЬНЫ И FAIL-CLOSED: не передали — чекбокса освобождения нет вовсе. Это честнее
   * умолчания «показать»: за нарисованным шире чекбоксом стоит 403, а денежное решение,
   * предложенное не тому, читается как разрешение.
   */
  actionRow?: ServiceActionRequest;
  assignment?: ServiceExecutorAssignment;
  onClose: () => void;
  /** Keeps the modal open for a following workflow step, such as attaching the closing act. */
  onDocumentSubmitted?: (request: ServiceRequestDto) => void;
}) {
  const breakdown = intent === 'breakdown';
  const directDocument = intent === 'document' || intent === 'work_done';
  const workDone = intent === 'work_done';

  const [rows, setRows] = useState<EstimateRow[]>([]);
  /*
   * Режим ВВОДА, а не вид документа (Р1): в базу оба уходят одинаковыми строками, и признака
   * формата там нет вовсе. Живёт состоянием окна по той же причине, по какой строки: угадывается
   * он по составу при открытии (`initialEstimateMode`), а дальше им распоряжается человек.
   */
  const [mode, setMode] = useState<EstimateMode>('rows');
  const [comment, setComment] = useState('');
  /** Rows and mode as the last fill left them: the person's edits replace the rows array. */
  const [filled, setFilled] = useState<{ rows: EstimateRow[]; mode: EstimateMode } | null>(null);
  /** The rows array a draft save sent: unchanged since, it may be refilled from the answer. */
  const sentRows = useRef<EstimateRow[] | null>(null);

  /*
   * Строки, которые уйдут на сервер: в свободном режиме нетронутая запись отсеивается (Р8) —
   * пустые два поля означают «объём работ ещё не набирали», а не строку сметы. Считается один раз
   * на оба пути отправки, чтобы «черновик» и «раскладка» не разошлись в том, что именно шлют.
   */
  const saved = rowsForSave(rows, mode);
  /*
   * Оба замка Р9 сразу: и правка состава, и повторное предъявление закрыты одним признаком —
   * непогашенным предъявлением. Признак спрашивается у контрактов, а не выводится из даты
   * предъявления: у отозванного `estimateSubmittedAt` непуста, и окно заперлось бы навсегда.
   */
  const locked = !!request && serviceEstimatePending(request);

  /*
   * ЧЕМ ПРЕДЪЯВЛЯЮТ И НА КАКИХ УСЛОВИЯХ — СВОИМ ХУКОМ (Р2, Р3, Р10): способ подачи, страницы счёта
   * и заявление об освобождении. Здесь остаётся СОСТАВ и то, куда он уходит; там — чем ревизия
   * будет вообще и собирают ли под ней подпись. Разрез тот же, что между строками и разметкой:
   * вместе эти две темы читались бы как одна, каковой они не являются.
   */
  const presentation = useEstimatePresentation({
    request,
    rows,
    breakdown,
    actionRow,
    assignment,
    forceDocument: directDocument,
    forceExemption: workDone,
  });
  const { exemptionBody } = presentation;

  const session = useRecordSession({
    open: !!request,
    id: request?.id ?? null,
    data: request ?? undefined,
    version: (r: ServiceRequestDto) => r.version,
    isDirty: () =>
      rows !== filled?.rows || mode !== filled?.mode || comment !== '' || presentation.changed,
    fill: (r, reason) => {
      const { mode: startMode, rows: startRows } = estimateFill(r.items, breakdown);
      // Our own draft came back: the rows are refilled only if not edited since they were sent; the
      // comment and the submission method are not part of a draft and stay as they are.
      if (reason === 'own' && rows !== sentRows.current) return;
      setMode(startMode);
      setRows(startRows);
      setFilled({ rows: startRows, mode: startMode });
      if (reason === 'own') return;
      setComment('');
      presentation.reset();
    },
  });
  // Only behind an open window: every command below is sent after the session has filled.
  const version = session.version ?? 0;
  const commands = useEstimateCommands({
    request,
    version,
    accept: session.accept,
    composition: () => ({ rows, mode, comment }),
    markSent: () => {
      sentRows.current = rows;
    },
    files: presentation.files,
    exemption: presentation.exemption,
    exemptionBody,
    directDocument,
    workDone,
    onClose,
    onDocumentSubmitted,
  });

  /*
   * Чего не хватает набранному — считается ЗДЕСЬ, а объявляется человеку в окне (ADR 0094 и его
   * исключение в воротах `check-form-blockers`). Разделено намеренно: полей формы у окна нет,
   * помечать нечем, и тост про пропуск разрешён поимённо ОДНОМУ файлу — тому, где живёт разметка.
   * Скажи о пропуске хук, правило пришлось бы ослаблять ещё на один файл, а оно и заведено затем,
   * чтобы такие послабления были видны.
   */
  const issue = estimateIssue(rows, mode);
  /*
   * Отдельный ответ для черновика (дефект Д1 тестовой волны). Черновик по-прежнему сохраняют
   * незаконченным — это его назначение, — но в свободном режиме начатая запись без стоимости легла
   * бы в базу нулём и при следующем открытии стала бы готовым значением, предъявляемым уже без
   * единого вопроса. Дыра закрывается на первом шаге, а не на втором.
   */
  const draftIssue = estimateDraftIssue(rows, mode);
  /*
   * Чего не хватает документной подаче — ровно одного: самого документа. Ни суммы, ни описания,
   * ни реквизитов счёта у неё не спрашивают вовсе (ответы В5 и В13), и спросить их здесь значило
   * бы придумать требование, которого нет ни в схеме, ни на сервере.
   */

  return {
    /** Someone else's newer request over a changed window: the notice and its "Reload". */
    staleRecord: { stale: session.stale, reload: session.reload },
    rows,
    mode,
    comment,
    setComment,
    /*
     * Способ подачи и заявление об освобождении отдаются наружу как есть: разметке нужны ровно те
     * же признаки, которыми они считаются, а переименованная по дороге копия разошлась бы с ними
     * на первой же правке.
     */
    ...presentation,
    /** Что не так с набранным: в свободном режиме спрашивается описание и стоимость, не графы. */
    issue,
    /** То же для черновика: пустая запись законна, начатая без стоимости — нет (Д1). */
    draftIssue,
    /**
     * Набрано ли хоть что-то — по строкам, КОТОРЫЕ УЙДУТ, а не по тем, что лежат в состоянии.
     * Разница появилась вместе со свободным режимом: он держит свою строку всегда, и нетронутая
     * она означает пустой объём работ. Спроси гарантийная кнопка `rows.length`, она гасла бы в
     * только что открытом окне — ровно там, где гарантийный ремонт и предъявляют.
     */
    filled: saved.length > 0,
    total: rowsTotal(rows),
    locked,
    pending: commands.pending,
    saving: commands.saving,
    warrantyPending: commands.warrantyPending,
    breakdownPending: commands.breakdownPending,
    documentPending: commands.documentPending,
    /*
     * Смена режима (Р8). В свободный режим состав ПРИВОДИТСЯ, а не просто показывается двумя
     * полями: количество и вид у единственной строки становятся теми, какими их подставит портал,
     * — иначе итог окна считался бы по очищенному количеству и показывал ноль под заполненной
     * стоимостью.
     *
     * Обратно приводить нечего — описание уже лежит наименованием, стоимость ценой, — но НЕТРОНУТАЯ
     * запись при уходе выбрасывается: свободный режим держит свою строку всегда, и, не выброси мы
     * её, человек, заглянувший в «Одной строкой» и вернувшийся, обнаружил бы в «Услугах» пустую
     * строку, которой не добавлял.
     */
    switchMode: (next: EstimateMode) => {
      setMode(next);
      setRows((prev) => switchedRows(prev, next));
    },
    addRow: (kind: ServiceItemKind) => setRows((prev) => [...prev, newEstimateRow(kind)]),
    changeRow: (key: string, patch: Partial<EstimateRow>) =>
      setRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row))),
    removeRow: (key: string) => setRows((prev) => prev.filter((row) => row.key !== key)),
    /**
     * Отправка состава: черновиком либо с предъявлением. Полноту набранного спрашивает окно
     * (`issue`) — черновик уходит и неполным, это законный незаконченный набор, а предъявление
     * окно не пускает вовсе.
     */
    submit: (asDraft: boolean) => commands.save(!asDraft),
    /** Предъявление счётом: полноту (есть ли страницы) спрашивает окно — сюда приходит готовое. */
    submitDocument: commands.submitDocument,
    runWarranty: commands.runWarranty,
    /** Раскладка по графам: полноту так же спрашивает окно — сюда приходит уже проверенное. */
    runBreakdown: commands.runBreakdown,
  };
}
