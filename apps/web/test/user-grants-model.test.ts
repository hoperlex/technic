import { describe, expect, it } from 'vitest';
import {
  PERMISSION_CATALOG,
  permissionsFor,
  roleLabels,
  type GrantDto,
  type Permission,
} from '@technic/contracts';
import {
  applyGrantToggle,
  buildGrantStatements,
  grantAddedPermissions,
  grantCompositionText,
  hydrateGrantSelection,
  lockedGrantIds,
  NO_GRANT_EDITS,
  outOfRangeGrants,
  outOfRangeHintText,
  roleGateNoticeText,
} from '../src/pages/admin/userGrantsModel';
import {
  CUSTOM,
  CUSTOM_ID,
  grantRef,
  ORDERING,
  ORDERING_ASSIGNED_VERSION,
  ORDERING_ID,
  orderingRef,
  SYSTEM,
  SYSTEM_ID,
} from './factories/grants';

/**
 * Расчётная часть поля «Полномочия» (план «полномочия назначаются в окне учётки», Р4 и §6).
 *
 * Значениями, а не кликами, ровно по причине, названной в самом модуле: **тело запроса здесь не
 * равно значению группы чекбоксов**. Строку про набор, который смена роли гасит, из разметки не
 * достать вовсе — несовместимый набор чекбоксом не показан, — и проверять её через экран значило бы
 * проверять её через то место, где её нет. Экран проверяет `users-grants-form.test.tsx`: там
 * предмет другой — что форма зовёт этот расчёт и кладёт его в тело.
 *
 * Совместимость здесь везде задаётся **каталогом**, а не пересчитывается тестом: так же её узнаёт и
 * портал — списком, который сервер отобрал по роли.
 */

/** Каталог роли «Штаб»: «Заказа техники» в нём нет — эта роль его не принимает. */
const SHTAB_CATALOG: GrantDto[] = [CUSTOM, SYSTEM];
/** Каталог роли «Площадка»: ровно тот набор, который «Штабу» несовместим. */
const SITE_CATALOG: GrantDto[] = [ORDERING];

describe('гидратация галочек (Р4)', () => {
  it('берёт выданные и отмеченные вручную, а несовместимые отбрасывает', () => {
    // Формула Р4 целиком: ((выданные ∪ отмеченные) \ снятые) ∩ каталог итоговой роли. «Заказ
    // техники» выдан, но каталога этой роли не касается — в значении его быть не должно.
    const value = hydrateGrantSelection({
      assigned: [grantRef({ id: SYSTEM_ID }), orderingRef({ roleMismatch: true })],
      catalog: SHTAB_CATALOG,
      edits: { checked: [CUSTOM_ID], unchecked: [] },
    });

    // Порядок — каталожный, а не «сначала выданное, потом отмеченное»: список читают глазами, и
    // строки не должны перескакивать от каждой отметки.
    expect(value).toEqual([CUSTOM_ID, SYSTEM_ID]);
  });

  it('не возвращает галочку, снятую вручную, при следующей смене роли', () => {
    // Без этого администратор снял бы полномочие, сменил роль — и сохранил его обратно, ничего не
    // заметив: гидратация считает от выданных, а выданным набор остаётся до сохранения.
    const edits = applyGrantToggle(NO_GRANT_EDITS, [CUSTOM_ID], []);

    const value = hydrateGrantSelection({ assigned: [grantRef()], catalog: [CUSTOM], edits });

    expect(value).toEqual([]);
  });

  it('взведённое переводом ролей не даёт снять даже ручной правкой', () => {
    // Снятие такого назначения — часть подготовленного перевода, и решается оно в реестре выдач.
    // Попади оно в «снятые» обходом (устаревшая разметка, чужая правка), молчаливая потеря части
    // перевода была бы дороже лишней проверки.
    const value = hydrateGrantSelection({
      assigned: [grantRef({ origin: 'migration' })],
      catalog: [CUSTOM],
      edits: { checked: [], unchecked: [CUSTOM_ID] },
    });

    expect(value).toEqual([CUSTOM_ID]);
  });
});

describe('сборка высказывания (§6, §4.2, §4.3)', () => {
  it('site → shtab: гасимый набор назван строкой с selected: false, версия — из назначения', () => {
    // Обратный переход выражается только так: в группе чекбоксов набора нет вовсе — он несовместим
    // и не показан, — а сказать о нём форма обязана (§4.2). `false` здесь означает не «снять», а
    // «вижу, что перестаёт действовать» (§4.3).
    const rows = buildGrantStatements({
      assigned: [orderingRef()],
      catalog: SHTAB_CATALOG,
      selected: [],
      roleBefore: 'site',
      roleAfter: 'shtab',
    });

    // Версия каталожной быть не может: в каталоге «Штаба» этого набора нет — она приходит из
    // `UserAccountDto.grants` (Р7).
    expect(rows).toEqual([
      { id: ORDERING_ID, version: ORDERING_ASSIGNED_VERSION, selected: false },
    ]);
  });

  it('shtab → site: зажигаемый назван с selected: true, версия — каталожная', () => {
    // Прямой переход: галочку никто не ставил — её поставила гидратация, — а состав набора с новой
    // ролью зажигается. Подписывают при этом тот состав, который форма показала подсказкой, то есть
    // каталожный, а не запомненный назначением.
    const rows = buildGrantStatements({
      assigned: [orderingRef({ roleMismatch: true, origin: 'migration' })],
      catalog: SITE_CATALOG,
      selected: [ORDERING_ID],
      roleBefore: 'shtab',
      roleAfter: 'site',
    });

    expect(rows).toEqual([{ id: ORDERING_ID, version: ORDERING.version, selected: true }]);
  });

  it('при неизменной роли переключаемых строк нет вовсе', () => {
    // Назначение вне диапазона роли операцией не затрагивается (Р4): правка телефона не обязана
    // высказываться о наборе, действие которого никто не менял.
    const rows = buildGrantStatements({
      assigned: [orderingRef({ roleMismatch: true })],
      catalog: SHTAB_CATALOG,
      selected: [],
      roleBefore: 'shtab',
      roleAfter: 'shtab',
    });

    expect(rows).toEqual([]);
  });

  it('называет все управляемые назначения, но не весь каталог', () => {
    // Правило полноты (§4.2): о снятом сказано `false`, об оставшемся — `true`, и «снял» становится
    // отличимо от «не показал». А набор, который учётке никогда не выдавали и не отметили сейчас,
    // в теле не нужен: операция о нём ничего не решает.
    const rows = buildGrantStatements({
      assigned: [grantRef({ id: CUSTOM_ID }), grantRef({ id: SYSTEM_ID, version: SYSTEM.version })],
      catalog: [CUSTOM, SYSTEM, ORDERING],
      selected: [CUSTOM_ID],
      roleBefore: 'shtab',
      roleAfter: 'shtab',
    });

    expect(rows).toEqual([
      { id: CUSTOM_ID, version: CUSTOM.version, selected: true },
      { id: SYSTEM_ID, version: SYSTEM.version, selected: false },
    ]);
  });

  it('отмеченный, но ещё не выданный набор — это выдача', () => {
    const rows = buildGrantStatements({
      assigned: [],
      catalog: SITE_CATALOG,
      selected: [ORDERING_ID],
      roleBefore: 'site',
      roleAfter: 'site',
    });

    expect(rows).toEqual([{ id: ORDERING_ID, version: ORDERING.version, selected: true }]);
  });

  it('набор, версии которого не знают ни каталог, ни назначения, в тело не идёт', () => {
    // Подписывают состав, а он здесь неизвестен: сказать о таком наборе нечего, и молчание честнее
    // выдуманной версии.
    const rows = buildGrantStatements({
      assigned: [],
      catalog: SITE_CATALOG,
      selected: [CUSTOM_ID],
      roleBefore: 'site',
      roleAfter: 'site',
    });

    expect(rows).toEqual([]);
  });
});

describe('строка «Добавится» (§6)', () => {
  it('у заявки показывает права полномочий, а не права самой роли', () => {
    // У нерассмотренной заявки список прав пуст, и вычитание из него вернуло бы всё, что даёт роль.
    // Считается поэтому двумя полными субъектами — «должность» и «должность плюс наборы».
    const added = grantAddedPermissions({
      role: 'site',
      counterpartyType: null,
      catalog: SITE_CATALOG,
      selected: [ORDERING_ID],
    });

    expect(added).toEqual(ORDERING.permissions);
    for (const own of permissionsFor({ role: 'site' })) {
      expect(added).not.toContain(own);
    }
  });

  it('ничего не добавляет, когда права набора уже даёт должность', () => {
    // «Менеджер» заказывает технику по своей роли: тот же набор не добавляет ему ничего, и форма
    // обязана сказать это, а не показать список, который человек уже имеет.
    const added = grantAddedPermissions({
      role: 'manager',
      counterpartyType: null,
      catalog: SITE_CATALOG,
      selected: [ORDERING_ID],
    });

    expect(added).toEqual([]);
  });

  it('неотмеченные наборы в расчёт не берёт', () => {
    const added = grantAddedPermissions({
      role: 'site',
      counterpartyType: null,
      catalog: SITE_CATALOG,
      selected: [],
    });

    expect(added).toEqual([]);
  });
});

describe('назначения вне диапазона и неснимаемые', () => {
  it('вне диапазона — те выданные, которых нет в каталоге итоговой роли', () => {
    const outOfRange = outOfRangeGrants([grantRef(), orderingRef()], SHTAB_CATALOG);

    expect(outOfRange.map((g) => g.id)).toEqual([ORDERING_ID]);
  });

  it('неснимаемы только взведённые переводом ролей', () => {
    const locked = lockedGrantIds([grantRef(), orderingRef({ origin: 'migration' })]);

    expect([...locked]).toEqual([ORDERING_ID]);
  });
});

describe('ручные отметки (Р4)', () => {
  it('снятая галочка переезжает из отмеченных в снятые и обратно', () => {
    // Множества взаимоисключающие: отметив снятое, человек берёт своё слово назад целиком — иначе
    // назначение осталось бы одновременно и снятым, и отмеченным.
    const checked = applyGrantToggle(NO_GRANT_EDITS, [CUSTOM_ID], [CUSTOM_ID, SYSTEM_ID]);
    expect(checked).toEqual({ checked: [SYSTEM_ID], unchecked: [] });

    const unchecked = applyGrantToggle(checked, [CUSTOM_ID, SYSTEM_ID], [CUSTOM_ID]);
    expect(unchecked).toEqual({ checked: [], unchecked: [SYSTEM_ID] });

    const again = applyGrantToggle(unchecked, [CUSTOM_ID], [CUSTOM_ID, SYSTEM_ID]);
    expect(again).toEqual({ checked: [SYSTEM_ID], unchecked: [] });
  });
});

describe('тексты поля', () => {
  it('смена роли объявляет последствие, а не снятие', () => {
    const text = roleGateNoticeText('commandant', [orderingRef()]);

    expect(text).toContain(`«${ORDERING.name}»`);
    expect(text).toContain(roleLabels.commandant);
    expect(text).toContain('не действует');
    // Главное отличие от прежних надстроек: назначение остаётся жить, гаснут только права по нему.
    // Скажи форма «снято», администратор пошёл бы выдавать набор заново, а он никуда не девался.
    expect(text).toContain('назначение остаётся');
    expect(text).not.toMatch(/снят[аоы]/);
  });

  it('о двух наборах говорит во множественном числе', () => {
    const text = roleGateNoticeText('commandant', [orderingRef(), grantRef()]);

    expect(text).toContain(`«${ORDERING.name}», «${CUSTOM.name}»`);
    expect(text).toContain('не действуют');
    expect(text).toContain('назначения остаются');
  });

  it('молчит, когда гасить нечего или роль не выбрана', () => {
    expect(roleGateNoticeText('commandant', [])).toBeNull();
    expect(roleGateNoticeText(null, [orderingRef()])).toBeNull();
  });

  it('справка под полем называет то, что выдано, но не действует', () => {
    expect(outOfRangeHintText([])).toBeNull();

    const hint = outOfRangeHintText([orderingRef()]);
    expect(hint).toContain(`«${ORDERING.name}»`);
    expect(hint).toContain('реестре выдач');
  });

  it('подсказка набора называет состав правами, а сквозную область — отдельной фразой', () => {
    const label = (permission: Permission): string => PERMISSION_CATALOG[permission].label;

    // Пользовательский набор: только состав — области он не меняет.
    const custom = grantCompositionText(CUSTOM);
    expect(custom).toContain(label('audit.read'));
    expect(custom).not.toContain('Область');

    // «Согласование ИТ» отличается от прочих не правом, а тем, что видит модуль целиком, минуя
    // область роли. Умолчи форма об этом — визу ИТ выдавали бы, считая, что человек останется в
    // своём отделе.
    const system = grantCompositionText(SYSTEM);
    expect(system).toContain(label('serviceRequests.approveIt'));
    expect(system).toContain('Область');
    expect(system).toContain('видит эти разделы целиком');

    // Пустой набор доступа не даёт, и сказать это надо словами, а не пустой строкой состава.
    expect(grantCompositionText({ ...CUSTOM, permissions: [] })).toContain('Прав в наборе нет');
  });
});
