import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { ContainerTypeDto, DriverDto } from '@technic/contracts';
import { ContainerTypesTab } from '../src/pages/directories/ContainerTypesTab';
import { DriversTab } from '../src/pages/directories/DriversTab';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { list } from './factories/common';

/**
 * Окончательное удаление записи справочника (ADR 0060).
 *
 * Действие необратимое, и защит у него две: право `records.purge` (только администратор) и
 * состояние записи — удаляется лишь погашенная. Обе проверяет сервер, но кнопка обязана следовать
 * за ними: показанная не тому она ведёт в 403, показанная на живой строке предлагает то, чего
 * делать нельзя.
 *
 * Проверяется на «Типах контейнеров» — самой простой вкладке-таблице; в остальных то же действие
 * собрано тем же хуком `usePurgeAction`.
 */

function containerType(over: Partial<ContainerTypeDto> = {}): ContainerTypeDto {
  return {
    id: 'ct-1',
    code: 'cont_8',
    name: 'Контейнер 8 м³',
    type: 'cont',
    volumeM3: 8,
    sortOrder: 100,
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

const admin = authUser({ id: 'user-admin', role: 'admin' });

function mockDirectory(items: ContainerTypeDto[]) {
  return mockHttp({
    'GET /container-types': () => json(list(items)),
    'DELETE /container-types/:id/purge': () => json({ ok: true }),
  });
}

/** Кнопка удаления насовсем — вторая в строке действий; у активной записи её нет вовсе. */
function purgeButton(): HTMLElement | undefined {
  return [...document.querySelectorAll('tbody button')].find(
    (b) => b.getAttribute('title') === 'Удалить окончательно',
  ) as HTMLElement | undefined;
}

describe('окончательное удаление записи справочника', () => {
  it('на активной записи кнопки нет даже у администратора', async () => {
    mockDirectory([containerType()]);
    renderWithUser(<ContainerTypesTab />, { user: admin });

    await screen.findByText('Контейнер 8 м³');
    expect(purgeButton()).toBeUndefined();
  });

  it('без права кнопки нет и на деактивированной записи', async () => {
    mockDirectory([containerType({ isActive: false })]);
    // Диспетчер ведёт справочники, но не сносит записи: у него нет `records.purge`.
    renderWithUser(<ContainerTypesTab />);

    await screen.findByText('Контейнер 8 м³');
    expect(purgeButton()).toBeUndefined();
  });

  it('администратор сносит деактивированную запись после подтверждения', async () => {
    const http = mockDirectory([containerType({ isActive: false })]);
    renderWithUser(<ContainerTypesTab />, { user: admin });

    await screen.findByText('Контейнер 8 м³');
    const button = purgeButton();
    expect(button).toBeTruthy();
    fireEvent.click(button!);

    // Подтверждение называет запись и предупреждает о необратимости. Заголовок окна antd
    // рисует дважды (шапка и тело подтверждения) — важно, что он есть.
    const title = await screen.findAllByText('Удалить тип «Контейнер 8 м³» окончательно?');
    expect(title.length).toBeGreaterThan(0);
    expect(screen.getByText('Запись исчезнет из базы: восстановить её будет нечем.')).toBeTruthy();

    const confirm = [...document.querySelectorAll('.ant-modal button')].find(
      (b) => b.textContent === 'Удалить окончательно',
    );
    fireEvent.click(confirm!);

    await waitFor(() => expect(http.countOf('DELETE /container-types/:id/purge')).toBe(1));
    expect(http.lastCall('DELETE /container-types/:id/purge')!.path).toContain('ct-1');
  });
});

/**
 * Архив в справочниках, где запись уходит не в «неактивные», а в архив (ADR 0021). До этого его
 * не показывала ни одна вкладка, кроме «Техники»: удалённого водителя нельзя было ни увидеть, ни
 * снести — сервер отдавал его только по `includeDeleted`, а спросить об этом было некому.
 */
function driver(over: Partial<DriverDto> = {}): DriverDto {
  return {
    id: 'p1',
    lastName: 'Иванов',
    firstName: 'Иван',
    middleName: 'Иванович',
    fullName: 'Иванов Иван Иванович',
    birthDate: null,
    phone: '',
    email: '',
    snils: '11223344595',
    comment: '',
    personnelNo: '0001',
    jobTitle: 'Водитель',
    employedSince: null,
    licenses: [],
    version: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    ...over,
  };
}

function mockDrivers(items: DriverDto[]) {
  return mockHttp({
    'GET /drivers': () => json(list(items)),
    'GET /drivers/license-categories': () => json([]),
    'GET /drivers/job-titles': () =>
      json([{ jobTitle: 'Водитель', credentialTypeCode: 'driver_license', count: 1 }]),
    'DELETE /drivers/:id/purge': () => json({ ok: true }),
  });
}

const archiveCheckbox = () =>
  [...document.querySelectorAll('label.ant-checkbox-wrapper')].find((l) =>
    l.textContent?.includes('Показать архив'),
  );

describe('архив справочника водителей', () => {
  it('без права на архив переключателя нет', async () => {
    mockDrivers([driver()]);
    // Диспетчер ведёт водителей, но архив — право администратора.
    renderWithUser(<DriversTab />);

    await screen.findByText('Иванов Иван Иванович');
    expect(archiveCheckbox()).toBeUndefined();
  });

  it('администратор включает архив, и запрос уходит с `includeDeleted`', async () => {
    const http = mockDrivers([driver()]);
    renderWithUser(<DriversTab />, { user: admin });

    await waitFor(() => expect(http.countOf('GET /drivers')).toBe(1));
    expect(http.lastCall('GET /drivers')!.query.get('includeDeleted')).toBeNull();

    const checkbox = archiveCheckbox();
    expect(checkbox).toBeTruthy();
    fireEvent.click(checkbox!.querySelector('input')!);

    await waitFor(() => expect(http.countOf('GET /drivers')).toBe(2));
    expect(http.lastCall('GET /drivers')!.query.get('includeDeleted')).toBe('true');
  });

  it('архивную запись правят не глазами: вместо правки — удаление насовсем', async () => {
    mockDrivers([driver({ deletedAt: '2026-02-01T00:00:00.000Z' })]);
    renderWithUser(<DriversTab />, { user: admin });

    await screen.findByText('Иванов Иван Иванович');
    expect(screen.getByText('в архиве')).toBeTruthy();
    expect(purgeButton()).toBeTruthy();
  });
});
