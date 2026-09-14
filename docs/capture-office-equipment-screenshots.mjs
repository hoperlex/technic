import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const playwrightRoot = process.env.PLAYWRIGHT_ROOT ?? '/tmp/technic-playwright';
const { chromium } = await import(
  pathToFileURL(join(playwrightRoot, 'node_modules/playwright/index.mjs')).href
);

const baseUrl = process.env.GUIDE_APP_URL ?? 'http://127.0.0.1:5173';
const password = process.env.GUIDE_PASSWORD ?? 'GuideScreens2026!';
const outDir = resolve(process.argv[2] ?? 'docs/image/office-equipment-latest');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });

async function newRolePage(email) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 1,
    locale: 'ru-RU',
    colorScheme: 'light',
  });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForURL((url) => url.pathname !== '/login', { timeout: 25_000 });
  await page.addStyleTag({
    content:
      '*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;caret-color:transparent!important}',
  });
  return { context, page };
}

async function openModule(page, tab = 'requests') {
  await page.goto(`${baseUrl}/office-equipment?tab=${tab}`);
  await page.waitForTimeout(3_000);
}

async function settle(page, ms = 500) {
  await page.waitForTimeout(ms);
}

async function shotApp(page, name) {
  await settle(page);
  const main = page.locator('.ant-layout-content').last();
  const target = (await main.count()) > 0 && (await main.isVisible()) ? main : page.locator('body');
  await target.screenshot({ path: join(outDir, name), animations: 'disabled' });
}

async function visibleModal(page) {
  const modal = page.getByRole('dialog').last();
  await modal.waitFor({ state: 'visible' });
  return modal;
}

async function shotModal(page, name) {
  await settle(page);
  await (
    await visibleModal(page)
  ).screenshot({
    path: join(outDir, name),
    animations: 'disabled',
  });
}

async function cancelModal(page) {
  const modal = await visibleModal(page);
  const cancel = modal.getByRole('button', { name: /^(Отмена|Закрыть)$/ }).last();
  if (await cancel.count()) await cancel.click();
  else await modal.getByRole('button', { name: 'Close' }).click();
  await settle(page, 250);
}

async function filterEquipment(page, search) {
  const header = page.getByRole('columnheader', { name: /Модель/ });
  await header.getByRole('button').click();
  const box = page.locator('.ant-table-filter-dropdown:visible').getByPlaceholder('Поиск');
  await box.fill(search);
  await box.press('Enter');
  await settle(page, 1_200);
}

if (!process.env.GUIDE_CAPTURE_ADMIN_ONLY) {
  // Заявитель: список, заполненная форма и карточка.
  {
    const { context, page } = await newRolePage('guide.requester@dev.local');
    await openModule(page);
    await shotApp(page, 'requests-requester.png');

    await page.getByRole('button', { name: 'Создать заявку' }).click();
    const equipment = page.getByLabel('Какой аппарат');
    await equipment.fill('DEMO-01472');
    await settle(page, 1_000);
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click();
    await page.getByLabel('Описание').fill('МФУ мнёт бумагу и оставляет полосы при печати');
    await page.getByRole('checkbox', { name: 'Срочная заявка' }).check();
    await page
      .getByLabel('Почему срочно')
      .fill('Единственный аппарат отдела: печать документов остановлена');
    await page
      .getByLabel('Что ещё важно знать')
      .fill('Ошибка повторяется при печати из разных программ.');
    await shotModal(page, 'request-create.png');
    await cancelModal(page);

    await page.getByText('СО-41', { exact: true }).click();
    await shotModal(page, 'request-card-requester.png');
    await context.close();
  }

  // Заявитель: аппарат отсутствует в справочнике.
  {
    const { context, page } = await newRolePage('guide.department@dev.local');
    await openModule(page);
    await page.getByRole('button', { name: 'Создать заявку' }).click();
    await page.getByLabel('Какой аппарат').fill('DEMO-02001');
    await settle(page, 900);
    await page.getByLabel('Какой аппарат').press('Escape');
    await page.getByRole('button', { name: 'Не нашли технику?' }).click();
    await settle(page, 500);

    await page.getByLabel('Что за аппарат').click();
    await page.getByRole('option', { name: 'МФУ', exact: true }).click();
    await page.getByLabel('Модель с шильдика').fill('Kyocera ECOSYS M3145idn');
    await page.getByLabel('Серийный номер').fill('DEMO-UNKNOWN-77');
    await page.getByLabel('Инвентарный номер').fill('DEMO-02001');
    const site = page.getByLabel('Где стоит');
    if (!(await site.inputValue().catch(() => ''))) {
      await site.click();
      await page.getByRole('option', { name: /Демо-офис «Север»/ }).click();
    }
    await page.getByLabel('Место').fill('Кабинет 305');
    await page.getByLabel('Что ещё важно знать').last().fill('Фото шильдика приложено к заявке.');
    await shotModal(page, 'candidate-report.png');
    await context.close();
  }

  // Сервисная компания: очередь, карточка, объём работ и документы.
  {
    const { context, page } = await newRolePage('guide.service@dev.local');
    await openModule(page);
    await shotApp(page, 'requests-service.png');

    await page.getByText('СО-38', { exact: true }).click();
    await shotModal(page, 'request-card-service.png');
    const parent = page.locator('.ant-modal:visible').last();
    await parent.getByText('Объём работ', { exact: true }).click();
    await shotModal(page, 'estimate-service.png');
    await parent.getByRole('button', { name: 'Действия' }).click();
    await page.locator('.ant-dropdown:visible').getByText('Объём работ', { exact: true }).click();
    await shotModal(page, 'estimate-editor.png');
    await cancelModal(page);

    const card = page.locator('.ant-modal:visible').last();
    await card.getByText('Документы', { exact: true }).click();
    await shotModal(page, 'documents-service.png');
    await context.close();
  }

  // ИТ-исполнитель: рабочая очередь и предъявленный объём работ.
  {
    const { context, page } = await newRolePage('guide.it@dev.local');
    await openModule(page);
    await shotApp(page, 'requests-it.png');

    await page.getByText('СО-40', { exact: true }).click();
    await shotModal(page, 'request-card-it.png');
    const card = page.locator('.ant-modal:visible').last();
    await card.getByText('Объём работ', { exact: true }).click();
    await shotModal(page, 'estimate-approval.png');
    await context.close();
  }
}

// Ведение: назначение и массовые действия.
if (!process.env.GUIDE_CAPTURE_FINAL_ONLY) {
  {
    const { context, page } = await newRolePage('guide.admin@dev.local');
    await openModule(page);
    await page.getByText('СО-41', { exact: true }).click();
    const card = page.getByRole('dialog').last();
    await card.getByText('Назначить', { exact: true }).click();
    await shotModal(page, 'assignment.png');
    await context.close();
  }

  {
    const { context, page } = await newRolePage('guide.admin@dev.local');
    await openModule(page);
    await page
      .getByRole('row', { name: /СО-39/ })
      .locator('input[type="checkbox"]')
      .first()
      .check({ force: true });
    await page
      .getByRole('row', { name: /СО-41/ })
      .locator('input[type="checkbox"]')
      .first()
      .check({ force: true });
    await shotApp(page, 'bulk-actions.png');
    await context.close();
  }

  // Парк, перемещение и история.
  {
    const { context, page } = await newRolePage('guide.admin@dev.local');
    await openModule(page, 'equipment');
    await filterEquipment(page, 'DEMO-');
    await shotApp(page, 'equipment-list.png');

    let row = page.getByRole('row', { name: /DEMO-01475/ });
    await row.locator('button').nth(1).click();
    await page.getByLabel('Место внутри объекта').fill('Кабинет 214');
    await page.getByLabel('Отдел-владелец').click();
    await page.getByRole('option', { name: /Отдел снабжения/ }).click();
    await page.getByLabel('Причина').fill('Возврат аппарата после настройки');
    await page.getByLabel('Комментарий').fill('Передачу подтвердил ответственный отдела.');
    await shotModal(page, 'equipment-move.png');
    await cancelModal(page);

    row = page.getByRole('row', { name: /DEMO-01475/ });
    await row.locator('button').nth(0).click();
    const history = page.locator('.ant-modal:visible').last();
    await history.getByText('Перемещения', { exact: true }).click();
    await settle(page, 700);
    await shotModal(page, 'equipment-history.png');
    await context.close();
  }
}

// Гарантии, склад расходников и карточка закупки.
{
  const { context, page } = await newRolePage('guide.admin@dev.local');
  await openModule(page, 'warranties');
  const objectFilter = page.getByText('Все объекты', { exact: true }).first();
  await objectFilter.click({ force: true });
  await page.getByRole('option', { name: /Демо-офис «Север»/ }).click();
  await settle(page, 1_000);
  await shotApp(page, 'warranties.png');

  await openModule(page, 'consumables');
  const search = page.getByPlaceholder('Наименование или код');
  await search.fill('DEMO-');
  await search.press('Enter');
  await settle(page, 1_000);
  await shotApp(page, 'consumables.png');

  await page.getByText('Закупки', { exact: true }).click();
  await settle(page, 800);
  await page.getByText('ЗК-1', { exact: true }).click();
  await shotModal(page, 'purchase.png');
  await context.close();
}

await browser.close();
console.log(`Скриншоты сохранены: ${outDir}`);
