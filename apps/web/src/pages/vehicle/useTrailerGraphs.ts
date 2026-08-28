import { useEffect, useRef, useState } from 'react';
import type { FormInstance } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { HitchedTrailerDto } from '@technic/contracts';
import {
  emptyTrailerGraphs,
  hitchedTrailerGraphs,
  MANUAL_TRAILER_MODES,
  sameTrailerGraphs,
  substitutedTrailerModes,
  TRACTOR_TRAILERS_TYPE_CODE,
  type TrailerGraphs,
  trailerGraphsFilled,
  type TrailerSlotMode,
  type TrailerSlotModes,
  trailerSubstitution,
  vehicleTypesForTrailerKey,
} from '@entities/vehicle-route';
import { vehicleTypesApi } from '../../api/resources';

/**
 * Применение правила подстановки прицепа (план `docs/vehicle-trailers-plan.md`, §14, Р20–Р21).
 *
 * Само правило чистое и живёт в сущности (`trailerSubstitution`); здесь — только его применение к
 * живой форме: когда спрашивать, чем считать «своё» и в каком порядке. Вынесено из блока граф не
 * ради длины файла, а потому что это разные предметы: там разметка пары граф, здесь — порядок,
 * на котором работа и ломалась дважды.
 *
 * **Два независимых процесса, а не один.** Графы (подстановка и очистка) не зависят от типа
 * машины вовсе и не ждут справочника типов: живое закрепление не должно стоять из-за медленного
 * или упавшего списка. Галочка тягача (§4.4 (а)) ждёт тип и имеет собственную одноразовую память
 * на машину — иначе восстановившийся после ошибки запрос менял бы отпечаток источника и повторял
 * подстановку, возвращая снятую человеком галочку.
 */
export interface TrailerGraphsHook {
  modes: TrailerSlotModes;
  setMode: (slot: 1 | 2, mode: TrailerSlotMode) => void;
  /** Машина — седельный тягач: этим блок объясняет вставшую саму галочку. */
  isTractor: boolean;
  /**
   * Галочку тронул человек. Взводится **самим чекбоксом**, а не памятью эффекта: пока барьером
   * служило «галочка уже ставилась», случай «справочник типов лежал, человек снял унаследованную
   * галочку, справочник ожил» проходил мимо — память была пуста, и умолчание тягача возвращало
   * галочку поверх решения человека.
   */
  noteWithTrailerTouched: () => void;
}

export function useTrailerGraphs({
  form,
  asks,
  hitched,
  vehicleId,
  vehicleTypeId,
  keepOwnGraphs,
  substituteOnOpen,
  record,
  watched,
}: {
  form: FormInstance;
  /**
   * Блок граф на экране. `false` — бланк выбранной машины прицепа не печатает либо реквизиты
   * выезда у рейса уже свои: графы тогда **очищаются**, а не просто прячутся. Скрытые поля
   * rc-field-form хранит (`preserve`), и полуприцеп прежней машины уехал бы в тело рейса молча —
   * ровно так он и уезжал, пока условие показа стояло в окнах, а очистка жила только здесь.
   */
  asks: boolean;
  hitched?: readonly HitchedTrailerDto[];
  vehicleId?: string | null;
  vehicleTypeId?: string | null;
  keepOwnGraphs: boolean;
  substituteOnOpen: boolean;
  record?: TrailerGraphs | null;
  /** Графы формы, как их видит перерисовка: ими эффект узнаёт, что пора попробовать снова. */
  watched: TrailerGraphs;
}): TrailerGraphsHook {
  /**
   * Режим каждой пары граф (Р17): состояние окна, а не поле формы — в бланке его нет, а рейс
   * помнит графы, а не то, каким движением их заполнили (Р11). Слоты переключаются порознь:
   * закреплённый полуприцеп берут из реестра, а разовый прицеп вписывают руками, и наоборот.
   */
  const [modes, setModes] = useState<TrailerSlotModes>(MANUAL_TRAILER_MODES);
  const setMode = (slot: 1 | 2, mode: TrailerSlotMode) =>
    setModes((prev) => ({ ...prev, [`slot${slot}`]: mode }));

  /**
   * Типы техники — ради одного вопроса: этот тип седельный тягач или нет. Спрашивается справочник
   * целиком, потому что в карточке машины (`VehicleDto`) кода типа нет — есть идентификатор и
   * наименование, а наименование в условии было бы сверкой по написанию. Запрос один на портал:
   * ключ общий, ответ кэшируется, и пять окон делят одну загрузку.
   */
  const { data: tractorTypeIds } = useQuery({
    queryKey: vehicleTypesForTrailerKey,
    queryFn: () => vehicleTypesApi.list({ page: 1, pageSize: 500 }),
    staleTime: 5 * 60 * 1000,
    select: (page) =>
      new Set(page.items.filter((t) => t.code === TRACTOR_TRAILERS_TYPE_CODE).map((t) => t.id)),
  });
  const isTractor = !!vehicleTypeId && !!tractorTypeIds?.has(vehicleTypeId);

  /**
   * Отпечаток закрепления: подстановка повторяется, когда сменилась машина или её состав прицепов,
   * и не повторяется больше никогда. Иначе снятая рукой галочка вставала бы обратно на каждой
   * перерисовке формы — а снимаемой она обязана быть (§4.4). Типа машины в отпечатке нет: он
   * приезжает отдельным запросом, и его появление не повод подставлять заново.
   */
  const signature = (hitched ?? [])
    .map((t) => `${t.position}:${t.id}:${t.model}:${t.registrationNumber}:${t.status}`)
    .join('|');

  /**
   * Графы прицепа, как они лежат в форме прямо сейчас. Читаются, а не берутся из наблюдений:
   * эффект бежит до перерисовки, и наблюдённые значения в нём отстают на коммит.
   */
  const formGraphs = (): TrailerGraphs => ({
    withTrailer: !!form.getFieldValue('withTrailer'),
    trailer1Model: form.getFieldValue('trailer1Model') ?? '',
    trailer1RegNumber: form.getFieldValue('trailer1RegNumber') ?? '',
    trailer2Model: form.getFieldValue('trailer2Model') ?? '',
    trailer2RegNumber: form.getFieldValue('trailer2RegNumber') ?? '',
  });

  /** Ответа сервера ещё нет — отдельным именем: выражение в списке зависимостей линт не проверяет. */
  const hitchedUnknown = hitched === undefined;

  const applied = useRef<string | null>(null);
  /** Машина, которой уже досталась галочка по типу: своя память, отдельная от памяти граф. */
  const tractorApplied = useRef<string | null>(null);
  /** Машина, у которой галочку трогал человек: его решение сильнее умолчания по типу. */
  const tractorTouched = useRef<string | null>(null);
  /** Машина, с которой окно открылось, и признак того, что её меняли: ими живёт `substituteOnOpen`. */
  const openVehicle = useRef<string | null | undefined>(undefined);
  const vehicleChanged = useRef(false);

  /** Общая часть решения: её читают оба эффекта и обязаны читать одинаково. */
  const decide = (): ReturnType<typeof trailerSubstitution> =>
    trailerSubstitution({
      hasHitched: !!hitchedTrailerGraphs(hitched),
      keepOwnGraphs,
      vehicleChanged: vehicleChanged.current,
      withTrailer: formGraphs().withTrailer,
      // Спрятанные графы считаются наравне с видимыми: поля прицепа при снятой галочке уходят со
      // страницы, а значения остаются в форме и доезжают до тела рейса.
      graphsFilled: trailerGraphsFilled(formGraphs()),
      // Тип известен только второму эффекту: первый о нём не спрашивает вовсе.
      isTractor: tractorTypeIds === undefined ? undefined : isTractor,
    });

  // ── Графы: подстановка и очистка ──
  useEffect(() => {
    /*
     * Вопроса нет или машины нет — графы уходят. Оба случая об одном: описывать нечего, а
     * оставленное описывает **чужую** единицу. Сюда же приходит возврат «аренда → своя»: блок
     * монтируется заново с пустой машиной, и старые графы снимаются до выбора новой.
     */
    if (!asks || !vehicleId) {
      applied.current = null;
      tractorApplied.current = null;
      tractorTouched.current = null;
      openVehicle.current = undefined;
      vehicleChanged.current = false;
      // Режим снимается вместе с графами: список, оставшийся открытым над пустой графой, обещал
      // бы выбор, которого не делали.
      setModes(MANUAL_TRAILER_MODES);
      const current = formGraphs();
      if (current.withTrailer || trailerGraphsFilled(current)) {
        form.setFieldsValue(emptyTrailerGraphs());
      }
      return;
    }

    /*
     * Машина, с которой окно открылось, запоминается ПЕРВЫМ делом — до любого выхода из эффекта
     * (Р21). Стояло это ниже, за ожиданием подсказки, и смена машины, сделанная быстрее ответа
     * сервера, проходила незамеченной: `openVehicle` вставал уже на новую единицу, `vehicleChanged`
     * оставался ложным, и коррекция (`substituteOnOpen = false`) не делала ничего — графы прежней
     * машины доезжали до нового бланка.
     */
    if (openVehicle.current === undefined) openVehicle.current = vehicleId;
    else if (vehicleId !== openVehicle.current) vehicleChanged.current = true;

    // Форма ещё не заполнена значениями записи: решать «что рейс уже описал» не по чему (Р21).
    if (record && !vehicleChanged.current && !sameTrailerGraphs(record, formGraphs())) return;
    // Ответа сервера ещё нет: пустых граф это не значит — значит «пока не знаем».
    if (hitchedUnknown) return;

    const source = `${vehicleId}|${signature}`;
    if (applied.current === source) return;
    applied.current = source;

    if (!substituteOnOpen && !vehicleChanged.current) return;

    const graphs = hitchedTrailerGraphs(hitched);
    const action = decide().graphs;
    if (action === 'substitute' && graphs) {
      form.setFieldsValue(graphs);
      // Подстановка включает режим справочника (Р17, пункт 1) — этого и просили: портал повторяет
      // решение, принятое в карточке прицепа, и показывает его тем же списком, каким человек
      // выбрал бы сам. Заодно видно чужое закрепление, если подставленное им и оказалось.
      setModes(substitutedTrailerModes(hitched));
    } else if (action === 'clear') {
      // Закрепления у новой машины нет, а в графах стоит прицеп прежней: пустая графа честнее
      // чужого госномера, который на бумаге читается как правда.
      form.setFieldsValue(emptyTrailerGraphs());
      setModes(MANUAL_TRAILER_MODES);
    }
    /*
     * Зависимости — источник подстановки плюс графы формы. Форма здесь не ради решения (его эффект
     * читает свежим), а ради **повторной попытки**: барьер выше пропускает прогон, пока форма ещё
     * занята прежней записью, и без наблюдения за ней окно, заполнившее форму следующим коммитом,
     * второго прогона не получило бы. Лишних прогонов это не даёт: применённый источник отсекается
     * отпечатком выше, а до него подстановки и не было.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    asks,
    vehicleId,
    signature,
    hitchedUnknown,
    record,
    watched.withTrailer,
    watched.trailer1Model,
    watched.trailer1RegNumber,
    watched.trailer2Model,
    watched.trailer2RegNumber,
  ]);

  // ── Галочка по типу машины ──
  useEffect(() => {
    /*
     * Ждёт две вещи: ответ справочника типов (`isTractor` до него ложен) и ответ подсказки — при
     * живом закреплении галочку ставит сама подстановка, и решение здесь зависит от того, есть оно
     * или нет. Память своя и одноразовая на машину: восстановившийся после ошибки запрос типов
     * повторного прогона не даёт, а снятую человеком галочку никто не возвращает.
     */
    if (!asks || !vehicleId || !isTractor || hitchedUnknown) return;
    if (tractorApplied.current === vehicleId || tractorTouched.current === vehicleId) return;
    tractorApplied.current = vehicleId;
    if (!substituteOnOpen && !vehicleChanged.current) return;
    if (decide().tractorDefault && !form.getFieldValue('withTrailer')) {
      form.setFieldsValue({ withTrailer: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asks, vehicleId, isTractor, hitchedUnknown, signature]);

  return {
    modes,
    setMode,
    isTractor,
    noteWithTrailerTouched: () => {
      tractorTouched.current = vehicleId ?? null;
    },
  };
}
