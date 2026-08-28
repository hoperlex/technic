import { describe, expect, it } from 'vitest';
import {
  ACCESS_PROFILES,
  type AccessSubject,
  accessProfileLabel,
  audienceMatches,
  canWriteChat,
  isServiceRequestClosed,
  markServiceChatReadSchema,
  participantSidesOf,
  profilesWith,
  SERVICE_CHAT_SIDES,
  SERVICE_REQUEST_STATUSES,
  sendServiceChatMessageSchema,
  type ServiceChatFacts,
  serviceChatPageQuerySchema,
  type ServiceChatSide,
  serviceChatSideLabels,
} from '@technic/contracts';

/**
 * Стороны обсуждения заявки на обслуживание оргтехники (`office-equipment-chat-plan.md` §3.1).
 *
 * Проверяется перебором `ACCESS_PROFILES`, а не двумя примерами, и это главное решение теста. Обе
 * поломки первой редакции плана — не ошибка в формуле, а СУБЪЕКТ, О КОТОРОМ НЕ ПОДУМАЛИ: подрядчик,
 * у которого право `serviceRequests.status` есть по типу контрагента, и коллега по отделу, которому
 * реплика «Заявителю» адресована, но разговор он не ведёт. Пример их не ловит — он подтверждает то,
 * что автор и так держал в голове; перебор ловит, потому что новый субъект портала обязан появиться
 * в одном из списков ниже и уронить сравнение.
 *
 * Формулы сторон живут в контракте, а факты приходят аргументом (§3.2): у `AccessSubject` нет ни id
 * учётки, ни областей, ни назначения, — поэтому «заказчик» и «исполнитель» здесь проверяются
 * фактами, а «Ведение» и ИТ-служба — правами.
 */

const ME = '11111111-1111-4111-8111-111111111111';
const SOMEONE_ELSE = '22222222-2222-4222-8222-222222222222';

/** Никто ни к заявке, ни к её сторонам отношения не имеет: чистые права без единого факта. */
const NO_FACTS: ServiceChatFacts = {
  userId: ME,
  isAuthor: false,
  inCustomerScope: false,
  actsForAssignedService: false,
  isNamedExecutor: false,
};

const facts = (over: Partial<ServiceChatFacts>): ServiceChatFacts => ({ ...NO_FACTS, ...over });

const admin: AccessSubject = { role: 'admin' };
const serviceCompany: AccessSubject = { role: 'operator', counterpartyType: 'service' };
const management: AccessSubject = { role: 'shtab', addons: ['office_equipment_operator'] };
const itService: AccessSubject = { role: 'shtab', addons: ['office_equipment_it_approver'] };
const observer: AccessSubject = { role: 'observer' };
const colleague: AccessSubject = { role: 'department' };

const participantsIn = (side: ServiceChatSide, f: ServiceChatFacts = NO_FACTS): string[] =>
  ACCESS_PROFILES.filter((subject) => participantSidesOf(subject, f).includes(side)).map(
    accessProfileLabel,
  );

const audienceOf = (side: ServiceChatSide, f: ServiceChatFacts = NO_FACTS): string[] =>
  ACCESS_PROFILES.filter((subject) => audienceMatches({ side }, subject, f)).map(
    accessProfileLabel,
  );

describe('Стороны обсуждения — перебор ACCESS_PROFILES', () => {
  it('словарь сторон и подписи не разъезжаются', () => {
    expect(Object.keys(serviceChatSideLabels)).toEqual([...SERVICE_CHAT_SIDES]);
  });

  /**
   * Сторона «Ведение» — конъюнкция `status` и `assign` (§3.1). Ровно четыре субъекта: администратор
   * и три базовые роли с набором «Оргтехника: ведение». Субъект, попавший сюда молча, увидит яркими
   * реплики, адресованные администратору модуля, — поэтому список точный, а не «содержит».
   */
  it('сторона «Ведение» — администратор и набор «Оргтехника: ведение», и никто больше', () => {
    expect(participantsIn('operator')).toEqual([
      'Администратор',
      'Штаб + Оргтехника: ведение',
      'Площадка + Оргтехника: ведение',
      'Отдел + Оргтехника: ведение',
    ]);
    // Аудитория и участие у этой стороны совпадают: расходится только `customer` (§3.1).
    expect(audienceOf('operator')).toEqual(participantsIn('operator'));
  });

  /**
   * ПОЛОМКА 1 ПЕРВОЙ РЕДАКЦИИ. `serviceRequests.status` есть у типа контрагента `service` — оно
   * открывает подрядчику его половину цикла. Одного этого права хватило бы, чтобы сервисная
   * компания стала «Ведением»; формулу спасает второй сомножитель `assign` и явное исключение по
   * типу контрагента. Тест держит обе половины: первое сравнение доказывает, что право у
   * подрядчика действительно есть, — иначе проверка ниже проходила бы по пустой причине.
   */
  it('подрядчик не «Ведение», хотя право serviceRequests.status у него есть', () => {
    expect(profilesWith('serviceRequests.status').map(accessProfileLabel)).toContain(
      'Оператор (внешний исполнитель) — Сервисная компания',
    );
    expect(participantsIn('operator')).not.toContain(
      'Оператор (внешний исполнитель) — Сервисная компания',
    );
    expect(audienceMatches({ side: 'operator' }, serviceCompany, NO_FACTS)).toBe(false);
    // Своя сторона приходит к нему фактом назначения, а не правом: до назначения он в заявке никто.
    expect(participantSidesOf(serviceCompany, NO_FACTS)).toEqual([]);
    expect(participantSidesOf(serviceCompany, facts({ actsForAssignedService: true }))).toEqual([
      'service',
    ]);
  });

  /**
   * Второй рубеж той же поломки — и его перебором `ACCESS_PROFILES` не поймать: такого субъекта в
   * перечне нет и быть не может (наборы полномочий собираются в базе, ADR 0106). Случай ровно один:
   * подрядчику ВЫДАЛИ набор «Ведение» руками. Конъюнкция прав его уже не спасает — оба права у
   * человека есть, — и без исключения по типу контрагента исполнитель стал бы заказчиком
   * собственной работы: принимал бы её и согласовывал бы свою же смету глазами «Ведения».
   */
  it('подрядчик с выданным набором «Ведение» остаётся исполнителем', () => {
    const contractorWithGrant: AccessSubject = {
      ...serviceCompany,
      grantPermissions: ['serviceRequests.status', 'serviceRequests.assign'],
    };
    expect(participantSidesOf(contractorWithGrant, NO_FACTS)).toEqual([]);
    expect(audienceMatches({ side: 'operator' }, contractorWithGrant, NO_FACTS)).toBe(false);
    // Тот же набор у своего сотрудника «Ведением» делает: исключение по типу контрагента, а не по
    // происхождению права.
    expect(
      participantSidesOf(
        { role: 'shtab', grantPermissions: ['serviceRequests.status', 'serviceRequests.assign'] },
        NO_FACTS,
      ),
    ).toEqual(['operator']);
  });

  it('сторона ИТ-службы — виза `approveIt`: администратор и набор «ИТ-служба»', () => {
    expect(participantsIn('it')).toEqual([
      'Администратор',
      'Штаб + Оргтехника: ИТ-служба',
      'Площадка + Оргтехника: ИТ-служба',
      'Отдел + Оргтехника: ИТ-служба',
    ]);
    expect(audienceOf('it')).toEqual(participantsIn('it'));
    // Администратор попадает и в «Ведение», и в ИТ-службу — осознанно (§3.1): он обладает всеми
    // правами, и золотой бейдж «ждёт меня» получает по той же причине. Второе правило про админа,
    // расходящееся с первым, было бы хуже совпадения.
    expect(participantSidesOf(admin, NO_FACTS)).toEqual(['operator', 'it']);
  });

  /**
   * Сторону заказчика и сторону исполнителя правами не вывести ни у одного субъекта портала: это
   * свойства ЗАЯВКИ («он её завёл», «его контрагенту она назначена», «он в списке исполнителей»), а
   * не учётки. Перебор доказывает это разом: без фактов сторон нет ни у кого, с фактом — у каждого.
   */
  it('заказчик и исполнитель считаются фактами, а не правами', () => {
    expect(participantsIn('customer')).toEqual([]);
    expect(participantsIn('service')).toEqual([]);
    const everyone = ACCESS_PROFILES.map(accessProfileLabel);
    expect(participantsIn('customer', facts({ isAuthor: true }))).toEqual(everyone);
    expect(participantsIn('service', facts({ actsForAssignedService: true }))).toEqual(everyone);
    // Поимённый исполнитель — вторая половина дизъюнкции: инхаус-ремонт ИТ-службы держит сторону
    // сервиса без всякого контрагента.
    expect(participantSidesOf(itService, facts({ isNamedExecutor: true }))).toEqual([
      'it',
      'service',
    ]);
  });

  /**
   * ПОЛОМКА 2 ПЕРВОЙ РЕДАКЦИИ. Аудитория «Заявителю» шире участия намеренно: реплика бьёт по всей
   * стороне заказчика, чтобы вопрос не завис, пока автор в отпуске. Но коллега по отделу и
   * наблюдатель разговора не ведут — иначе они получили бы и поле ввода, и блёклую точку на каждую
   * чужую реплику, то есть шум без действия.
   */
  it('наблюдатель в области заказчика — в аудитории «Заявителю», но не участник', () => {
    const watching = facts({ inCustomerScope: true });
    expect(audienceOf('customer', watching)).toEqual(ACCESS_PROFILES.map(accessProfileLabel));
    expect(participantsIn('customer', watching)).toEqual([]);
    for (const subject of [observer, colleague]) {
      expect(audienceMatches({ side: 'customer' }, subject, watching)).toBe(true);
      expect(participantSidesOf(subject, watching)).toEqual([]);
      expect(canWriteChat(subject, watching, 'new')).toBe(false);
    }
    // Автору участие даёт авторство, и только оно: та же учётка, другой факт.
    expect(participantSidesOf(colleague, facts({ isAuthor: true }))).toEqual(['customer']);
  });

  it('«Всем участникам» — адресат, а не сторона: участником all не бывает никто', () => {
    const all = facts({
      isAuthor: true,
      inCustomerScope: true,
      actsForAssignedService: true,
      isNamedExecutor: true,
    });
    for (const subject of ACCESS_PROFILES) {
      expect(participantSidesOf(subject, all), accessProfileLabel(subject)).not.toContain('all');
      // Обратное — тоже правило: «всем» видит каждый, кому видна заявка, включая наблюдателя.
      expect(audienceMatches({ side: 'all' }, subject, NO_FACTS), accessProfileLabel(subject)).toBe(
        true,
      );
    }
  });

  it('поимённый адресат сравнивается с учёткой, а не с правами', () => {
    expect(audienceMatches({ userId: ME }, observer, NO_FACTS)).toBe(true);
    // Всевластие админа поимённой адресации не касается: реплика одному из двух назначенных
    // инженеров не должна подсвечиваться второму (§5, п. 6 плана).
    expect(audienceMatches({ userId: SOMEONE_ELSE }, admin, NO_FACTS)).toBe(false);
  });
});

describe('Право писать', () => {
  it('участник пишет в любой незакрытой заявке и молчит в закрытой', () => {
    const author = facts({ isAuthor: true });
    for (const status of SERVICE_REQUEST_STATUSES) {
      const closed = isServiceRequestClosed(status);
      for (const subject of [admin, management, itService, serviceCompany, colleague]) {
        expect(
          canWriteChat(subject, author, status),
          `${accessProfileLabel(subject)} ${status}`,
        ).toBe(!closed);
      }
      // Замороженная — не закрытая (Р109): в ней написать нужно как раз больше всего.
      if (status === 'on_hold') expect(canWriteChat(management, NO_FACTS, status)).toBe(true);
    }
  });

  it('наблюдателю нельзя ни в одном статусе', () => {
    for (const status of SERVICE_REQUEST_STATUSES) {
      expect(canWriteChat(observer, facts({ inCustomerScope: true }), status), status).toBe(false);
    }
  });

  it('субъекта может не быть вовсе', () => {
    expect(canWriteChat(null, NO_FACTS, 'new')).toBe(false);
    expect(canWriteChat(undefined, facts({ inCustomerScope: true }), 'new')).toBe(false);
  });
});

describe('Схемы ручек обсуждения', () => {
  const message = (over: Record<string, unknown> = {}) => ({
    body: 'Ждём запчасть',
    addressees: { sides: ['all'] },
    ...over,
  });

  it('текст обязателен и подрезан по краям', () => {
    expect(sendServiceChatMessageSchema.safeParse(message({ body: '' })).success).toBe(false);
    expect(sendServiceChatMessageSchema.safeParse(message({ body: '   ' })).success).toBe(false);
    const parsed = sendServiceChatMessageSchema.parse(message({ body: '  Ждём запчасть  ' }));
    expect(parsed.body).toBe('Ждём запчасть');
    // Граница ровно та же, что у снятого «Примечания исполнителя»: длиннее — это документ, и его
    // подшивают вложением.
    expect(
      sendServiceChatMessageSchema.safeParse(message({ body: 'я'.repeat(2000) })).success,
    ).toBe(true);
    expect(
      sendServiceChatMessageSchema.safeParse(message({ body: 'я'.repeat(2001) })).success,
    ).toBe(false);
  });

  it('реплика без адресата не принимается', () => {
    expect(sendServiceChatMessageSchema.safeParse(message({ addressees: {} })).success).toBe(false);
    expect(
      sendServiceChatMessageSchema.safeParse(message({ addressees: { sides: [], users: [] } }))
        .success,
    ).toBe(false);
  });

  it('«Всем участникам» не сочетается ни с чем', () => {
    expect(
      sendServiceChatMessageSchema.safeParse(message({ addressees: { sides: ['all', 'it'] } }))
        .success,
    ).toBe(false);
    expect(
      sendServiceChatMessageSchema.safeParse(
        message({ addressees: { sides: ['all'], users: [SOMEONE_ELSE] } }),
      ).success,
    ).toBe(false);
    // Порознь оба варианта законны: «всем» — умолчание портала, стороны с исполнителем — обычная
    // адресация.
    expect(sendServiceChatMessageSchema.safeParse(message()).success).toBe(true);
    expect(
      sendServiceChatMessageSchema.safeParse(
        message({ addressees: { sides: ['it', 'service'], users: [SOMEONE_ELSE] } }),
      ).success,
    ).toBe(true);
  });

  it('сторона — только из словаря, поимённый адресат — только учётка', () => {
    expect(
      sendServiceChatMessageSchema.safeParse(message({ addressees: { sides: ['manager'] } }))
        .success,
    ).toBe(false);
    expect(
      sendServiceChatMessageSchema.safeParse(message({ addressees: { users: ['иванов'] } }))
        .success,
    ).toBe(false);
  });

  /**
   * Курсор прочтения. Верхней границы у схемы нет намеренно: `throughSeq` сверяется с `lastSeq`
   * самой заявки, и знает его только сервер — он же отвечает 422 на превышение (§3.4, п. 4).
   */
  it('курсор прочтения — целое от нуля', () => {
    expect(markServiceChatReadSchema.safeParse({ throughSeq: 0 }).success).toBe(true);
    expect(markServiceChatReadSchema.safeParse({ throughSeq: 1_000_000 }).success).toBe(true);
    expect(markServiceChatReadSchema.safeParse({ throughSeq: -1 }).success).toBe(false);
    expect(markServiceChatReadSchema.safeParse({ throughSeq: 1.5 }).success).toBe(false);
  });

  it('страница ленты: умолчание 50, потолок 100, номера с единицы', () => {
    expect(serviceChatPageQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(serviceChatPageQuerySchema.parse({ beforeSeq: '12', limit: '20' })).toEqual({
      beforeSeq: 12,
      limit: 20,
    });
    expect(serviceChatPageQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    // Ноль — не «с начала ленты», а ошибка клиента: `CHECK seq > 0`, и принятый молча ноль вернул
    // бы пустую страницу вместо истории.
    expect(serviceChatPageQuerySchema.safeParse({ afterSeq: 0 }).success).toBe(false);
  });
});
