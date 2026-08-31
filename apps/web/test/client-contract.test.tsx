import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen } from '@testing-library/react';
import type * as SharedLib from '@shared/lib';
import {
  CLIENT_BUILD_HEADER,
  CLIENT_CONTRACT,
  CLIENT_CONTRACT_HEADER,
  __resetClientContractForTests,
  apiFetch,
  isClientUpgradeRequired,
  refresh,
} from '@shared/api';
import { renderWithUser } from './render';
import { AppUpdateBanner } from '../src/components/AppUpdateBanner';

/**
 * Гейт минимальной версии клиента со стороны портала (ADR 0146, решение 7; план
 * `docs/office-equipment-consumables-and-purchase-plan.md`, Р8).
 *
 * Две проверки, и обе про то, чего нельзя увидеть глазами. Первая — что заголовки уходят из **обеих**
 * дверей: через `http.ts` идут не все запросы, обновление сессии зовёт `fetch` напрямую, и
 * заголовок, поставленный в одной обёртке, до второй не доезжает. Вторая — что отказ `426` поднимает
 * ТРЕБОВАНИЕ обновиться, а не предложение: у нынешнего баннера есть «Позже», и вкладка с ним живёт
 * сколько угодно.
 */

/*
 * Подменяется ровно проверка версии — она ходит в сеть за `/version.json` и в dev-сборке не
 * работает вовсе. Здесь она нужна включённой: только тогда видно, что требование обновиться гасит
 * обычный баннер, а не встаёт рядом с ним.
 */
vi.mock('@shared/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof SharedLib>()),
  useVersionCheck: () => ({ latestBuildId: 'build-next' }),
}));

interface SentRequest {
  url: string;
  headers: Record<string, string>;
}

/** Подменяет сеть одним ответом на всё и записывает, что ушло. */
function stubFetch(response: { status: number; body?: unknown }): SentRequest[] {
  const sent: SentRequest[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    sent.push({ url, headers: { ...((init?.headers as Record<string, string>) ?? {}) } });
    const payload = response.body === undefined ? null : JSON.stringify(response.body);
    return new Response(payload, {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
  __resetClientContractForTests();
});

describe('заголовки версии клиента', () => {
  it('уходят из транспорта — из него идёт всё, кроме обновления сессии', async () => {
    const sent = stubFetch({ status: 200, body: { ok: true } });

    await apiFetch('/service-requests');

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toContain('/api/v1/service-requests');
    expect(sent[0]!.headers[CLIENT_CONTRACT_HEADER]).toBe(String(CLIENT_CONTRACT));
    // Сборка — диагностика: гейт её не толкует, но по ней в журнале сервера видно, какая именно
    // вкладка ещё жива. Значение подставляет сборка (`vite.config.ts`), в прогоне его нет.
    expect(sent[0]!.headers[CLIENT_BUILD_HEADER]).toBeTruthy();
  });

  it('уходят и из обновления сессии — оно зовёт fetch мимо транспорта', async () => {
    // Ради этого случая заголовки и вынесены в общий модуль: `session.ts` не пользуется `http.ts`,
    // потому что решение «сессия кончилась» принимает сам, а не транспорт.
    const sent = stubFetch({ status: 200, body: { accessToken: 'token' } });

    await refresh();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toContain('/api/v1/auth/refresh');
    expect(sent[0]!.headers[CLIENT_CONTRACT_HEADER]).toBe(String(CLIENT_CONTRACT));
    expect(sent[0]!.headers[CLIENT_BUILD_HEADER]).toBeTruthy();
  });

  it('число контракта — целое, а не идентификатор сборки', () => {
    // У короткого commit SHA отношения «ниже/выше» нет вовсе, поэтому гейт стоит на числе.
    expect(Number.isInteger(CLIENT_CONTRACT)).toBe(true);
    expect(CLIENT_CONTRACT).toBeGreaterThanOrEqual(1);
  });
});

describe('отказ 426: требование обновиться', () => {
  const upgradeRefusal = {
    status: 426,
    body: {
      code: 'client_upgrade_required',
      message: 'Портал обновился, обновите страницу (Ctrl+R, на Mac ⌘+R).',
    },
  };

  it('поднимается отказом сервера, а не опросом версии', async () => {
    stubFetch(upgradeRefusal);

    await expect(apiFetch('/service-requests')).rejects.toMatchObject({ status: 426 });

    expect(isClientUpgradeRequired()).toBe(true);
  });

  it('на экране — требование без «Позже», и обычный баннер погашен', async () => {
    stubFetch(upgradeRefusal);
    renderWithUser(<AppUpdateBanner />, { route: '/waste' });

    // До отказа портал предлагает обновиться и позволяет отложить — это прежнее поведение.
    expect(screen.getByText('Доступна новая версия приложения')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Позже' })).toBeDefined();

    await act(async () => {
      await apiFetch('/service-requests').catch(() => undefined);
    });

    expect(screen.getByRole('alertdialog', { name: 'Портал обновился' })).toBeDefined();
    expect(screen.getByRole('button', { name: /Обновить страницу/u })).toBeDefined();
    // Отложить нечего: вкладка уже не работает, и каждый её следующий запрос получит тот же отказ.
    expect(screen.queryByRole('button', { name: 'Позже' })).toBeNull();
    // Предложение под требованием читалось бы как выбор, которого нет.
    expect(screen.queryByText('Доступна новая версия приложения')).toBeNull();
  });

  it('обычный отказ требования не поднимает', async () => {
    stubFetch({ status: 403, body: { code: 'forbidden', message: 'Доступ запрещён' } });

    await expect(apiFetch('/service-requests')).rejects.toMatchObject({ status: 403 });

    expect(isClientUpgradeRequired()).toBe(false);
  });

  it('разбирается пара «статус + код», а не код в одиночку', async () => {
    /*
     * Тот же литерал `client_upgrade_required` носит 409 предпросмотра смены техники
     * (`pages/vehicle/ReassignPreview.tsx`) — там он означает «клиент не шлёт отпечаток» и лечится
     * просмотром последствий, а не перезагрузкой. Перепутать их значило бы запереть человека
     * требованием обновиться посреди работающей вкладки.
     */
    stubFetch({
      status: 409,
      body: { code: 'client_upgrade_required', message: 'Смена техники идёт через предпросмотр' },
    });

    await expect(apiFetch('/vehicle-requests/1/reassign')).rejects.toMatchObject({ status: 409 });

    expect(isClientUpgradeRequired()).toBe(false);
  });
});
