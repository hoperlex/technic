/**
 * Экраны для кратких инструкций по созданию заявок (`docs/generate-request-guides.mjs`).
 *
 * Снимает ДЕСКТОПНЫЙ портал (1440×960, плотность 2) на локальном контуре с демонстрационными
 * данными: репозиторий публичный, и настоящие фамилии с телефонами в него не едут. Роли — те же
 * демонстрационные учётки `guide.*@dev.local`, что снимают руководства по «Орг.технике», плюс две
 * площадочные (`guide.site`, `guide.ruk`), заведённые для этих инструкций.
 *
 * ЗАЯВКИ ЗАВОДЯТСЯ ПРЯМО СЪЁМКОЙ, а не сидом: список с новой строкой, согласование и карточка
 * снимаются после сохранения той же заявки, что показана на снимке формы. Разведи их — инструкция
 * показывала бы две разные заявки как одну, и номер в шаге «найдите свою заявку» не совпадал бы.
 *
 * Запуск (портал и API подняты на локальном контуре):
 *   GUIDE_APP_URL=http://127.0.0.1:5173 node docs/capture-request-guide-screenshots.mjs
 * Переснять один раздел: GUIDE_ONLY=mech (waste | vehicle | mech | orgtech).
 */
// `document` живёт не здесь: тела `page.evaluate` уезжают строкой в браузер и исполняются там.
// Для линта этот файл — node-скрипт (каталог `docs` объявлен node-окружением в `eslint.config.js`),
// поэтому браузерный глобал объявляется явно, а не расширением окружения на весь каталог.
/* global document */

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const playwrightRoot = process.env.PLAYWRIGHT_ROOT ?? '/tmp/technic-playwright';
const { chromium } = await import(
  pathToFileURL(join(playwrightRoot, 'node_modules/playwright/index.mjs')).href
);

const baseUrl = process.env.GUIDE_APP_URL ?? 'http://127.0.0.1:5173';
const password = process.env.GUIDE_PASSWORD ?? 'GuideScreens2026!';
const chromePath = process.env.GUIDE_CHROME;
const outDir = resolve(process.argv[2] ?? 'docs/image/request-guides');
const only = process.env.GUIDE_ONLY?.split(',').map((s) => s.trim());
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  ...(chromePath ? { executablePath: chromePath } : {}),
});

/** Дата в форме: сдвиг от сегодня, чтобы снимок проходил лид-тайм модуля и не старел на день. */
const day = (shift) => {
  const d = new Date();
  d.setDate(d.getDate() + shift);
  return d.toLocaleDateString('ru-RU');
};

async function newRolePage(email, attempt = 0) {
  try {
    return await openRolePage(email);
  } catch (error) {
    // Первый заход в dev-портал ждёт сборки модулей vite и изредка не успевает: повтор дешевле,
    // чем потерянный прогон всего раздела.
    if (attempt >= 2) throw error;
    return newRolePage(email, attempt + 1);
  }
}

async function openRolePage(email) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    // Плотность 2: снимок печатается вдвое мельче экрана и не мылится на бумаге.
    deviceScaleFactor: 2,
    locale: 'ru-RU',
    colorScheme: 'light',
  });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 30_000 });
  await page.addStyleTag({
    content:
      '*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;caret-color:transparent!important}',
  });
  return { context, page };
}

const settle = (page, ms = 600) => page.waitForTimeout(ms);

/**
 * Снимок рабочей области по нижнюю границу таблицы: пустой низ экрана в инструкции занимал бы
 * треть страницы, отнимая её у самого экрана.
 */
async function shotApp(page, name, { bottom = '.ant-pagination', pad = 16 } = {}) {
  await settle(page);
  const main = page.locator('.ant-layout-content').last();
  const box = await main.boundingBox();
  const tail = page.locator(bottom).last();
  const tbox = (await tail.count()) ? await tail.boundingBox() : null;
  const height = tbox ? Math.min(box.height, tbox.y + tbox.height - box.y + pad) : box.height;
  await page.screenshot({
    path: join(outDir, name),
    animations: 'disabled',
    clip: { x: box.x, y: box.y, width: box.width, height },
  });
}

/** Снимок страницы целиком — там, где важно меню разделов слева. */
async function shotPage(page, name, { height = 620 } = {}) {
  await settle(page);
  await page.screenshot({
    path: join(outDir, name),
    animations: 'disabled',
    clip: { x: 0, y: 0, width: 1440, height },
  });
}

async function visibleModal(page) {
  const modal = page.getByRole('dialog').last();
  await modal.waitFor({ state: 'visible' });
  return modal;
}

async function shotModal(page, name) {
  await settle(page);
  await (await visibleModal(page)).screenshot({ path: join(outDir, name), animations: 'disabled' });
}

/** Снимок окна вместе с раскрытым списком: выпадающий список живёт вне модалки, в теле страницы. */
async function shotModalWithDropdown(page, name, { maxHeight = 940 } = {}) {
  await settle(page);
  const modal = await visibleModal(page);
  const box = await modal.boundingBox();
  const drop = page.locator('.ant-select-dropdown:visible').last();
  const dbox = await drop.boundingBox();
  const x = Math.max(0, Math.min(box.x, dbox.x) - 8);
  const y = Math.max(0, Math.min(box.y, dbox.y) - 8);
  const width = Math.min(1440 - x, Math.max(box.x + box.width, dbox.x + dbox.width) - x + 8);
  const height = Math.min(
    maxHeight,
    Math.max(box.y + box.height, dbox.y + dbox.height) - y + 8,
    960 - y,
  );
  await page.screenshot({
    path: join(outDir, name),
    animations: 'disabled',
    clip: { x, y, width, height },
  });
}

/**
 * Прокрутка таблицы к нужному столбцу: рабочие списки шире экрана, и «Согласование» у заказа
 * техники стоит за краем — снимок без прокрутки показывал бы шаг, которого на нём не видно.
 */
async function scrollTableTo(page, columnTitle, offset = 360) {
  await page.evaluate(
    ({ title, gap }) => {
      const body = document.querySelector('.ant-table-body');
      const header = [...document.querySelectorAll('.ant-table-thead th')].find((th) =>
        th.textContent.includes(title),
      );
      if (body && header) body.scrollLeft = Math.max(0, header.offsetLeft - gap);
    },
    { title: columnTitle, gap: offset },
  );
  await settle(page, 400);
}

/**
 * Снос строк, заведённых прошлым прогоном (по тексту их же комментария): иначе список в
 * инструкции обрастал бы одинаковыми заявками, а «найдите свою» указывало бы на пять одинаковых.
 * Удаляются только собственные «Новые» — у остальных кнопка заперта самим порталом.
 */
async function clearMine(page, pattern, { limit = 12 } = {}) {
  for (let i = 0; i < limit; i += 1) {
    const row = page.getByRole('row', { name: pattern }).first();
    if (!(await row.count())) return;
    const remove = row.getByRole('button').last();
    if (!(await remove.count()) || (await remove.isDisabled())) return;
    await remove.click();
    await settle(page, 500);
    const confirm = page.getByRole('button', { name: 'Удалить' }).last();
    if (await confirm.count()) await confirm.click();
    await settle(page, 1_200);
  }
}

/** Адрес из справочника: чекбокс над полем меняет ввод строкой на список площадок и складов. */
async function pickDirectoryAddress(page, modal, label, option) {
  // Чекбокс стоит НАД полем, соседом формы-элемента: внутри `.ant-form-item` его нет.
  const item = modal.locator('.address-field').filter({ hasText: label }).first();
  await item.getByRole('checkbox', { name: 'Из справочника' }).check();
  await settle(page, 500);
  await item.locator('.ant-select').first().click();
  await settle(page, 800);
  await page.locator('.ant-select-dropdown:visible').last().getByText(option).first().click();
  await settle(page, 400);
}

async function fillDate(scope, page, label, value) {
  const field = scope.getByLabel(label, { exact: true });
  await field.click();
  await field.fill(value);
  await field.press('Enter');
  await settle(page, 300);
}

const should = (name) => !only || only.includes(name);

// ── Вывоз мусора ──────────────────────────────────────────────────────────────────────────────
if (should('waste')) {
  const { context, page } = await newRolePage('guide.site@dev.local');
  await page.goto(`${baseUrl}/waste`);
  await settle(page, 2_500);
  await clearMine(page, /Бой от демонтажа фундамента/);
  await shotPage(page, 'waste-section.png');

  await page.getByRole('button', { name: 'Создать заявку' }).click();
  await settle(page, 1_000);
  const modal = await visibleModal(page);

  await modal.getByLabel('Тип заявки').click();
  await settle(page, 500);
  await shotModalWithDropdown(page, 'waste-types.png');
  await page.getByRole('option', { name: 'Вывоз мусора (разовый объём)' }).click();
  await settle(page, 600);

  await modal.getByLabel('Тип мусора').click();
  await settle(page, 400);
  await page.getByRole('option', { name: 'Бетонный бой' }).click();
  await modal.getByLabel('Объём, м³').fill('30');
  await fillDate(modal, page, 'Дата доставки', day(2));
  await modal.getByLabel('Ответственный на площадке').fill('Демидов Сергей Петрович');
  await modal.getByLabel('Контактный телефон').fill('+7 900 000-10-01');
  await modal
    .getByLabel('Комментарий площадки')
    .fill('Бой от демонтажа фундамента, подъезд со стороны бытового городка.');
  await settle(page, 700);
  await shotModal(page, 'waste-form.png');

  await modal.getByRole('button', { name: 'Сохранить' }).click();
  await settle(page, 2_500);
  await shotApp(page, 'waste-created.png');

  // Карточка: статус, ответственный и история — то, чем заявитель проверяет уже поданную заявку.
  await page
    .getByRole('row', { name: /Бетонный бой/ })
    .first()
    .click();
  await settle(page, 1_200);
  await shotModal(page, 'waste-card.png');
  await context.close();
}

// ── Заказ ТС ──────────────────────────────────────────────────────────────────────────────────
if (should('vehicle')) {
  const { context, page } = await newRolePage('guide.site@dev.local');
  await page.goto(`${baseUrl}/vehicle-requests`);
  await settle(page, 2_500);
  await clearMine(page, /Монтаж башенных секций/);
  await shotApp(page, 'vehicle-list.png');

  await page.getByRole('button', { name: 'Создать заявку' }).click();
  await settle(page, 1_000);
  let modal = await visibleModal(page);
  await modal.getByLabel('Тип заявки').click();
  await settle(page, 400);
  await page.getByRole('option', { name: 'Техника для работы на объекте' }).click();
  await settle(page, 600);

  // Классификатор: список позиций со ставками — им и отвечают на вопрос «что именно заказать».
  await modal.getByLabel('Тип/категория ТС').click();
  await settle(page, 800);
  await page.keyboard.type('Автокран');
  await settle(page, 700);
  await shotModalWithDropdown(page, 'vehicle-classification.png');
  await page
    .getByRole('option', { name: /Автокраны, г\/п 25 т/ })
    .first()
    .click();
  await settle(page, 500);

  await fillDate(modal, page, 'Дата начала', day(2));
  await fillDate(modal, page, 'Дата окончания', day(4));
  await modal.getByLabel('Ответственный на объекте').fill('Демидов Сергей Петрович');
  await modal.getByLabel('Контактный телефон').fill('+7 900 000-10-01');
  await modal
    .getByLabel(/Комментарий/)
    .fill('Монтаж башенных секций, работа с 08:00, въезд через южные ворота.');
  await settle(page, 600);
  await shotModal(page, 'vehicle-form.png');
  await modal.getByRole('button', { name: 'Сохранить' }).click();
  await settle(page, 2_500);
  await shotApp(page, 'vehicle-created.png');

  // Грузоперевозка — второй тип заявки: адреса обоих концов и ездки.
  await page.getByRole('button', { name: 'Создать заявку' }).click();
  await settle(page, 1_000);
  modal = await visibleModal(page);
  await modal.getByLabel('Тип заявки').click();
  await settle(page, 400);
  await page.getByRole('option', { name: 'Грузоперевозка' }).click();
  await settle(page, 700);
  await modal.getByLabel('Тип/категория ТС').click();
  await settle(page, 700);
  await page.keyboard.type('Самосвал');
  await settle(page, 700);
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click();
  await settle(page, 400);
  await fillDate(modal, page, 'Дата подачи', day(2));
  await modal.getByLabel('Масса, т').fill('20');
  /*
   * Адрес берётся ИЗ СПРАВОЧНИКА, а не подсказкой DaData: на локальном контуре ключа подсказок
   * нет, и свободная строка осталась бы на снимке с красной ошибкой «выберите из подсказок».
   * Заодно снимок показывает второй, всегда доступный способ ввода — площадки и склады списком.
   */
  await pickDirectoryAddress(page, modal, 'Место погрузки', /БАЗА ХИМКИ/);
  await modal.locator('#trips_0_fromResponsibleName').fill('Демидов Сергей Петрович');
  await modal.locator('#trips_0_fromResponsiblePhone').fill('+7 900 000-10-01');
  await pickDirectoryAddress(page, modal, 'Место разгрузки', /ЖК ALIA, БЛОКИ 13А, 13В/);
  await modal.locator('#trips_0_toResponsibleName').fill('Кузнецов Павел Андреевич');
  await modal.locator('#trips_0_toResponsiblePhone').fill('+7 900 000-10-02');
  await modal.getByLabel(/Комментарий/).fill('Песок для подсыпки, разгрузка у бытового городка.');
  await settle(page, 600);
  await shotModal(page, 'vehicle-freight.png');
  await modal.getByRole('button', { name: 'Отмена' }).click();
  await settle(page, 800);

  // Карточка поданной заявки: статус, согласование, сроки и история.
  await page
    .getByRole('row', { name: /Автокран/ })
    .first()
    .click();
  await settle(page, 1_500);
  await shotModal(page, 'vehicle-card.png');
  await context.close();

  // Виза руководителя строительства — на его же экране: кнопка живёт в колонке «Согласование».
  const ruk = await newRolePage('guide.ruk@dev.local');
  await ruk.page.goto(`${baseUrl}/vehicle-requests`);
  await settle(ruk.page, 2_500);
  await scrollTableTo(ruk.page, 'Согласование');
  await shotApp(ruk.page, 'vehicle-approve.png');
  const approve = ruk.page.getByRole('button', { name: 'Согласовать' }).first();
  if (await approve.count()) {
    await approve.click();
    await settle(ruk.page, 2_000);
    await scrollTableTo(ruk.page, 'Согласование');
    await shotApp(ruk.page, 'vehicle-approved.png');
  }
  await ruk.context.close();
}

// ── Механизация ───────────────────────────────────────────────────────────────────────────────
if (should('mech')) {
  const { context, page } = await newRolePage('guide.site@dev.local');
  await page.goto(`${baseUrl}/mech`);
  await settle(page, 2_500);
  await clearMine(page, /Уплотнение обратной засыпки/);
  await shotPage(page, 'mech-section.png');

  await page.getByRole('button', { name: 'Заказать технику' }).click();
  await settle(page, 1_000);
  const modal = await visibleModal(page);

  await modal.getByLabel('Модель').click();
  await settle(page, 700);
  await page.keyboard.type('Виброплита');
  await settle(page, 700);
  await shotModalWithDropdown(page, 'mech-models.png');
  await page.getByRole('option', { name: /Виброплита реверсивная Wacker DPU 3070Н/ }).click();
  await settle(page, 400);

  await fillDate(modal, page, 'Подача', day(2));
  await fillDate(modal, page, 'Плановый возврат', day(16));
  await modal.getByLabel('Кто принимает технику').fill('Демидов Сергей Петрович');
  await modal.getByLabel('Телефон для связи').fill('+7 900 000-10-01');
  await modal
    .getByLabel('Комментарий')
    .fill('Уплотнение обратной засыпки котлована, работа в две смены.');
  await settle(page, 600);
  await shotModal(page, 'mech-form.png');
  await modal.getByRole('button', { name: 'Сохранить' }).click();
  await settle(page, 2_500);
  await shotApp(page, 'mech-created.png');

  await page
    .getByRole('row', { name: /Виброплита/ })
    .first()
    .click();
  await settle(page, 1_500);
  await shotModal(page, 'mech-card.png');
  await context.close();

  // Виза площадки: у аренды она живёт в меню действий строки, а не отдельной колонкой.
  const ruk = await newRolePage('guide.ruk@dev.local');
  await ruk.page.goto(`${baseUrl}/mech`);
  await settle(ruk.page, 2_500);
  const row = ruk.page.getByRole('row', { name: /Виброплита/ }).first();
  await row.getByRole('button').last().click();
  await settle(ruk.page, 700);
  await ruk.page.screenshot({
    path: join(outDir, 'mech-approve.png'),
    animations: 'disabled',
    clip: { x: 320, y: 90, width: 1120, height: 520 },
  });
  const item = ruk.page.getByRole('menuitem', { name: 'Согласовать' });
  if (await item.count()) {
    await item.click();
    await settle(ruk.page, 2_000);
    await shotApp(ruk.page, 'mech-approved.png');
  }
  await ruk.context.close();
}

// ── Орг.техника ───────────────────────────────────────────────────────────────────────────────
if (should('orgtech')) {
  const { context, page } = await newRolePage('guide.requester@dev.local');
  await page.goto(`${baseUrl}/office-equipment?tab=requests`);
  await settle(page, 3_000);
  await shotPage(page, 'oe-section.png');
  await shotApp(page, 'oe-list.png', { bottom: '.ant-table' });

  await page.getByRole('button', { name: 'Создать заявку' }).click();
  await settle(page, 1_000);
  let modal = await visibleModal(page);

  // Поиск аппарата: одно поле на модель, инвентарный и серийный номер — весь парк целиком.
  await modal.getByLabel('Какой аппарат').fill('DEMO-0147');
  await settle(page, 1_200);
  await shotModalWithDropdown(page, 'oe-equipment.png');
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click();
  await settle(page, 900);

  await modal.getByLabel('Описание').fill('Мнёт бумагу на каждой второй странице, печатать нечем');
  await modal.getByLabel('Кто обращается').fill('Иванова Анна Сергеевна');
  await modal.getByLabel('Телефон для связи').fill('+7 900 000-20-01');
  await modal
    .getByLabel('Что ещё важно знать')
    .fill('Ошибка повторяется при печати из разных программ.');
  await settle(page, 700);
  await shotModal(page, 'oe-form.png');
  await modal.getByRole('button', { name: 'Сохранить' }).click();
  await settle(page, 2_500);
  await shotApp(page, 'oe-created.png', { bottom: '.ant-table' });

  // Расходники — второй вид заявки: тот же вопрос словами, без номенклатуры склада.
  await page.getByRole('button', { name: 'Создать заявку' }).click();
  await settle(page, 1_000);
  modal = await visibleModal(page);
  await modal.getByText('Расходники', { exact: true }).click();
  await settle(page, 500);
  await modal.getByLabel('Какой аппарат').fill('DEMO-0147');
  await settle(page, 1_200);
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click();
  await settle(page, 800);
  await modal.getByLabel('Описание').fill('Закончился чёрный тонер, печатать нечем');
  await modal.getByLabel('Кто обращается').fill('Иванова Анна Сергеевна');
  await modal.getByLabel('Телефон для связи').fill('+7 900 000-20-01');
  await settle(page, 600);
  await shotModal(page, 'oe-consumable.png');
  await modal.getByRole('button', { name: 'Отмена' }).click();
  await settle(page, 800);

  // Карточка заявителя: обсуждение, документы и история.
  await page
    .getByText(/^СО-\d+$/)
    .first()
    .click();
  await settle(page, 1_500);
  await shotModal(page, 'oe-card.png');
  await context.close();

  // Аппарата нет в справочнике — сообщение о технике прямо из формы (право есть у отдела).
  const dep = await newRolePage('guide.department@dev.local');
  await dep.page.goto(`${baseUrl}/office-equipment?tab=requests`);
  await settle(dep.page, 2_500);
  await dep.page.getByRole('button', { name: 'Создать заявку' }).click();
  await settle(dep.page, 1_000);
  const dmodal = await visibleModal(dep.page);
  await dmodal.getByLabel('Какой аппарат').fill('DEMO-02001');
  await settle(dep.page, 900);
  await dmodal.getByLabel('Какой аппарат').press('Escape');
  await dep.page.getByRole('button', { name: 'Не нашли технику?' }).click();
  await settle(dep.page, 600);
  await dmodal.getByLabel('Что за аппарат').click();
  await dep.page.getByRole('option', { name: 'МФУ', exact: true }).click();
  await dmodal.getByLabel('Модель с шильдика').fill('Kyocera ECOSYS M3145idn');
  await dmodal.getByLabel('Серийный номер').fill('DEMO-UNKNOWN-77');
  await dmodal.getByLabel('Инвентарный номер').fill('DEMO-02001');
  const site = dmodal.getByLabel('Где стоит');
  if (!(await site.inputValue().catch(() => ''))) {
    await site.click();
    await dep.page.getByRole('option', { name: /Демо-офис «Север»/ }).click();
  }
  await dmodal.getByLabel('Место').fill('Кабинет 305');
  await settle(dep.page, 600);
  await shotModal(dep.page, 'oe-candidate.png');
  await dep.context.close();
}

await browser.close();
console.log(`Экраны сохранены: ${outDir}`);
