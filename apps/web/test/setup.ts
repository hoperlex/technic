import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import dayjs from 'dayjs';
import 'dayjs/locale/ru';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { installMatchMedia, resetViewport } from './viewport';
import { restoreHttpMock } from './http';

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
  // Подменённый сетью тест не должен утаскивать за собой следующие: снимаем мок здесь, а не в
  // самом `mockHttp` — хук, зарегистрированный изнутри `it`, до следующего теста не доживает.
  restoreHttpMock();
});
