import { describe, expect, it } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import { Navigate, Route, Routes } from 'react-router';
import { formatPhone, type ReleaseDto } from '@technic/contracts';
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
 * Руководства, помощь и новости портала — не разделы: за ними нет страницы, и права на них не
 * спрашивают. Место у них разное на разных устройствах (ADR 0030): на десктопе — подвал боковой
 * панели, на телефоне — меню учётной записи, потому что нижняя навигация занята разделами целиком.
 * Проверяется и то, и другое: пункт, потерянный на одном из устройств, недостижим вовсе.
 *
 * Страж идёт по всему набору пунктов, а не по тем, ради которых файл заводили: пункт добавляют
 * в служебное меню редко, и добавленный мимо этой проверки остался бы без стража вовсе. Что
 * показывает каждое окно — предмет своих файлов (`manuals.test.tsx` — окно руководств); здесь
 * проверяется место пунктов и то, что все они рабочие.
 */

/**
 * Весь набор служебных пунктов, в порядке показа: руководства — «как это делается», поддержка —
 * «почему не получилось», обновления — «что изменилось».
 */
const UTILITY_ITEMS = ['Руководства', 'Техподдержка', 'Обновления'];

/**
 * Два выпуска журнала (ADR 0077). Второй нужен не для массовости: раскрытым должен быть только
 * новейший, и без соседа это условие ничем не отличается от «раскрыт единственный».
 */
const RELEASES: ReleaseDto[] = [
  {
    seq: 7,
    version: '0.1.7.0077',
    releasedOn: '2026-08-06',
    title: 'Журнал обновлений',
    adrCount: 1,
    items: [{ kind: 'feature', text: 'Окно «Что нового» в служебном меню' }],
  },
  {
    seq: 6,
    version: '0.1.6.0076',
    releasedOn: '2026-08-06',
    title: 'Гараж',
    adrCount: 2,
    items: [{ kind: 'improvement', text: 'Срез занятости техники на дату' }],
  },
];

function renderLayout(viewport: Viewport = DESKTOP_VIEWPORT) {
  // Каркас показывает бейдж заявок на регистрацию (ADR 0034) — к поддержке отношения не имеет,
  // но без ответа макет администратора пошёл бы за счётчиком в настоящую сеть. Журнал обновлений
  // каркас спрашивает сам, ещё до открытия окна: точка в меню считается по нему (ADR 0077).
  mockHttp({
    'GET /users/pending-count': () => json({ count: 0 }),
    'GET /releases': () => json(RELEASES),
  });
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

describe('место служебных пунктов', () => {
  it('на десктопе все три пункта стоят в подвале панели и все рабочие', () => {
    renderLayout();
    // Именно в подвале, а не «где-то на экране»: полоса служебных пунктов отделена от разделов
    // намеренно — это не места, куда переходят работать (ADR 0030).
    const utility = document.querySelector('.sider-utility') as HTMLElement;
    for (const label of UTILITY_ITEMS) {
      expect(
        within(utility).queryByText(label),
        `${label} потерялся в подвале панели`,
      ).not.toBeNull();
    }
    // Выключенный пункт узнаётся по классу antd, а не по виду: серый цвет — следствие, а
    // проверять нужно то, что нажатие ничего не откроет. Выключенных здесь больше нет —
    // «Обновления» перестали быть заглушкой «скоро» (ADR 0077).
    expect(document.querySelector('.ant-menu-item-disabled')).toBeNull();
  });

  it('на телефоне все три уезжают в меню учётной записи, а разделы внизу не меняются', () => {
    renderLayout(MOBILE_VIEWPORT);

    // Нижняя навигация — только разделы: шестой пункт на 360 px не читается (ADR 0030).
    const nav = screen.getByRole('navigation', { name: 'Разделы портала' });
    for (const label of UTILITY_ITEMS) {
      expect(within(nav).queryByText(label), `${label} попал в нижнюю навигацию`).toBeNull();
      // И нигде больше: до открытия меню учётной записи служебных пунктов на телефоне нет.
      expect(screen.queryByText(label), `${label} виден мимо меню учётной записи`).toBeNull();
    }

    fireEvent.click(screen.getByRole('button', { name: 'Учётная запись' }));
    for (const label of UTILITY_ITEMS) {
      expect(screen.getByText(label)).toBeDefined();
    }
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

describe('окно обновлений', () => {
  it('раскрывает новейший выпуск, а прошлые оставляет свёрнутыми', async () => {
    renderLayout();
    fireEvent.click(screen.getByText('Обновления'));
    const dialog = await screen.findByRole('dialog');

    expect(await within(dialog).findByText('v0.1.7.0077')).toBeDefined();
    expect(within(dialog).getByText('6 августа 2026 · Журнал обновлений')).toBeDefined();
    expect(within(dialog).getByText('1 решение')).toBeDefined();
    expect(within(dialog).getByText('Окно «Что нового» в служебном меню')).toBeDefined();

    // Прошлый выпуск в списке есть, но его пункты — нет: журнал открывают ради последнего, а
    // раскрытые разом семь блоков превратили бы окно в ленту.
    expect(within(dialog).getByText('v0.1.6.0076')).toBeDefined();
    expect(within(dialog).queryByText('Срез занятости техники на дату')).toBeNull();
  });

  it('отметка прочитанного встаёт при открытии, а не при закрытии (ADR 0077)', async () => {
    localStorage.clear();
    renderLayout();
    fireEvent.click(screen.getByText('Обновления'));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('v0.1.7.0077');

    // Окно ещё открыто, а отметка уже стоит: закрыть могли по Esc, но выпуск к этому моменту
    // прочитан — и точка в меню гаснуть должна в любом случае.
    expect(localStorage.getItem('technic:changelog-seen')).toBe('7');
  });
});
