import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { installMatchMedia, resetViewport } from './viewport';

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
});
