import { describe, expect, it } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import { Navigate, Route, Routes } from 'react-router';
import { formatPhone } from '@technic/contracts';
import {
  SUPPORT_MAX_URL,
  SUPPORT_PHONE,
  SUPPORT_PHONE_HREF,
  SUPPORT_TELEGRAM_URL,
} from '../src/shared/config';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { MOBILE_VIEWPORT, DESKTOP_VIEWPORT, type Viewport } from './viewport';
import { AppLayout } from '../src/components/AppLayout';

/**
 * Помощь и новости портала — не разделы: за ними нет страницы, и права на них не спрашивают.
 * Место у них разное на разных устройствах (ADR 0030): на десктопе — подвал боковой панели,
 * на телефоне — меню учётной записи, потому что нижняя навигация занята разделами целиком.
 * Проверяется и то, и другое: пункт, потерянный на одном из устройств, недостижим вовсе.
 */

function renderLayout(viewport: Viewport = DESKTOP_VIEWPORT) {
  // Каркас показывает бейдж заявок на регистрацию (ADR 0034) — к поддержке отношения не имеет,
  // но без ответа макет администратора пошёл бы за счётчиком в настоящую сеть.
  mockHttp({ 'GET /users/pending-count': () => json({ count: 0 }) });
  return renderWithUser(
    <Routes>
      <Route path="/" element={<Navigate to="/waste" replace />} />
      <Route element={<AppLayout />}>
        <Route path="/waste" element={<div>Список заявок</div>} />
      </Route>
    </Routes>,
    { viewport },
  );
}

/** Окно открывается только нажатием — до него в разметке нет ни ссылок, ни номера. */
function openSupport() {
  fireEvent.click(screen.getByText('Техподдержка'));
  return screen.getByRole('dialog');
}

describe('вход в техподдержку', () => {
  it('на десктопе пункт стоит в подвале панели, а новости выключены до реализации', () => {
    renderLayout();
    expect(screen.getByText('Техподдержка')).toBeDefined();
    expect(screen.getByText('Обновления')).toBeDefined();
    // Выключенный пункт узнаётся по классу antd, а не по виду: серый цвет — следствие, а
    // проверять нужно то, что нажатие ничего не откроет.
    expect(document.querySelector('.ant-menu-item-disabled')).not.toBeNull();
    expect(screen.getByText('скоро')).toBeDefined();
  });

  it('на телефоне пункты уезжают в меню учётной записи, а разделы внизу не меняются', () => {
    renderLayout(MOBILE_VIEWPORT);

    // Нижняя навигация — только разделы: шестой пункт на 360 px не читается (ADR 0030).
    const nav = screen.getByRole('navigation', { name: 'Разделы портала' });
    expect(within(nav).queryByText('Техподдержка')).toBeNull();

    expect(screen.queryByText('Техподдержка')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Учётная запись' }));
    expect(screen.getByText('Техподдержка')).toBeDefined();
    expect(screen.getByText('Обновления')).toBeDefined();
  });
});

describe('окно с контактами', () => {
  it('даёт три способа связи, и все три ведут по своим адресам', () => {
    renderLayout();
    const dialog = openSupport();

    const links = within(dialog).getAllByRole('link');
    const hrefs = links.map((el) => el.getAttribute('href'));
    expect(hrefs).toEqual([SUPPORT_TELEGRAM_URL, SUPPORT_MAX_URL, SUPPORT_PHONE_HREF]);
    expect(SUPPORT_TELEGRAM_URL).toContain(SUPPORT_PHONE);
  });

  it('номер показан в едином формате портала (ADR 0066)', () => {
    renderLayout();
    const dialog = openSupport();
    // Тот же вид, что в карточке учётки и в путевом листе: второе написание номера завелось бы
    // ровно с такого экрана, где его набрали руками.
    expect(within(dialog).getByText(formatPhone(SUPPORT_PHONE))).toBeDefined();
    expect(within(dialog).getByText('+7 (986) 511 49 71')).toBeDefined();
  });
});
