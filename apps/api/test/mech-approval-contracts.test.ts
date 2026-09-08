import { describe, expect, it } from 'vitest';
import {
  approvesOwnMechRequestOnCreate,
  canApproveMechRequest,
  isMechApprovalChangeable,
  isMechAwaitingApproval,
  mechRequestHistoryQuerySchema,
  mechRequestListQuerySchema,
  mechStateTag,
  mechStateTagLabels,
  mechTransitionBlocker,
  setMechRequestApprovalSchema,
  type MechApprovalSubject,
  type MechTransitionState,
  type Role,
} from '@technic/contracts';

/**
 * Контракт визы площадки в модуле механизации (план
 * `docs/mechanization-approval-and-grants-plan.md`, Р3, Р5, Р6, Р13).
 *
 * Здесь проверяется то, что живёт в контрактах и обязано отвечать ОДИНАКОВО порталу и серверу:
 * барьер входа в работу, область подписи, автовиза подачей, тег состояния и форма фильтра.
 * Область на живых строках — вопрос к `mech-approval.db.test.ts`: доказать, что ручка отвечает
 * 403 именно тому, кому надо, можно только запросом.
 */

/** Заявка в состоянии «Новая»: срок и факт барьеру визы безразличны, важны статус и подпись. */
const NEW: MechTransitionState = {
  status: 'new',
  actualFrom: null,
  actualTo: null,
  approvedAt: null,
};

const OBJECT_ID = 'obj-1';
const OTHER_OBJECT_ID = 'obj-2';
const DEPARTMENT_ID = 'dep-1';

/** Субъект с ролью и обеими осями области — то, чем спрашивают и портал, и сервер. */
const subject = (
  role: Role,
  scope: Partial<
    Pick<MechApprovalSubject, 'constructionObjectIds' | 'departmentIds' | 'departmentObjectIds'>
  > = {},
): MechApprovalSubject => ({
  role,
  constructionObjectIds: [],
  departmentIds: [],
  departmentObjectIds: [],
  ...scope,
});

describe('барьер входа в работу (Р3)', () => {
  it('незавизированную «Новую» в работу не берут', () => {
    expect(mechTransitionBlocker(NEW, 'confirmed')).toMatch(/после визы/);
  });

  it('завизированную — берут', () => {
    expect(
      mechTransitionBlocker({ ...NEW, approvedAt: '2026-09-08T10:00:00.000Z' }, 'confirmed'),
    ).toBeNull();
  });

  /**
   * Отмена визы не требует, и это решение, а не пропуск: заявку, которую не согласовали, закрывают
   * именно отменой, и запрет оставил бы её висеть в списке навсегда.
   */
  it('отменить незавизированную заявку можно', () => {
    expect(mechTransitionBlocker(NEW, 'cancelled')).toBeNull();
  });

  /**
   * Откат «Выполнена» → «В работе» барьером не запирается: аренда уже состоялась, откатом её
   * открывают, чтобы поправить факт. У заявок старше визы подписи нет и взяться ей неоткуда —
   * требуй барьер её здесь, вся прошлая история модуля стала бы неисправимой.
   */
  it('откат из «Выполнена» визы не требует', () => {
    const done: MechTransitionState = {
      status: 'done',
      actualFrom: '2026-08-01',
      actualTo: '2026-08-20',
      approvedAt: null,
    };
    expect(mechTransitionBlocker(done, 'confirmed')).toBeNull();
  });

  /** Барьеры факта (Р2 модуля) виза не отменяет: они про выданную технику и живут своей веткой. */
  it('выданную технику по-прежнему нельзя отменить, даже завизированную', () => {
    const issued: MechTransitionState = {
      status: 'confirmed',
      actualFrom: '2026-09-01',
      actualTo: null,
      approvedAt: '2026-08-31T09:00:00.000Z',
    };
    expect(mechTransitionBlocker(issued, 'cancelled')).toMatch(/завершить/);
  });
});

describe('когда визу ставят и снимают (Р3)', () => {
  it('только у «Новой»', () => {
    expect(isMechApprovalChangeable('new')).toBe(true);
    for (const status of ['confirmed', 'done', 'cancelled'] as const) {
      expect(isMechApprovalChangeable(status), status).toBe(false);
    }
  });
});

describe('область визы (Р5)', () => {
  const target = { objectId: OBJECT_ID, departmentId: null };
  const departmentTarget = { objectId: OBJECT_ID, departmentId: DEPARTMENT_ID };

  it('без права визы не визирует никто, даже на своей площадке', () => {
    const shtab = subject('shtab', { constructionObjectIds: [OBJECT_ID] });
    expect(canApproveMechRequest(shtab, target)).toBe(false);
  });

  it('ответственный площадки визирует свою площадку и не визирует чужую', () => {
    const rukstroy = subject('rukstroy', { constructionObjectIds: [OBJECT_ID] });
    expect(canApproveMechRequest(rukstroy, target)).toBe(true);
    expect(canApproveMechRequest(rukstroy, { objectId: OTHER_OBJECT_ID, departmentId: null })).toBe(
      false,
    );
  });

  /**
   * Заявку отдела на площадке подписывают ОБА — в этом и состоит ответ заказчика «площадка или
   * руководитель отдела, кто первый»: поле визы одно, и вторая подпись поверх первой не нужна.
   */
  it('заявку отдела визируют и площадка, и руководитель этого отдела', () => {
    const rukstroy = subject('rukstroy', { constructionObjectIds: [OBJECT_ID] });
    const head = subject('department_head', {
      departmentIds: [DEPARTMENT_ID],
      departmentObjectIds: [OBJECT_ID],
    });
    expect(canApproveMechRequest(rukstroy, departmentTarget)).toBe(true);
    expect(canApproveMechRequest(head, departmentTarget)).toBe(true);
  });

  /**
   * Заявку САМОЙ площадки руководитель отдела не подписывает никогда, даже если площадка
   * закреплена за его отделом: его сторона — заявитель, а у такой заявки заявителя-отдела нет.
   * Ветвление по оси роли только это и означает — дизъюнкция «объект ИЛИ отдел» отдала бы ему
   * чужие заявки.
   */
  it('заявку без отдела руководитель отдела не визирует', () => {
    const head = subject('department_head', {
      departmentIds: [DEPARTMENT_ID],
      departmentObjectIds: [OBJECT_ID],
    });
    expect(canApproveMechRequest(head, target)).toBe(false);
  });

  /** Площадку могли снять с отдела после заведения заявки — подпись уходит вместе с ней. */
  it('снятая у отдела площадка закрывает и прежнюю заявку этого отдела', () => {
    const head = subject('department_head', {
      departmentIds: [DEPARTMENT_ID],
      departmentObjectIds: [],
    });
    expect(canApproveMechRequest(head, departmentTarget)).toBe(false);
  });

  it('роль без своей оси (администратор) не ограничена ничем', () => {
    expect(canApproveMechRequest(subject('admin'), target)).toBe(true);
  });

  it('субъекта нет вовсе — визы нет', () => {
    expect(canApproveMechRequest(null, target)).toBe(false);
  });
});

describe('автовиза подачей (Р6)', () => {
  const target = { objectId: OBJECT_ID, departmentId: null };

  it('заявка ответственного площадки согласована самим заведением', () => {
    const rukstroy = subject('rukstroy', { constructionObjectIds: [OBJECT_ID] });
    expect(approvesOwnMechRequestOnCreate(rukstroy, target)).toBe(true);
  });

  it('руководитель отдела так же подписывает заявку своего отдела', () => {
    const head = subject('department_head', {
      departmentIds: [DEPARTMENT_ID],
      departmentObjectIds: [OBJECT_ID],
    });
    expect(
      approvesOwnMechRequestOnCreate(head, { objectId: OBJECT_ID, departmentId: DEPARTMENT_ID }),
    ).toBe(true);
  });

  /**
   * Администратор под правило не подпадает (ADR 0032): он заводит заявку за того, кто до портала
   * не добрался, и согласования этим не происходит — иначе визу обходили бы просьбой «заведи за
   * меня».
   */
  it('администратор свою заявку не визирует автоматически', () => {
    expect(approvesOwnMechRequestOnCreate(subject('admin'), target)).toBe(false);
  });

  it('заказчик без права визы — тем более', () => {
    const shtab = subject('shtab', { constructionObjectIds: [OBJECT_ID] });
    expect(approvesOwnMechRequestOnCreate(shtab, target)).toBe(false);
  });
});

describe('тег состояния и фильтр (Р13)', () => {
  it('«ждёт визы» — у неподписанной «Новой», и только у неё', () => {
    expect(isMechAwaitingApproval(NEW)).toBe(true);
    expect(mechStateTag(NEW)).toBe('awaitingApproval');
    expect(mechStateTagLabels.awaitingApproval).toBe('ждёт визы');
    expect(mechStateTag({ ...NEW, approvedAt: '2026-09-08T10:00:00.000Z' })).toBeNull();
  });

  /**
   * Состояния «В работе» тег визы не перебивает: у подписанной заявки, ждущей подачи, вопрос
   * другой — «где техника», — и он важнее уже отвеченного.
   */
  it('состояния аренды остаются прежними', () => {
    const awaitingIssue: MechTransitionState = {
      status: 'confirmed',
      actualFrom: null,
      actualTo: null,
      approvedAt: '2026-09-01T08:00:00.000Z',
    };
    expect(mechStateTag(awaitingIssue)).toBe('awaitingIssue');
  });

  it('фильтр визы есть и в списке, и в журнале', () => {
    expect(mechRequestListQuerySchema.parse({ approved: 'false' }).approved).toBe(false);
    expect(mechRequestHistoryQuerySchema.parse({ approved: 'true' }).approved).toBe(true);
    // Без параметра — «любая»: три состояния отбора, а не переключатель.
    expect(mechRequestListQuerySchema.parse({}).approved).toBeUndefined();
  });
});

describe('тело ручки визы (Р3)', () => {
  it('принимает флаг и версию', () => {
    expect(setMechRequestApprovalSchema.parse({ approved: false, version: 3 })).toEqual({
      approved: false,
      version: 3,
    });
  });

  it('версия обязательна: без неё CAS не существует', () => {
    expect(setMechRequestApprovalSchema.safeParse({ approved: true }).success).toBe(false);
  });

  it('лишних полей не принимает — тело строгое', () => {
    expect(
      setMechRequestApprovalSchema.safeParse({ approved: true, version: 1, comment: 'ок' }).success,
    ).toBe(false);
  });
});
