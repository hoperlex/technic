import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import dayjs from 'dayjs';
import 'dayjs/locale/ru';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { installMatchMedia, resetViewport } from './viewport';
import { restoreContentHeights } from './clamp';
import { restoreHttpMock } from './http';
import { resetCaptcha } from './captcha';
import { __resetAuthForTests } from '../src/auth/AuthContext';
import { __resetSessionForTests } from '../src/shared/api';

// Даты портал показывает в МСК (utils/format), а плагины dayjs подключает точка входа — в тестах
// её нет, и без этих трёх строк любой рендер с датой падает на `dayjs(...).tz is not a function`.
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.locale('ru');
dayjs.tz.setDefault('Europe/Moscow');

// jsdom не реализует ни того, ни другого, а antd опирается на оба: без заглушек падает любой
// рендер компонента с выпадающим списком. matchMedia к тому же управляемый — им же тесты
// переключают режим устройства (см. ./viewport и ADR 0030).
installMatchMedia();

// Прокрутка к полю-блокеру (ADR 0094) зовёт `element.scroll`, которого в jsdom нет вовсе: без
// заглушки любой тест на отказ формы падал бы не на смысле, а на отсутствующем методе. Проверять
// саму прокрутку в jsdom всё равно нельзя — размеры там нулевые, поэтому тесты следят за вызовом
// `scrollToField`, а не за положением экрана.
if (!Element.prototype.scroll) {
  Element.prototype.scroll = () => {};
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

afterEach(() => {
  cleanup();
  resetViewport();
  /*
   * Состояние сессии живёт в модулях (токен, висящее обновление, чья сессия в кэше) и переживает
   * размонтирование дерева. Не сбросив его, второй тест файла начинал бы с чужой сессии — и
   * падал бы он, а не тот, кто её оставил.
   */
  __resetAuthForTests();
  __resetSessionForTests();
  /*
   * Капча тоже живёт вне дерева: ключ на вкладку и промис скрипта лежат в модулях, объект службы
   * Яндекса и тег `captcha.js` — в документе, подменённая навигация — в `window`. Не сняв это,
   * тест «скрипта в документе нет» проверял бы чужой тег, а тест выключенной капчи — чужой ключ
   * (см. ./captcha).
   */
  resetCaptcha();
  // Подменённый сетью тест не должен утаскивать за собой следующие: снимаем мок здесь, а не в
  // самом `mockHttp` — хук, зарегистрированный изнутри `it`, до следующего теста не доживает.
  restoreHttpMock();
  // По той же причине снимается подмена высот, которой проверяют свёрнутые ячейки: она стоит на
  // прототипе элемента и пережила бы тест, который её ставил (см. ./clamp).
  restoreContentHeights();
  /*
   * Хранилище браузера в jsdom одно на файл: свёрнутость меню, черновики водителя и наборы
   * отборов списков (ADR 0139) переживают размонтирование дерева. Не вычистив его, второй тест
   * файла открывал бы список с отборами, которые выставил первый, — и падал бы он, а не тот, кто
   * их оставил.
   */
  localStorage.clear();
});
