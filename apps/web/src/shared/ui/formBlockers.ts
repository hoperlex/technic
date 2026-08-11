import { useCallback, useMemo, useRef, useState } from 'react';
import type { FormInstance, FormProps } from 'antd';
import { errorFields } from '@shared/lib';

/**
 * Причины отказа по именам полей формы: `{ vehicleId: 'Выберите технику' }`. Пустое значение —
 * поле в порядке, поэтому проверки можно писать одним объектом без ветвлений.
 */
export type FormBlockerReasons = Record<string, string | false | null | undefined>;

/** Имя поля в том виде, в каком его понимает форма (строка или путь). */
type FieldName = Parameters<FormInstance['scrollToField']>[0];

export interface FormBlockersApi {
  /** Раскладывается в `<Form>`: перехват отказа по правилам, снятие пометок и класс вспышки. */
  formProps: Pick<FormProps, 'onFinishFailed' | 'onValuesChange' | 'className'>;
  /**
   * Пометить поля причинами — для проверок, которые правилами не выражены и живут в `onFinish`.
   * Возвращает `true`, если хоть одна причина есть: `if (blockers.raise({…})) return;`.
   */
  raise: (reasons: FormBlockerReasons) => boolean;
  /**
   * Ошибки полей из ответа сервера. Возвращает `true`, если хоть одна легла на форму, — тогда
   * тост не нужен, человек уже видит поле.
   */
  fromApi: (error: unknown, alias?: Record<string, string>) => boolean;
}

interface Options {
  /**
   * Своё слежение за изменениями. Окно, у которого `onValuesChange` уже есть, передаёт его сюда:
   * снятие пометок тоже живёт в этом обработчике, и два одноимённых пропса затёрли бы друг друга.
   */
  onValuesChange?: FormProps['onValuesChange'];
}

/**
 * Прокрутка к первому блокеру. `always` вместо антовского `if-needed`: на шите телефона кнопки
 * закреплены поверх низа тела, и поле, «видимое» с самого края, на деле закрыто ими.
 */
const SCROLL = {
  scrollMode: 'always',
  block: 'center',
  behavior: 'smooth',
  focus: true,
} as const;

/**
 * Единый вид отказа формы (ADR 0094): поле красное, под ним причина, экран прокручен к первому
 * блокеру, поля-блокеры дают вспышку.
 *
 * Источников отказа три, и раньше каждый вёл себя по-своему: правила `Form.Item` красили поле, но
 * никуда не прокручивали; проверки внутри `onFinish` показывали тост, не помечая поле вовсе;
 * ошибки полей с сервера красили поле молча. Здесь у всех трёх один выход, поэтому и поведение
 * одно.
 *
 * Порядок причин в объекте задаёт, к какому полю поедет экран: первое непустое. Проверки в окне
 * пишутся сверху вниз по форме, так что первым оказывается верхнее поле, как и у правил.
 */
export function useFormBlockers(form: FormInstance, options: Options = {}): FormBlockersApi {
  const { onValuesChange } = options;
  const [flash, setFlash] = useState(0);
  /**
   * Поля, помеченные руками. Правила поле перепроверяют сами и пометку снимают, а поле без правил
   * — нет ([@rc-component/form] валидирует на изменение только при непустых `rules`), и красным
   * оно осталось бы до следующего нажатия кнопки, даже когда человек уже всё исправил.
   */
  const raised = useRef(new Set<string>());

  const showFirst = useCallback(
    (first: FieldName | undefined) => {
      setFlash((n) => n + 1);
      if (first === undefined) return;
      // Следующим кадром: подстрочники с причинами ещё не отрисованы, и поле уехало бы мимо на
      // их высоту — тем заметнее, чем больше блокеров выше него.
      requestAnimationFrame(() => form.scrollToField(first, SCROLL));
    },
    [form],
  );

  const raise = useCallback(
    (reasons: FormBlockerReasons) => {
      const entries = Object.entries(reasons).filter(([, reason]) => !!reason) as [
        string,
        string,
      ][];
      if (entries.length === 0) return false;
      form.setFields(entries.map(([name, error]) => ({ name, errors: [error] })));
      entries.forEach(([name]) => raised.current.add(name));
      showFirst(entries[0]![0]);
      return true;
    },
    [form, showFirst],
  );

  const fromApi = useCallback(
    (error: unknown, alias: Record<string, string> = {}) => {
      const fields = errorFields(error);
      if (!fields) return false;
      // Ошибку показывает только то поле, которое в форме есть: сервер проверяет и то, чего в
      // окне не рисуют, и такая пометка потерялась бы молча — про неё говорит тост.
      //
      // Спрашивается список полей, а не значения: незаполненное поле в значениях формы вообще не
      // лежит, и проверка по ним теряла бы ровно те ошибки, которые сервер и шлёт чаще всего.
      const known = new Set(form.getFieldsError().map(({ name }) => String(name[0])));
      const reasons: FormBlockerReasons = {};
      for (const [path, message] of Object.entries(fields)) {
        // zod присылает путь вида `vehicles.0.volumeM3`; поле формы — верхний сегмент.
        const name = alias[path] ?? path.split('.')[0]!;
        if (known.has(name) && !reasons[name]) reasons[name] = message;
      }
      return raise(reasons);
    },
    [form, raise],
  );

  const formProps = useMemo(
    () => ({
      onFinishFailed: ({ errorFields: failed }: { errorFields: { name: FieldName }[] }) => {
        showFirst(failed[0]?.name);
      },
      onValuesChange: (changed: Record<string, unknown>, all: Record<string, unknown>) => {
        if (raised.current.size > 0) {
          const cleared = Object.keys(changed).filter((name) => raised.current.delete(name));
          if (cleared.length > 0) {
            form.setFields(cleared.map((name) => ({ name, errors: [] })));
          }
        }
        onValuesChange?.(changed, all);
      },
      /**
       * Классы чередуются, а наборы кадров у них разные при одинаковом теле: браузер
       * перезапускает анимацию только при смене `animation-name`, и повторное нажатие кнопки с
       * тем же блокером иначе не дало бы никакой вспышки — то есть выглядело бы как «кнопка не
       * работает». До первого отказа вариант не выставлен: показ уже помеченного поля при
       * открытии окна — не отказ.
       */
      className: `form-blockers${flash === 0 ? '' : flash % 2 === 1 ? ' form-blockers--a' : ' form-blockers--b'}`,
    }),
    [flash, form, onValuesChange, showFirst],
  );

  return { formProps, raise, fromApi };
}
