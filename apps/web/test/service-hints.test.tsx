import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import {
  type AuthUser,
  canCoordinateServiceRequests,
  MODULE_GRANTS,
  OFFICE_EQUIPMENT_EXECUTOR_GRANT,
} from '@technic/contracts';
import { serviceClosingDocumentHint, ServiceHint } from '@entities/service-request';
import { mockHttp } from './http';
import { renderWithUser } from './render';
import {
  SERVICE_COUNTERPARTY,
  serviceCustomer,
  serviceExecutor,
  serviceOperator,
  serviceRequest,
  serviceRequestFile,
} from './factories/service';
import { useAuth } from '../src/auth/AuthContext';
import { ServiceRequestDocuments } from '../src/pages/service/ServiceRequestDocuments';
import { ServiceRequestEstimate } from '../src/pages/service/ServiceRequestEstimate';
import { ServiceRequestSubjectName } from '../src/pages/service/ServiceRequestSubjectName';

/**
 * Тише подсказки: одно правило на все плашки модуля (план
 * `docs/office-equipment-card-and-list-cleanup-plan.md`, Р11, Р12; просьба заказчика 08.09.2026,
 * п. 3).
 *
 * Правило одно, а мест одиннадцать, поэтому проверяется оно в двух срезах.
 *
 * ПЕРВЫЙ — МАТРИЦА: четыре аудитории модуля против трёх уровней подсказки. Она закрепляет и ответ
 * предиката контрактов на каждой учётке (`canCoordinateServiceRequests`), и поведение компонента.
 * Порознь эти две половины зелены и бессмысленны: компонент, которому всегда передают `true`,
 * ведёт себя безупречно и показывает всё всем.
 *
 * ВТОРОЙ — ПРОВОДКА: два настоящих экрана, где признак считает вызывающий. Он и есть предмет Н14 —
 * `ServiceHint` живёт в `entities` и прав не спрашивает, поэтому единственный способ ошибиться —
 * передать сюда не то булево. Экрана два, потому что случая два: предупреждение, которое обязано
 * СВЕРНУТЬСЯ, и пояснение, которое обязано ИСЧЕЗНУТЬ.
 */

/** Заявитель: штаб своей площадки без единой надстройки — заявки заводит, решений не принимает. */
const REQUESTER = serviceCustomer();

/**
 * Внутренний исполнитель — набор `office_equipment_executor` И БОЛЬШЕ НИЧЕГО.
 *
 * Собран здесь, а не взят готовой фикстурой: `serviceInHouseExecutor` описывает профиль
 * «Системный администратор» целиком, то есть вместе с надстройкой ИТ-службы, а у той
 * `serviceRequests.assign` есть — она координатор. Проверяй мы им «исполнитель подсказок не
 * видит», сценарий отвечал бы про другого человека и был бы зелен по ошибке.
 */
const IN_HOUSE: AuthUser = serviceCustomer({
  id: 'user-executor',
  grantCodes: [OFFICE_EQUIPMENT_EXECUTOR_GRANT],
  grantPermissions: [...MODULE_GRANTS.office_equipment_executor.permissions],
});

/** Оператор сервисной компании: свой коридор даёт тип контрагента, `assign` в нём нет (Р11). */
const SERVICE_SIDE = serviceExecutor();

/** Тот, кто ведёт заявки: держатель `serviceRequests.assign` — ему всё остаётся как было. */
const COORDINATOR = serviceOperator();

/** Плашки antd на экране: у них есть и заголовок, и описание, у свёрнутой строки — только текст. */
const alerts = (): Element[] => [...document.querySelectorAll('.ant-alert')];

/**
 * Все три уровня разом — так же, как их зовут настоящие окна: признак считает вызывающий по
 * `useAuth`, а компонент получает готовое булево.
 */
function Hints() {
  const { user } = useAuth();
  const coordinator = canCoordinateServiceRequests(user);
  return (
    <>
      <ServiceHint
        coordinator={coordinator}
        level="info"
        title="ПОЯСНЕНИЕ"
        description="ПОДРОБНОСТИ"
      />
      <ServiceHint
        coordinator={coordinator}
        level="success"
        title="ПОЗДРАВЛЕНИЕ"
        description="ПОДРОБНОСТИ"
      />
      <ServiceHint
        coordinator={coordinator}
        level="warning"
        title="ПРЕДУПРЕЖДЕНИЕ"
        description="ПОДРОБНОСТИ"
      />
    </>
  );
}

describe('матрица подсказок: кто что видит (Р11)', () => {
  it.each([
    ['заявитель', REQUESTER],
    ['внутренний исполнитель', IN_HOUSE],
    ['оператор сервисной компании', SERVICE_SIDE],
  ] as const)('%s: пояснений нет вовсе, предупреждение — одной строкой', (_name, user) => {
    // Половина утверждения — про предикат: сместись он, и вся подача поехала бы вместе с ним.
    expect(canCoordinateServiceRequests(user)).toBe(false);

    renderWithUser(<Hints />, { user });

    expect(screen.queryByText('ПОЯСНЕНИЕ')).toBeNull();
    expect(screen.queryByText('ПОЗДРАВЛЕНИЕ')).toBeNull();
    // Причина блокировки не исчезает — иначе человек упёрся бы в погашенную кнопку без единого
    // слова на экране.
    expect(screen.getByText('ПРЕДУПРЕЖДЕНИЕ')).toBeDefined();
    // И сворачивается она целиком: ни плашки, ни развёрнутого описания правила.
    expect(alerts()).toHaveLength(0);
    expect(screen.queryByText('ПОДРОБНОСТИ')).toBeNull();
  });

  it('тому, кто ведёт заявки, всё остаётся как сейчас', () => {
    expect(canCoordinateServiceRequests(COORDINATOR)).toBe(true);

    renderWithUser(<Hints />, { user: COORDINATOR });

    expect(alerts()).toHaveLength(3);
    expect(screen.getByText('ПОЯСНЕНИЕ')).toBeDefined();
    expect(screen.getByText('ПОЗДРАВЛЕНИЕ')).toBeDefined();
    expect(screen.getByText('ПРЕДУПРЕЖДЕНИЕ')).toBeDefined();
    // Текст не урезан: описание правила — то, ради чего разбирающий чужую очередь плашку и читает.
    expect(screen.getAllByText('ПОДРОБНОСТИ')).toHaveLength(3);
  });
});

// ── Проводка признака на настоящих экранах ─────────────────────────────────

/** Работы предъявлены подрядчиком, закрывающей бумаги нет ни одной: warning вкладки документов. */
const AWAITING = serviceRequest({
  status: 'done',
  service: { ...SERVICE_COUNTERPARTY },
  files: [serviceRequestFile('attachment')],
});

/** Сообщение о технике на проверке: info карточки, видимый в том числе заявителю. */
const ON_CHECK = serviceRequest({
  equipment: null,
  equipmentCandidate: {
    id: 'oec-1',
    status: 'pending',
    declaredModel: 'Kyocera M3145',
    serialNumber: '',
    inventoryNumber: '0012345',
    decisionReason: '',
  },
});

/**
 * Планка наследия: у заявки без документной ревизии перечень видов прежний — три. Текст берётся
 * функцией, а не строкой: он считается по формату (Р5), и константы для него больше нет.
 */
const AWAITING_HINT = serviceClosingDocumentHint(null);

describe('признак координатора считает вызывающий (Н14)', () => {
  it('вкладка документов: исполнителю и подрядчику — строка, ведению — плашка с описанием', () => {
    mockHttp({});
    renderWithUser(<ServiceRequestDocuments request={AWAITING} />, { user: IN_HOUSE });

    expect(screen.getByText(AWAITING_HINT)).toBeDefined();
    expect(alerts()).toHaveLength(0);
    expect(screen.queryByText(/Ожидаются документы/)).toBeNull();
  });

  it('она же у оператора сервисной компании', () => {
    mockHttp({});
    renderWithUser(<ServiceRequestDocuments request={AWAITING} />, { user: SERVICE_SIDE });

    expect(screen.getByText(AWAITING_HINT)).toBeDefined();
    expect(alerts()).toHaveLength(0);
  });

  it('она же у ведения — прежней плашкой', () => {
    mockHttp({});
    renderWithUser(<ServiceRequestDocuments request={AWAITING} />, { user: COORDINATOR });

    expect(alerts()).toHaveLength(1);
    expect(screen.getByText(AWAITING_HINT)).toBeDefined();
    // Описание на месте: очередь «Ожидаются документы» разбирают именно по нему.
    expect(screen.getByText(/Ожидаются документы/)).toBeDefined();
  });

  it('«аппарат на проверке» заявителю не показывается, а ведению показывается', () => {
    renderWithUser(<ServiceRequestSubjectName request={ON_CHECK} />, { user: REQUESTER });
    // Сам предмет назван по-прежнему: убирается пояснение о ходе проверки, а не данные заявки.
    expect(screen.getAllByText(/Kyocera M3145/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/На проверке/)).toBeNull();
    expect(alerts()).toHaveLength(0);

    renderWithUser(<ServiceRequestSubjectName request={ON_CHECK} />, { user: COORDINATOR });
    expect(screen.getByText(/На проверке/)).toBeDefined();
  });
});

// ── Историческая вкладка объёма работ ──────────────────────────────────────

/** Строка объёма работ: содержимое здесь неважно — важно, что таблице есть что показать. */
const ITEM = {
  id: 'sri-1',
  kind: 'part' as const,
  name: 'Ролик подачи',
  quantity: 1,
  unitPrice: 1800,
  amount: 1800,
  performed: null,
  actualQuantity: null,
  actualAmount: null,
  warrantyMonths: null,
  warrantyUntil: null,
  warrantyUntilManual: false,
};

/** Кто подписал прошлую ревизию: снимок согласования, объясняющий, на каком основании работали. */
const APPROVAL = {
  by: 'user-2',
  byName: 'Операторов О. О.',
  at: '2026-08-05T10:00:00.000Z',
  revision: 1,
};

/**
 * Вкладка «Объём работ» внутренней заявки, у которой ревизия осталась от прошлого (Р7).
 *
 * До этой волны согласование проходил ЛЮБОЙ ремонт, поэтому строки у внутренней заявки бывают, и
 * прятать их нельзя — это основание уже принятого решения. Но шага по ним больше нет, и обычная
 * плашка состояния соврала бы в любом из трёх своих видов: «ждём решения» звало бы согласующего,
 * которого после снятия этапа не существует.
 *
 * Сохранившийся в БД `estimatePendingRevision` у фикстуры непуст намеренно: именно он и есть
 * находка Н11 — сырая колонка, которую очередь и вкладка обязаны перестать считать рабочим
 * ожиданием.
 */
const HISTORICAL_INTERNAL = serviceRequest({
  status: 'in_work',
  // Подрядчика нет — заявку ведёт свой сотрудник, и объёма работ у неё не бывает (Р4).
  service: null,
  estimateRevision: 2,
  estimatePendingRevision: 2,
  estimateSubmittedAt: '2026-08-06T09:00:00.000Z',
  estimatedTotalAmount: 1800,
  approval: APPROVAL,
  items: [ITEM],
});

describe('историческая вкладка объёма работ только читается (Р7)', () => {
  const HISTORICAL_LINE = /Исторический объём работ/;

  it('внутренней заявке — нейтральная строка с прошлой подписью, а не состояние ревизии', () => {
    renderWithUser(<ServiceRequestEstimate request={HISTORICAL_INTERNAL} />, {
      user: COORDINATOR,
    });

    expect(screen.getByText(HISTORICAL_LINE)).toBeDefined();
    // Сохранённый pending не объявляется текущим шагом: подписывать его после снятия этапа некому.
    expect(screen.queryByText(/ждём решения/)).toBeNull();
    // Прошлая подпись остаётся рядом: ею объясняется, на каком основании тогда работали.
    expect(screen.getByText(/Согласована ревизия 1/)).toBeDefined();
    // Плашки состояния нет ни у кого — даже у ведения: правда о заявке одна на всех читателей.
    expect(alerts()).toHaveLength(0);
    // Строки при этом видны: спрятать их значило бы стереть основание принятого решения.
    expect(screen.getByText('Ролик подачи')).toBeDefined();
  });

  it('пустая историческая ревизия не обещает, что объём соберёт исполнитель', () => {
    renderWithUser(<ServiceRequestEstimate request={{ ...HISTORICAL_INTERNAL, items: [] }} />, {
      user: COORDINATOR,
    });

    expect(screen.getByText(HISTORICAL_LINE)).toBeDefined();
    expect(screen.queryByText(/собирает исполнитель/)).toBeNull();
  });

  it('у заявки подрядчика состояние ревизии остаётся прежним', () => {
    renderWithUser(
      <ServiceRequestEstimate
        request={{ ...HISTORICAL_INTERNAL, service: { ...SERVICE_COUNTERPARTY } }}
      />,
      { user: COORDINATOR },
    );

    expect(screen.queryByText(HISTORICAL_LINE)).toBeNull();
    expect(screen.getByText(/Ревизия 2 предъявлена — ждём решения/)).toBeDefined();
    expect(alerts()).toHaveLength(1);
  });
});
