import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Space, Spin, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useCaptcha } from './useCaptcha';

/*
 * Типы SDK Яндекса объявлены здесь: `captcha.js` подключается тегом скрипта и типов с собой не
 * несёт. Описано ровно то, чем пользуется портал, — остальное у сервиса есть, но выдумывать
 * сигнатуры, которые мы не зовём, значило бы завести вторую, неверную документацию.
 */

/** События виджета, на которые подписывается портал. */
type SmartCaptchaEvent = 'success' | 'token-expired' | 'network-error' | 'javascript-error';

interface SmartCaptchaApi {
  /** Рисует виджет в контейнере и возвращает его идентификатор — им адресуются reset и destroy. */
  render(container: HTMLElement, params: { sitekey: string; hl?: string }): number;
  /** Подписка возвращает функцию отписки. */
  subscribe(widgetId: number, event: 'success', handler: (token: string) => void): () => void;
  subscribe(
    widgetId: number,
    event: Exclude<SmartCaptchaEvent, 'success'>,
    handler: () => void,
  ): () => void;
  reset(widgetId?: number): void;
  destroy(widgetId?: number): void;
}

declare global {
  interface Window {
    smartCaptcha?: SmartCaptchaApi;
    /** Колбэк готовности: его имя стоит в query скрипта (`?render=onload&onload=…`). */
    onSmartCaptchaLoaded?: () => void;
  }
}

/** Имя колбэка готовности — одно на документ, потому что скрипт тоже один. */
const READY_CALLBACK = 'onSmartCaptchaLoaded';
const SCRIPT_SRC = `https://smartcaptcha.cloud.yandex.ru/captcha.js?render=onload&onload=${READY_CALLBACK}`;
/**
 * Потолок ожидания скрипта. Без него `onerror` спасает только от явного отказа сети: при
 * «висящем» соединении или молчаливой блокировке скрипта расширением промис не разрешился бы
 * никогда, и поле осталось бы со спиннером навсегда — а форма заблокированной.
 */
const SCRIPT_TIMEOUT_MS = 10_000;
/**
 * Место под виджет резервируется заранее: чекбокс SmartCaptcha приезжает через сеть, и без
 * заданной высоты форма подпрыгивает у человека под курсором в момент загрузки.
 */
const WIDGET_HEIGHT = 102;

/**
 * Загрузка `captcha.js` — один тег на документ (промис-синглтон): три формы за сессию делят один
 * скрипт, да и повторная вставка того же URL сервисом не рассчитана.
 *
 * **При reject синглтон сбрасывается.** Иначе один краткий сбой сети держал бы вкладку без капчи
 * до перезагрузки страницы: кнопка «Загрузить заново» ходила бы в тот же навсегда отказавший промис.
 */
let scriptPromise: Promise<SmartCaptchaApi> | null = null;

function loadCaptchaScript(): Promise<SmartCaptchaApi> {
  // Скрипт мог уже отработать, а промис — сброситься после чужого таймаута: тогда грузить нечего.
  if (window.smartCaptcha) return Promise.resolve(window.smartCaptcha);
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<SmartCaptchaApi>((resolve, reject) => {
    const script = document.createElement('script');
    const fail = (reason: string) => {
      scriptPromise = null;
      script.remove();
      reject(new Error(reason));
    };
    const timer = window.setTimeout(
      () => fail('SmartCaptcha не загрузилась вовремя'),
      SCRIPT_TIMEOUT_MS,
    );

    window[READY_CALLBACK] = () => {
      window.clearTimeout(timer);
      const api = window.smartCaptcha;
      // Скрипт выполнился, а объекта нет — считаем это отказом: рисовать нечем, и молчаливое
      // ожидание здесь хуже честной ошибки с кнопкой.
      if (!api) {
        fail('SmartCaptcha загрузилась без API');
        return;
      }
      resolve(api);
    };

    script.src = SCRIPT_SRC;
    script.async = true;
    script.onerror = () => {
      window.clearTimeout(timer);
      fail('SmartCaptcha не загрузилась');
    };
    document.head.append(script);
  });
  return scriptPromise;
}

/** Тестам: «скрипт на этой вкладке ещё не грузили». */
export function __resetCaptchaScriptForTests(): void {
  scriptPromise = null;
}

interface Props {
  /**
   * Токен проверки. Заполняется antd `Form.Item` — компонент работает обычным контролом, но
   * значение ведёт виджет: сам портал в токен не пишет и его не читает, хранит форма.
   */
  value?: string;
  onChange?: (token: string) => void;
  /** Приходит от `Form.Item`; вешается на контейнер, иначе подпись формы ни с чем не связана. */
  id?: string;
  /**
   * Счётчик, по изменению которого виджет сбрасывается. Нужен форме: токен одноразовый, и после
   * обработанной попытки отправки — удачной или отклонённой — он уже потрачен.
   */
  resetToken?: number;
}

/** Что происходит с самим виджетом; состояние конфига живёт отдельно, в `useCaptcha`. */
type WidgetPhase = 'loading' | 'ready' | 'error';

/**
 * Поле капчи: чекбокс Yandex SmartCaptcha (ADR 0130 взамен собственной картинки из ADR 0034).
 * Разгадывание целиком на стороне сервиса, порталу достаётся одноразовый токен, а решение
 * «пройдена ли проверка» принимает сервер — здесь его не имитируем.
 *
 * Виджет обычный, с чекбоксом, а не `invisible`: при отказе есть куда повесить объяснение, и сбои
 * видно человеку, а не только логам.
 */
export function CaptchaField({ onChange, id, resetToken = 0 }: Props) {
  const captcha = useCaptcha();
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<number | null>(null);
  const [phase, setPhase] = useState<WidgetPhase>('loading');
  const [widgetError, setWidgetError] = useState<string | null>(null);
  // Счётчик «Загрузить заново»: меняясь, пересобирает виджет с нуля.
  const [reloads, setReloads] = useState(0);

  // onChange от antd пересоздаётся на каждый рендер; в зависимостях эффекта он пересобирал бы
  // виджет после каждого ввода в форме.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const status = captcha.status;
  const clientKey = captcha.status === 'enabled' ? captcha.clientKey : null;

  useEffect(() => {
    // Скрипт грузится только при `enabled`: при `loading` сессия ещё не известна, при `disabled`
    // капчи нет вовсе, при `error` — грузить нечем. Сторонний код в документ попадает ровно тогда,
    // когда без него не обойтись.
    if (clientKey === null) return;
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let widgetId: number | null = null;
    const unsubscribes: Array<() => void> = [];
    setPhase('loading');
    setWidgetError(null);

    loadCaptchaScript()
      .then((api) => {
        // Размонтировались (или сменился ключ), пока грузился скрипт — рисовать уже некуда.
        if (cancelled) return;
        widgetId = api.render(container, { sitekey: clientKey, hl: 'ru' });
        widgetIdRef.current = widgetId;

        unsubscribes.push(
          api.subscribe(widgetId, 'success', (token) => {
            setWidgetError(null);
            onChangeRef.current?.(token);
          }),
          // Токен одноразовый и живёт минуты: просроченный обнуляем сразу, иначе форма отправила бы
          // заведомо отклонённую проверку и человек получил бы отказ на ровном месте.
          api.subscribe(widgetId, 'token-expired', () => onChangeRef.current?.('')),
          api.subscribe(widgetId, 'network-error', () => {
            onChangeRef.current?.('');
            setWidgetError('Проверка не отвечает — похоже, пропала связь.');
          }),
          /*
           * Сбой внутри самого виджета. Токен при этом НИКОГДА не считается полученным: документация
           * SmartCaptcha запрещает это прямо и требует сообщить о проблеме пользователю в
           * интерфейсе. Обратное («скрипт сломался — пропустим») превратило бы капчу в такую,
           * которую отключает любой клиент, и защиту регистрации в декорацию.
           */
          api.subscribe(widgetId, 'javascript-error', () => {
            onChangeRef.current?.('');
            setWidgetError('Проверка сломалась.');
          }),
        );
        setPhase('ready');
      })
      .catch(() => {
        if (!cancelled) setPhase('error');
      });

    return () => {
      cancelled = true;
      for (const off of unsubscribes) off();
      widgetIdRef.current = null;
      // Виджет живёт в DOM вне React: не сняв его, при следующем монтировании получим два чекбокса
      // в одном контейнере.
      if (widgetId !== null) window.smartCaptcha?.destroy(widgetId);
    };
  }, [clientKey, reloads]);

  /*
   * Сброс по требованию формы. Сравнение с прошлым значением, а не `resetToken !== 0`: эффект
   * срабатывает и на монтировании, где сбрасывать нечего, и лишний `reset()` погасил бы только что
   * поставленную человеком галочку.
   */
  const lastResetRef = useRef(resetToken);
  useEffect(() => {
    if (lastResetRef.current === resetToken) return;
    lastResetRef.current = resetToken;
    const widgetId = widgetIdRef.current;
    if (widgetId === null) return;
    window.smartCaptcha?.reset(widgetId);
    onChangeRef.current?.('');
  }, [resetToken]);

  // Капча выключена (`clientKey: null`) — поля нет совсем, и скрипт Яндекса в документ не попадает.
  if (status === 'disabled') return null;

  // Конфиг ещё не получен (или ещё не известна сессия вкладки): место под виджет занято, чтобы
  // форма не прыгала, когда он приедет.
  if (status === 'loading') {
    return (
      <Placeholder id={id}>
        <Spin size="small" />
      </Placeholder>
    );
  }

  // Ручка портала не ответила или ответила не тем. Виджет не рисуем и капчу выключенной не
  // считаем: что требуется серверу, портал сейчас не знает — отправку блокируют формы.
  if (status === 'error') {
    return (
      <Placeholder id={id}>
        <Space orientation="vertical" size={4} align="center">
          <Typography.Text type="danger">Проверка не загрузилась.</Typography.Text>
          <Button size="small" icon={<ReloadOutlined />} onClick={captcha.retry}>
            Повторить
          </Button>
        </Space>
      </Placeholder>
    );
  }

  return (
    <Space orientation="vertical" size={8} style={{ width: '100%' }}>
      <div style={{ position: 'relative', minHeight: WIDGET_HEIGHT }}>
        {/*
          Контейнер виджета: детей у него нет и быть не должно — содержимое создаёт скрипт Яндекса,
          и React, взявшись согласовывать чужие узлы, снёс бы их при первом же рендере. `id` от
          формы стоит здесь, чтобы подпись поля указывала на живой элемент.
          Уведомление об обработке данных («щит» SmartCaptcha) не скрываем: этого требует
          документация сервиса, и своего текста взамен у портала нет.
        */}
        <div id={id} ref={containerRef} />
        {phase === 'loading' ? (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Spin size="small" />
          </div>
        ) : null}
      </div>
      {phase === 'error' || widgetError ? (
        <Space size={8} align="center" wrap>
          <Typography.Text type="danger">
            {widgetError ?? 'Проверка от Яндекса не загрузилась.'}
          </Typography.Text>
          <Button size="small" icon={<ReloadOutlined />} onClick={() => setReloads((n) => n + 1)}>
            Загрузить заново
          </Button>
        </Space>
      ) : null}
    </Space>
  );
}

/** Место под виджет тех же размеров: без него форма прыгает на каждой смене состояния капчи. */
function Placeholder({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <div
      id={id}
      style={{
        minHeight: WIDGET_HEIGHT,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {children}
    </div>
  );
}
