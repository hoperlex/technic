import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { App, Alert, Skeleton, Space, Typography } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import type { ReportItemDto } from '@technic/contracts';
import { FILE_MAX_COUNT, FILE_MAX_SIZE } from '@shared/config';
import { errorMessage } from '@shared/lib';
import { filesApi } from '../../api/resources';
import { useAuth } from '../../auth/AuthContext';
import { DayFailure, DayFooter, DayLine, DayNotice, DayRows, OrphanList } from './DriverDayView';
import { type TransferMode } from './DriverOrphanBlock';
import { useDriverDate } from './DriverLayout';
import { useAssignment, useAutoOpen, useDayState, usePreviousOf, useReadGate } from './dayState';
import { useKeyboardInset } from './keyboardInset';
import { driverCabinetApi, driverKeys, newIdempotencyKey, type DraftItem } from './api';
import {
  bodyFingerprint,
  draftPrefix,
  legacyDraftKey,
  pendingAttempt,
  readDraft,
  writeDraft,
  type DraftPatch,
  type DraftView,
} from './draftStore';
import {
  emptyItem,
  orphansOf,
  pendingRows,
  seedValues,
  sentTombstones,
  sourceKey,
  transferPatch,
  transferTargets,
  type Orphan,
} from './readingsDraft';
import { buildSubmitBody, submitFailure } from './readingsSubmit';

/**
 * Показания дня — index-страница кабинета (ADR 0103, Р14; план driver-readings-first, Р1, Р4, Р9).
 *
 * Кабинет открывается этой формой, а не заданием: показания — единственное, что водитель в портал
 * ВВОДИТ, и раньше до них добирались нажатием поверх читающего экрана. Задание уехало на
 * `/driver/assignment`, ссылкой из шапки.
 *
 * Страница, а не лист поверх задания: прокрутка своя, «Закрыть» нет — закрывать нечего. Подвал
 * закреплён не ради оформления: показания вводят стоя у машины, клавиатура занимает половину
 * экрана, и кнопка, уехавшая под неё, — несданный день (Р9). Блок — на каждую строку ожидания:
 * состав строк заводит сервер по источникам дня, и портал его не выдумывает.
 *
 * Четыре свойства протокола, которые здесь и держатся (Р2, Р3, Р10–Р14а):
 *
 * 1. **Показанное — это черновик, а не своё состояние.** Поля вычисляются из отчёта и черновика, а
 *    всякая правка идёт записью в хранилище: не записалось — на экране ничего не изменилось.
 *    Второе состояние рядом разъехалось бы с ним на первом же переполнении хранилища.
 * 2. **Порядок жёсткий: собрать → записать → показать → тронуть файлы и сеть** (Р14а п. 5,
 *    Р12а п. 1). Обратный порядок при отказе хранилища даёт худший исход: черновик остался
 *    прежним, а снимок, на который он ссылается, уже удалён — или команда ушла без следа.
 * 3. **Что рисовать и звать ли `open`, решает матрица дня** ([dayState.ts](dayState.ts)), а не
 *    разметка. Там же живёт протокол открытия — задержка, учёт открытых дат, гейт чтений (Р7, Р8):
 *    страница им пользуется, а не владеет.
 * 4. **Отчёт живёт в кэше запроса, а не в состоянии страницы** (Р8): `driverKeys.report(date)` —
 *    единственное место, куда ложатся и ответ `open`, и ответ `submit`. Своя копия рядом
 *    разъехалась бы с ним на первом обновлении по возврату, а строка долга в шапке читает кэш.
 */

/** Отступ под закреплённый подвал: без него кнопка «Передать» накрыла бы последний блок формы. */
const contentStyle: CSSProperties = { display: 'flex', paddingBottom: 72 };

/** До первого чтения хранилища — «черновика нет»; отдельным значением, чтобы не плодить объекты. */
const NO_DRAFT: DraftView = { items: {}, savedAt: null, legacy: [], attempts: [] };

const STORAGE_REFUSED = 'Не хватило места в памяти телефона — ничего не изменено';

export function DriverReadingsPage() {
  const { message } = App.useApp();
  const { user } = useAuth();
  const { date, today } = useDriverDate();
  const queryClient = useQueryClient();
  /** Учётка, а не человек: черновик лежит по ключу «учётка + дата» — телефон бывает общим. */
  const userId = user?.id ?? '';
  const [draft, setDraft] = useState<DraftView>(NO_DRAFT);
  const [errors, setErrors] = useState<Record<string, Record<string, string>>>({});
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const keyboardInset = useKeyboardInset();
  /** Пока `open` или `submit` в полёте, читающие запросы кабинета выключены (Р7). */
  const gate = useReadGate(date);

  /**
   * Задание берётся тем же ключом, которым его читает своя страница: второго запроса не будет. Им
   * же приходят окно записи, состав дня и предыдущие снимки счётчиков — по половине ответов
   * состояния дня нет вовсе, поэтому матрица ждёт обоих.
   */
  const assignment = useAssignment(date, !gate.busy);
  /** Заполненность дня — по тому же чтению, что рисует форму: второго читателя хранилища нет. */
  const filled = Object.keys(draft.items).length > 0 || draft.legacy.length > 0;
  const day = useDayState(date, filled, assignment.data, !gate.busy);
  /** Отчёт живёт в кэше запроса: ответы `open` и `submit` кладутся туда же (Р8). */
  const report = day?.report ?? null;
  /** Показ дня открывает отчёт — с задержкой, по разу на дату и без автоповтора отказа (Р2, Р8). */
  const opening = useAutoOpen(date, day, assignment.data, gate);
  const draftUse = day?.draft ?? 'none'; // как обойтись с локальным введённым (Р10)

  const previousOf = usePreviousOf(assignment.data);

  // Показанное — производное от отчёта и черновика, а не третье состояние рядом с ними.
  const values = useMemo(
    () => (report ? seedValues(report, draftUse === 'edit' ? draft.items : {}) : {}),
    [report, draft, draftUse],
  );
  const orphans = useMemo(() => orphansOf(report, draft), [report, draft]);
  const targets = useMemo(
    () => (report ? transferTargets(report, values, day?.submittable ?? false) : []),
    [report, values, day?.submittable],
  );
  /** Введённое, но не переданное: пометкой рядом со своим блоком, а не вместо чисел учёта (Р10). */
  const pending = useMemo(
    () => pendingRows(report, draftUse === 'aside' ? draft.items : {}),
    [report, draft, draftUse],
  );

  /**
   * День, показанный сейчас. Ref, а не значение замыкания: смена дня страницу не перемонтирует —
   * маршрут тот же, меняется `?date=`, — и поздний промис (аплоад фото, отправка) вернул бы в
   * состояние страницы черновик соседнего дня. В хранилище он пишет по своей дате, и это верно:
   * снимок и правда относится к тому дню. Показать его в другом — неверно: ключ источника у
   * недельного ЭСМ-2 один на несколько дат, и число 19-го уехало бы в отправку за 20-е.
   */
  const shown = useRef(date);
  const stillShown = () => shown.current === date;

  /**
   * Черновик читается сразу, до ответа сервера: введённое вчера не должно ждать сети, чтобы хотя
   * бы показаться блоком «введено, но не привязано» (Р14). Отказы полей снимаются вместе с ним —
   * они относятся к строкам показанного дня, а у соседнего дня строки свои.
   */
  useEffect(() => {
    shown.current = date;
    setErrors({});
    setDraft(readDraft(userId, date));
  }, [date, userId]);

  /**
   * Соседняя вкладка правит тот же день — форма перечитывает черновик и показывает пришедшее
   * (Р11в). Событие спасает не запись, а экран: браузер шлёт его другим вкладкам того же
   * происхождения уже после того, как чужая ветка легла в хранилище.
   */
  useEffect(() => {
    const prefix = draftPrefix(userId, date);
    // Запись прежнего формата, изменённая старой вкладкой, обязана показаться снова (Р11б), а её
    // ключ под этот префикс не подходит: он намеренно другой — потому и спрашивается у хранилища.
    const legacy = legacyDraftKey(userId, date);
    const mine = (key: string) => key.startsWith(prefix) || key === legacy;
    const onStorage = (event: StorageEvent) => {
      // `key === null` — хранилище вычистили целиком: выход из учётной записи в соседней вкладке.
      if (event.key !== null && !mine(event.key)) return;
      setDraft(readDraft(userId, date));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [userId, date]);

  /**
   * Единственный путь правки черновика: сначала хранилище, потом экран. Отказ не глотается — на
   * нём останавливается всё остальное, и человек читает его словами (Р14а п. 5).
   */
  const commit = (patch: DraftPatch): boolean => {
    const written = writeDraft(userId, date, patch).ok;
    // Поздний промис свой день записал, а экрана и сообщений соседнего не трогает (см. `shown`).
    if (!stillShown()) return written;
    if (!written) {
      message.error(STORAGE_REFUSED);
      return false;
    }
    setDraft(readDraft(userId, date));
    return true;
  };

  /** Любая правка сразу ложится в черновик: отправка бывает неудачной, введённое — нет. */
  const update = (item: ReportItemDto, patch: Partial<DraftItem>): boolean => {
    const key = sourceKey(item);
    const next = { ...(values[key] ?? emptyItem()), ...patch };
    if (!commit({ items: [{ key, item: next }] })) return false;
    // Правка снимает отказ со всего блока, а не с одного поля: «заполните хотя бы одно значение»
    // относится к трём полям сразу, и держать его над исправленным блоком значило бы врать.
    if (errors[item.id]) {
      const { [item.id]: _removed, ...rest } = errors;
      setErrors(rest);
    }
    return true;
  };

  const upload = async (item: ReportItemDto, file: File) => {
    const current = values[sourceKey(item)] ?? emptyItem();
    if (current.files.length >= FILE_MAX_COUNT) {
      message.error(`Не более ${FILE_MAX_COUNT} файлов`);
      return;
    }
    if (file.size > FILE_MAX_SIZE) {
      message.error('Файл больше 50 МБ');
      return;
    }
    setUploadingId(item.id);
    try {
      // Из ответа берутся ровно те поля, что нужны черновику: класть в localStorage весь ответ
      // хранилища значило бы держать там лишнее о чужом файле.
      const { id, filename, contentType, size } = await filesApi.upload(file);
      // Не попал в черновик — снимок ничей: ссылки на него нет ни у отправки, ни у экрана.
      if (!update(item, { files: [...current.files, { id, filename, contentType, size }] })) {
        void filesApi.remove(id).catch(() => undefined);
      }
    } catch (e) {
      // Отказ показывается в любом дне: он про файл, а не про день, и промолчать о нём значило бы
      // оставить человека ждать снимка, которого нет.
      message.error(errorMessage(e));
    } finally {
      setUploadingId(null);
    }
  };

  /**
   * Сначала черновик, потом хранилище файлов, и порядок здесь не вкусовой: удали снимок раньше
   * записи — и при переполненном хранилище черновик сошлётся на то, чего уже нет (Р14а п. 5).
   */
  const removeFile = (item: ReportItemDto, fileId: string) => {
    const current = values[sourceKey(item)] ?? emptyItem();
    if (!update(item, { files: current.files.filter((f) => f.id !== fileId) })) return;
    void filesApi.remove(fileId).catch(() => undefined);
  };

  /** Перенос непривязанной записи в строку (Р14а): что именно записать, решает `transferPatch`. */
  const transfer = (orphan: Orphan, targetKey: string, mode: TransferMode) => {
    const { patch, displaced } = transferPatch(orphan, targetKey, mode === 'replace', values);
    if (!commit(patch)) return;
    // И только после успешной записи — файлы, вытесненные заменой: до отправки они ещё ничьи.
    for (const file of displaced) void filesApi.remove(file.id).catch(() => undefined);
    message.success('Перенесено в строку');
  };

  const doSubmit = async () => {
    if (!report) return;
    /*
     * Черновик читается один раз на всю отправку: этим же снимком собирается тело и им же гасятся
     * строки после успеха (Р12). Двумя чтениями — одним в рендере, другим по нажатию — погашено
     * было бы не то, что ушло на сервер: правка, влезшая между ними, стёрлась бы как отправленная.
     */
    const view = readDraft(userId, date);
    const sending = seedValues(report, draftUse === 'edit' ? view.items : {});
    const { items, errors: refused } = buildSubmitBody(report, sending, previousOf);
    setErrors(refused);
    const firstBad = report.items.find((item) => refused[item.id]);
    if (firstBad) {
      // Отказ называет поле и приводит к нему, а не уходит тостом в угол экрана (ADR 0094).
      document.getElementById(`reading-${firstBad.id}`)?.scrollIntoView({ block: 'center' });
      return;
    }
    if (items.length === 0) {
      // Все строки дня закрыл персонал: отправлять нечего, а пустое тело сервер и не примет.
      message.info('Передавать нечего: строки этого дня уже закрыты');
      return;
    }

    /*
     * Ключ идемпотентности принадлежит попытке, а не дню (Р12а). Незавершённая попытка с тем же
     * отпечатком тела — тот самый случай, когда ответ потеряли уже после того, как сервер команду
     * принял: повторяются её исходные ключ и версия, какой бы номер ни лежал в отчёте сейчас —
     * сервер сверяет ключ раньше версии. Новая попытка ложится в черновик ДО запроса: команда,
     * ушедшая без следа, при повторе стала бы второй отправкой того же дня.
     */
    const mark = bodyFingerprint(items);
    const pendingSubmit = pendingAttempt(view, mark);
    const key = pendingSubmit?.key ?? newIdempotencyKey();
    const version = pendingSubmit?.reportVersion ?? report.version;
    if (!pendingSubmit && !commit({ attempt: { key, reportVersion: version, fingerprint: mark } }))
      return;

    setSubmitting(true);
    try {
      // Запрос идёт через гейт (Р7): летящие чтения отчёта отменяются перед ним, а на время полёта
      // выключаются вовсе. Ответ ложится в кэш ВНУТРИ полёта — иначе между открытием гейта и
      // записью влезло бы чтение «до отправки», то есть гарантированный 409 на следующей.
      await gate.run(async () => {
        const dto = await driverCabinetApi.submit(date, { version, items }, key);
        queryClient.setQueryData(driverKeys.report(date), dto);
      });
      /*
       * Страница после отправки живёт дальше — и обязана сама стать «днём после отправки» (Р12):
       * прежде это делало закрытие листа. Отчёт заменён ответом строкой выше, попытка гасится,
       * отправленные строки гасятся надгробиями, введённое пересобирается из ответа. Гасятся
       * только строки, не изменившиеся с момента снимка: пока запрос был в пути, строку могли
       * переписать — такая правка сделана позже отправленной, остаётся значением и уйдёт
       * следующей попыткой, со своим ключом.
       */
      const sentIds = new Set(items.map((entry) => entry.itemId));
      commit({ items: sentTombstones(report, sentIds, view), close: { key, state: 'succeeded' } });
      // Точечно, а не корневой инвалидацией (Р8): корень унёс бы с собой и `report(date)` — тот
      // самый ключ, куда только что лёг ответ отправки. Заданию перечитаться есть зачем — в нём
      // живут предыдущие снимки счётчиков, а отправка их и меняет.
      await queryClient.invalidateQueries({ queryKey: driverKeys.assignment(date) });
      if (stillShown()) message.success('Показания переданы');
    } catch (e) {
      // Исход, названный самим API, закрывает попытку; обрыв и отказ шлюза оставляют её `pending`:
      // там сервер мог команду и принять, и повтор обязан уйти тем же ключом (Р12а).
      const failed = submitFailure(e);
      if (stillShown()) message.error(failed.message);
      if (failed.settled) commit({ close: { key, state: 'rejected' } });
      /*
       * Строки перечитываются чтением, а не `open`: тот берёт блокировки машин, отчёта и источников
       * ДО проверки состояния и по принятому или аннулированному дню бил бы тяжёлой транзакцией
       * впустую (Р2). Отказ чтения не глотается: отчёт со старой версией, оставшийся в кэше, дал бы
       * следующей отправке тот же 409 — снимок объявляется устаревшим, и чтение уйдёт само.
       */
      if (failed.stale)
        await gate
          .run(async () =>
            queryClient.setQueryData(driverKeys.report(date), await driverCabinetApi.report(date)),
          )
          .catch(() => queryClient.invalidateQueries({ queryKey: driverKeys.report(date) }));
    } finally {
      setSubmitting(false);
    }
  };

  // Отказ задания — сообщением, а не «заданий нет»: обрыв связи и пустой день разные новости.
  const failure = opening.error ?? (assignment.isError ? errorMessage(assignment.error) : null);
  /** Вторая страница того же дня (Р5): сегодняшняя без параметра — такая ссылка не устареет. */
  const assignmentHref = `/driver/assignment${date === today ? '' : `?date=${date}`}`;
  /**
   * Введённое, не сопоставившееся со строкой, показывается в любом состоянии дня — и при отказе
   * открытия тоже (Р14): в офлайне это его единственная копия, и прятать её за «не удалось
   * открыть день» значило бы потерять набранное вместе с сетью.
   */
  const orphanBlocks = <OrphanList orphans={orphans} targets={targets} onTransfer={transfer} />;

  return (
    <>
      <Space direction="vertical" size={12} style={contentStyle}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          {`Показания за ${dayjs(date).format('D MMMM')}`}
        </Typography.Title>
        {failure ? (
          <>
            {/* «Повторить» — только у отказа открытия: перечитать задание портал умеет сам, а
                повторять `open` без просьбы человека не станет (Р8). */}
            <DayFailure message={failure} onRetry={opening.error ? opening.retry : null} />
            {orphanBlocks}
          </>
        ) : !day ? (
          <Skeleton active paragraph={{ rows: 8 }} />
        ) : day.notice ? (
          <>
            <DayNotice day={day} href={assignment.data?.entries.length ? assignmentHref : null} />
            {orphanBlocks}
          </>
        ) : !report ? (
          <Skeleton active paragraph={{ rows: 8 }} />
        ) : (
          <>
            <DayLine day={day} />
            {report.items.length === 0 && day.submittable && (
              // Отчёт без строк — день без источников: рейсы отменили после того, как задание
              // показали. В читающем дне причину называет подвал — повторять её здесь незачем.
              <Alert
                type="info"
                showIcon
                message="За этот день передавать нечего: выездов не осталось"
              />
            )}
            <DayRows
              report={report}
              values={values}
              previousOf={previousOf}
              errors={errors}
              uploadingId={uploadingId}
              // Читающий режим — свойство блока, а не подвала (Р10): иначе водитель правит
              // принятый день, а отказ приходит с сервера, когда всё уже набрано.
              readOnly={!day.submittable}
              pending={pending}
              onChange={update}
              onUpload={(item, file) => void upload(item, file)}
              onRemoveFile={removeFile}
            />
            {orphanBlocks}
          </>
        )}
      </Space>
      {/* Кнопка «Передать» живёт в подвале, а причина, по которой её нет, — там же (Р4, Р10).
          Состояние дня решает не меньше состава: пока оно неизвестно, кнопка ждёт. */}
      <DayFooter
        day={day}
        inset={keyboardInset}
        submitting={submitting}
        disabled={!report || report.items.length === 0 || !day?.submittable}
        onSubmit={() => void doSubmit()}
      />
    </>
  );
}
