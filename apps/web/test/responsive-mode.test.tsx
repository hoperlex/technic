import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import {
  MOBILE_ROOT_CLASS,
  useIsMobile,
  useMobileRootClass,
} from '../src/hooks/useIsMobile';
import { theme, themeFor } from '../src/theme';
import { DESKTOP_VIEWPORT, MOBILE_VIEWPORT, setViewport, type Viewport } from './viewport';

function Probe() {
  const isMobile = useIsMobile();
  useMobileRootClass(isMobile);
  return <span data-testid="mode">{isMobile ? 'mobile' : 'desktop'}</span>;
}

function mode(): string {
  return screen.getByTestId('mode').textContent ?? '';
}

/** Вьюпорт выставляется до рендера: хук читает режим сразу, а не после первого эффекта. */
function renderAt(viewport: Viewport) {
  setViewport(viewport);
  return render(<Probe />);
}

describe('режим устройства (ADR 0030)', () => {
  it('узкое окно с мышью остаётся десктопом', () => {
    renderAt({ width: 600, pointer: 'fine' });
    expect(mode()).toBe('desktop');
  });

  it('планшет 1024 с касанием — мобильный (граница включительная)', () => {
    renderAt({ width: 1024, pointer: 'coarse' });
    expect(mode()).toBe('mobile');
  });

  it('касание шире границы — десктоп', () => {
    renderAt({ width: 1025, pointer: 'coarse' });
    expect(mode()).toBe('desktop');
  });

  it('телефон в ландшафте — мобильный', () => {
    renderAt({ width: 844, pointer: 'coarse' });
    expect(mode()).toBe('mobile');
  });

  it('смена вьюпорта переключает режим без перемонтирования', () => {
    renderAt(MOBILE_VIEWPORT);
    expect(mode()).toBe('mobile');

    act(() => setViewport(DESKTOP_VIEWPORT));
    expect(mode()).toBe('desktop');

    act(() => setViewport(MOBILE_VIEWPORT));
    expect(mode()).toBe('mobile');
  });
});

describe('класс мобильного режима', () => {
  it('появляется на <html> и снимается вместе с режимом', () => {
    renderAt(MOBILE_VIEWPORT);
    expect(document.documentElement.classList.contains(MOBILE_ROOT_CLASS)).toBe(true);

    act(() => setViewport(DESKTOP_VIEWPORT));
    expect(document.documentElement.classList.contains(MOBILE_ROOT_CLASS)).toBe(false);
  });

  it('на десктопе не ставится вовсе', () => {
    renderAt(DESKTOP_VIEWPORT);
    expect(document.documentElement.classList.contains(MOBILE_ROOT_CLASS)).toBe(false);
  });
});

describe('тема', () => {
  it('на десктопе — тот же объект, что и до появления мобильной версии', () => {
    expect(themeFor(false)).toBe(theme);
  });

  it('на мобильном — крупнее шрифт и элементы управления, цвета те же', () => {
    const mobile = themeFor(true);
    expect(mobile).not.toBe(theme);
    expect(mobile.token?.fontSize).toBe(16);
    expect(mobile.token?.controlHeight).toBe(40);
    expect(mobile.token?.colorPrimary).toBe(theme.token?.colorPrimary);
  });

  it('мобильная тема собирается один раз', () => {
    expect(themeFor(true)).toBe(themeFor(true));
  });
});
