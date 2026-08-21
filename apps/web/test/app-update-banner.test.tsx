import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import type * as SharedLib from '@shared/lib';
import { renderWithUser } from './render';
import { AppUpdateBanner } from '../src/components/AppUpdateBanner';

/**
 * Баннер новой версии приложения: сколько у него действий и где (план
 * `docs/driver-readings-first-plan.md`, Р13 п. 3).
 *
 * В основном портале «Позже» остаётся: там за баннером стоит открытая форма заявки, и перезагрузка
 * по чужому решению стоила бы человеку набранного. В кабинете водителя цена обратная — устаревшая
 * вкладка пишет черновик показаний сама, без сети, и пишет его в прежнем формате, а разбирать
 * расхождение потом придётся переносом чисел руками. Терять при обновлении здесь нечего: введённое
 * лежит в черновике и переживает перезагрузку целиком.
 *
 * Обещание записано в журнале обновлений (миграция 0168): «в кабинете баннер оставляет одно
 * действие». Тест держит именно его — журнал не должен врать.
 */

/*
 * Подменяется ровно проверка версии: она ходит в сеть за `/version.json`, а в dev-сборке не
 * работает вовсе — без подмены `latestBuildId` всегда `null`, и баннера не бывает ни в одном
 * контуре. Остальной слой берётся настоящим, иначе тест проверял бы свои заглушки.
 */
vi.mock('@shared/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof SharedLib>()),
  useVersionCheck: () => ({ latestBuildId: 'build-next' }),
}));

describe('баннер новой версии', () => {
  it('в кабинете водителя оставляет одно действие — «Обновить»', () => {
    renderWithUser(<AppUpdateBanner />, { route: '/driver' });

    expect(screen.getByText('Доступна новая версия приложения')).toBeDefined();
    expect(screen.getByRole('button', { name: /Обновить/u })).toBeDefined();
    // На телефоне в кабине откладывать обновление второй раз некому: «Позже», нажатое однажды,
    // гасит баннер до конца сессии — а вкладка кабинета живёт неделями.
    expect(screen.queryByRole('button', { name: 'Позже' })).toBeNull();
  });

  it('на второй странице кабинета — так же: контур решает адрес, а не экран', () => {
    renderWithUser(<AppUpdateBanner />, { route: '/driver/assignment?date=2026-08-19' });

    expect(screen.queryByRole('button', { name: 'Позже' })).toBeNull();
  });

  it('в основном портале «Позже» остаётся и прячет баннер', () => {
    renderWithUser(<AppUpdateBanner />, { route: '/waste' });

    const later = screen.getByRole('button', { name: 'Позже' });
    fireEvent.click(later);

    expect(screen.queryByText('Доступна новая версия приложения')).toBeNull();
  });
});
