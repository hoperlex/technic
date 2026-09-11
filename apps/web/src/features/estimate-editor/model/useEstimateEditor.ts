import { useEffect, useState } from 'react';
import { App } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  serviceEstimatePending,
  type ServiceItemKind,
  type ServiceRequestDto,
} from '@technic/contracts';
import { serviceRequestKeys, serviceRequestsApi } from '@entities/service-request';
import { officeEquipmentKeys } from '@entities/office-equipment';
import { errorMessage } from '@shared/lib';
import {
  estimateDraftIssue,
  estimateIssue,
  initialEstimateMode,
  newEstimateRow,
  rowsChanged,
  rowsForSave,
  rowsFromItems,
  rowsToPayload,
  rowsTotal,
  toFreeRows,
  type EstimateMode,
  type EstimateRow,
} from './rows';

/**
 * Чья дверь открыла редактор (план
 * `docs/office-equipment-free-estimate-and-executor-scope-plan.md`, Р2).
 *
 * Не украшение и не вид показа: от неё зависит РУЧКА, в которую уйдёт состав, а последствия у двух
 * ручек разные. `estimate` — исполнитель правит свой черновик: состав заменяется, номер ревизии и
 * подписи не трогаются. `breakdown` — «Ведение» переносит присланный подрядчиком перечень в графы,
 * и по СОГЛАСОВАННОЙ ревизии это переиздание документа: номер поднимается, подпись снимается,
 * итог пересчитывается, заявка ждёт новой подписи (ADR 0133 — подписанное содержимое под прежней
 * ревизией не меняется).
 */
export type EstimateEditorIntent = 'estimate' | 'breakdown';

/**
 * Всё, чем живёт окно объёма работ: строки, режим ввода, версия заявки и три пути отправки.
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
 * ВЕРСИЯ ЗАЯВКИ ДЕРЖИТСЯ СВОИМ СОСТОЯНИЕМ: сохранение состава её поднимает, и предъявление сразу
 * после сохранения ушло бы со старой версией — то есть получило бы 409 на ровном месте (Р30).
 */
export function useEstimateEditor({
  request,
  intent,
  onClose,
}: {
  /** `null` — окно закрыто; состояние всё равно живёт, чтобы не пересоздавать хук на открытии. */
  request: ServiceRequestDto | null;
  intent: EstimateEditorIntent;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const breakdown = intent === 'breakdown';

  const [rows, setRows] = useState<EstimateRow[]>([]);
  /*
   * Режим ВВОДА, а не вид документа (Р1): в базу оба уходят одинаковыми строками, и признака
   * формата там нет вовсе. Живёт состоянием окна по той же причине, по какой строки: угадывается
   * он по составу при открытии (`initialEstimateMode`), а дальше им распоряжается человек.
   */
  const [mode, setMode] = useState<EstimateMode>('rows');
  const [comment, setComment] = useState('');
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!request) return;
    const initial = rowsFromItems(request.items);
    /*
     * РАСКЛАДКА ОТКРЫВАЕТСЯ ПО ГРАФАМ ВСЕГДА, и это вся её суть: «Ведение» нажало «Разложить по
     * графам» именно затем, чтобы развернуть свободную запись, — а свободная запись как раз и
     * проходит `fitsFreeMode`, то есть без этой ветки окно открылось бы двумя полями, из которых
     * раскладывать нечего.
     */
    const startMode = breakdown ? 'rows' : initialEstimateMode(initial);
    setMode(startMode);
    setRows(startMode === 'free' ? toFreeRows(initial) : initial);
    setVersion(request.version);
    setComment('');
  }, [request, breakdown]);

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

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
    void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
  };

  /**
   * Сохранение и предъявление — одна цепочка, а не две кнопки с одинаковым телом: предъявить
   * можно только то, что лежит на сервере, и «сохранить, потом отправить» руками означало бы
   * ревизию, разошедшуюся с экраном исполнителя.
   */
  const saveMutation = useMutation({
    mutationFn: async (submit: boolean) => {
      let current = version;
      if (rowsChanged(saved, request!.items)) {
        const stored = await serviceRequestsApi.saveEstimate(request!.id, {
          items: rowsToPayload(saved),
          version: current,
        });
        current = stored.version;
      }
      if (!submit) return { version: current, submitted: false };
      const sent = await serviceRequestsApi.submitEstimate(request!.id, {
        // Формат предъявления — внешний дискриминатор тела (Р2 плана
        // `docs/office-equipment-on-site-and-invoice-estimate-plan.md`), и построчная раскладка
        // называет его прямо. Прежнее `warrantyRepair: false` говорило то же самое отрицанием второго
        // формата, а форматов теперь три: «не гарантийный» перестало быть ответом на вопрос «каким
        // предъявлено».
        mode: 'items',
        comment: comment.trim(),
        version: current,
      });
      return { version: sent.version, submitted: true };
    },
    onSuccess: (result) => {
      setVersion(result.version);
      refresh();
      if (result.submitted) {
        // Не «отправлена»: заявка никуда не уехала — она осталась «В работе» и ждёт подписи (Р8).
        message.success('Объём работ предъявлен на согласование');
        onClose();
      } else {
        message.success('Объём работ сохранён');
      }
    },
    // 409 здесь — обычный ответ: заявку подвинули, пока объём работ набирали. Второй его повод —
    // предъявление, повисшее с чужого экрана: замок гасит кнопки, но между открытием окна и
    // нажатием помещается чужое действие, и объяснение этому даёт уже сервер.
    onError: (e) => message.error(errorMessage(e)),
  });

  /** Гарантийный ремонт (Р27): объём работ из служебной нулевой строки, его собирает сервер. */
  const warrantyMutation = useMutation({
    mutationFn: () =>
      serviceRequestsApi.submitEstimate(request!.id, {
        mode: 'warranty',
        comment: comment.trim(),
        version,
      }),
    onSuccess: () => {
      message.success('Гарантийный ремонт предъявлен без оплаты');
      refresh();
      onClose();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  /**
   * Раскладка по графам (Р2): своя ручка, а не та же с флагом. У «Ведения» нет ни `estimate`, ни
   * `submit`, ни `reopen` — цепочки «сохранить, потом предъявить» ему собрать нечем, — и всё, что
   * нужно сделать с согласованной ревизией, ручка делает сама. Поэтому здесь одно действие и одна
   * кнопка.
   *
   * Состав уходит ЦЕЛИКОМ и безусловно, без сверки с сохранённым: нажатие «Разложить» — решение
   * переиздать документ, и «ничего не изменилось» решает сервер. Сверка `rowsChanged` была бы
   * здесь вредна вдвойне — она молча превратила бы нажатие в бездействие там, где человек ждёт
   * нового предъявления.
   */
  const breakdownMutation = useMutation({
    mutationFn: () =>
      serviceRequestsApi.saveEstimateBreakdown(request!.id, {
        items: rowsToPayload(saved),
        version,
      }),
    onSuccess: (result) => {
      setVersion(result.version);
      refresh();
      message.success('Объём работ разложен по графам');
      onClose();
    },
    // 409 — предъявление висит, 422 — заявка не в «В работе»: оба ответа объясняет сервер словами,
    // и портал их не предугадывает (замок гасит кнопку только по тому, что видно в карточке).
    onError: (e) => message.error(errorMessage(e)),
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

  return {
    rows,
    mode,
    comment,
    setComment,
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
    pending: saveMutation.isPending || warrantyMutation.isPending || breakdownMutation.isPending,
    saving: saveMutation.isPending,
    warrantyPending: warrantyMutation.isPending,
    breakdownPending: breakdownMutation.isPending,
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
      setRows((prev) => (next === 'free' ? toFreeRows(prev) : rowsForSave(prev, 'free')));
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
    submit: (asDraft: boolean) => saveMutation.mutate(!asDraft),
    runWarranty: () => warrantyMutation.mutate(),
    /** Раскладка по графам: полноту так же спрашивает окно — сюда приходит уже проверенное. */
    runBreakdown: () => breakdownMutation.mutate(),
  };
}
