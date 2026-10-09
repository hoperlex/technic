import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ExpandableCell } from '../src/shared/ui/ExpandableCell';

const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');

function setMeasuredHeights() {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 20,
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      return (this as HTMLElement).textContent!.length > 40 ? 100 : 20;
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalScrollHeight) {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight);
  } else {
    delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
  }
  if (originalClientHeight) {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight);
  } else {
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  }
});

describe('ExpandableCell observers', () => {
  it('keeps one observer pair through rerenders and notices text changes inside a clamped cell', async () => {
    setMeasuredHeights();
    let resizeCreates = 0;
    let resizeDisconnects = 0;
    let mutationCreates = 0;
    let mutationDisconnects = 0;
    const mutationOptions: MutationObserverInit[] = [];
    const NativeMutationObserver = globalThis.MutationObserver;

    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor() {
          resizeCreates++;
        }
        observe() {}
        disconnect() {
          resizeDisconnects++;
        }
      },
    );
    vi.stubGlobal(
      'MutationObserver',
      class extends NativeMutationObserver {
        constructor(callback: MutationCallback) {
          super(callback);
          mutationCreates++;
        }
        override observe(target: Node, options?: MutationObserverInit) {
          mutationOptions.push(options ?? {});
          super.observe(target, options);
        }
        override disconnect() {
          mutationDisconnects++;
          super.disconnect();
        }
      },
    );

    const { rerender, unmount } = render(
      <ExpandableCell>
        <span>Short text</span>
      </ExpandableCell>,
    );
    expect(resizeCreates).toBe(1);
    expect(mutationCreates).toBe(1);
    expect(mutationOptions).toEqual([{ subtree: true, characterData: true, childList: true }]);
    expect(screen.queryByRole('button')).toBeNull();

    rerender(
      <ExpandableCell>
        <span>Short text</span>
      </ExpandableCell>,
    );
    expect(resizeCreates).toBe(1);
    expect(mutationCreates).toBe(1);

    await act(async () => {
      rerender(
        <ExpandableCell>
          <span>Long contact details that clearly overflow this two-line cell</span>
        </ExpandableCell>,
      );
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Показать полностью' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Показать полностью' }));
    expect(screen.getByRole('button', { name: 'Свернуть' })).toBeDefined();
    await act(async () => {
      rerender(<ExpandableCell>Short text</ExpandableCell>);
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Свернуть' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Свернуть' }));
    expect(screen.queryByRole('button')).toBeNull();
    expect(resizeCreates).toBe(1);
    expect(mutationCreates).toBe(1);

    unmount();
    expect(resizeDisconnects).toBe(1);
    expect(mutationDisconnects).toBe(1);
  });
});
