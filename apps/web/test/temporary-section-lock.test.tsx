import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { Navigate, Route, Routes } from 'react-router';
import { SHELL_SECTIONS, type AuthUser } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { AppLayout } from '../src/components/AppLayout';
import { HomeRedirect, RequireSection } from '../src/auth/ProtectedRoute';

/**
 * ⚠️ ВРЕМЕННЫЙ ФАЙЛ — удаляется вместе с заплаткой `src/auth/temporarySectionLock.ts`.
 *
 * Пока модуль «Орг.техника» дорабатывают, раздел не показывается никому, кроме администратора и
 * держателей надстроек оргтехники («Оргтехника: ведение» и «Оргтехника: ИТ-служба»). Права ролей
 * при этом не тронуты: `officeEquipment.read` есть почти у каждой роли портала, и проверяется
 * здесь именно то, что раздел скрыт **вопреки** праву — иначе заплатку было бы не отличить от её
 * отсутствия.
 *
 * Спрошены все три двери сразу — меню, прямая ссылка и стартовая страница: заплатка гасит право
 * раздела в том, что портал спрашивает у реестра, и разойтись они не могут; тест это и закрепляет.
 */

const sectionPage = (label: string) => `Страница раздела «${label}»`;

function renderPortal(user: AuthUser, route = '/') {
  mockHttp({
    'GET /releases': () => json([]),
    'GET /users/pending-count': () => json({ count: 0 }),
    'GET /service-requests/waiting-count': () => json({ count: 0 }),
    'GET /service-requests/unread-count': () => json({ count: 0 }),
  });
  return renderWithUser(
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<HomeRedirect />} />
        {SHELL_SECTIONS.map((section) => (
          <Route key={section.id} element={<RequireSection id={section.id} />}>
            <Route path={section.path} element={<div>{sectionPage(section.label)}</div>} />
          </Route>
        ))}
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>,
    { user, route },
  );
}

/** Штаб объекта: `officeEquipment.read` у роли есть — раздел ему скрыт заплаткой, а не правами. */
const customer = () => authUser({ role: 'shtab', constructionObjectIds: ['obj-1'] });

/** Тот же штаб с надстройкой «Оргтехника: ведение» — один из тех, ради кого модуль и делают. */
const keeper = () =>
  authUser({
    id: 'user-operator',
    role: 'shtab',
    constructionObjectIds: ['obj-1'],
    addons: ['office_equipment_operator'],
  });

describe('«Орг.техника» скрыта до запуска у всех, кроме своих', () => {
  it('штаб раздела не видит, хотя право на него у роли есть', async () => {
    renderPortal(customer());
    // Стартовая страница увела его в первый открытый раздел — то есть заплатка не оставила
    // учётку без портала, а лишь вычла один пункт.
    expect(await screen.findByText(sectionPage('Вывоз мусора'))).toBeDefined();
    expect(screen.queryByText('Орг.техника')).toBeNull();
    // Соседние разделы на месте: гасится право спрятанного раздела, а не меню целиком.
    expect(screen.getByText('Заказ ТС')).toBeDefined();
  });

  it('прямая ссылка на раздел уводит штаба на стартовую страницу', async () => {
    renderPortal(customer(), '/office-equipment');
    expect(await screen.findByText(sectionPage('Вывоз мусора'))).toBeDefined();
    expect(screen.queryByText(sectionPage('Орг.техника'))).toBeNull();
  });

  it('держатель надстройки «Оргтехника: ведение» видит раздел и открывает его', async () => {
    renderPortal(keeper(), '/office-equipment');
    expect(await screen.findByText(sectionPage('Орг.техника'))).toBeDefined();
    expect(screen.getByText('Орг.техника')).toBeDefined();
  });

  it('администратору раздел открыт: заплатка его не касается', async () => {
    renderPortal(authUser({ id: 'user-admin', role: 'admin' }), '/office-equipment');
    expect(await screen.findByText(sectionPage('Орг.техника'))).toBeDefined();
  });
});
