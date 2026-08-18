import {
  type BackdateAccess,
  isObjectScopedRole,
  isWeeklyWeekOverdue,
  type Permission,
  type Role,
  selectableWeeks,
  WEEKLY_SELECTABLE_WEEKS,
  weeklyApprovalPermission,
  weeklyWeekBlocker,
} from '@technic/contracts';
import type { WeeklyDecisionResultDto, WeeklyRequestHistoryEntryDto } from '../../api/resources';
import { weeklyToday } from './weeklyShared';

/**
 * Чем страница недельной заявки отвечает на состояние недели и на исход визы: производные
 * предикаты и формулировки, без единой строки разметки.
 *
 * Отдельным файлом от `WeeklyRequestPage`, потому что это разные вещи по природе. Страница — это
 * состав, четыре мутации и общий разбор их отказов; здесь — правила, у которых нет ни состояния,
 * ни запросов: они считаются от даты, права и ответа сервера. Вперемешку они читаются плохо в обе
 * стороны — тридцать строк объяснения про право прошлого стоят ровно между `useMutation` и
 * `useMutation`, а найти, где страница разбирает 409, приходится через них.
 *
 * Ни один предикат тут не выведен заново. Глубина прошлого, право визы этой недели и просроченность
 * считаются контрактами (`weeklyWeekBlocker`, `weeklyApprovalPermission`, `isWeeklyWeekOverdue`) —
 * теми же, которыми их считает сервер на своих проверках: второй перечень правил на клиенте либо
 * запирал бы то, что ручка примет, либо предлагал то, чем она ответит отказом.
 */

/**
 * Чем экран отвечает на состоявшееся решение. Отдельной функцией, а не лесенкой условий в
 * `onSuccess`: случаев стало четыре — отказ, обычная виза, проведение задним числом и его повтор.
 *
 * Повтор отличать обязательно. У проведения пустой `apply` означает не «ни одна строка не
 * применилась», а «эту операцию уже выполнил прежний запрос» (Р31 ADR 0101): связь оборвалась,
 * человек нажал второй раз, и сроки при этом никто второй раз не двигал. Общее «Неделя применена»
 * тут прочиталось бы как вторая порция работы, а «строк 0» — как отказ.
 */
export function decisionMessage(
  res: WeeklyDecisionResultDto,
  approved: boolean,
  conducted: boolean,
): string {
  if (!approved) return 'Заявка отклонена и возвращена в черновик';
  if (!res.apply) {
    return conducted
      ? 'Эта операция уже проведена: обрыв связи ничего не задвоил — неделя применена один раз'
      : 'Неделя согласована и применена';
  }
  const what = conducted ? 'Неделя проведена задним числом' : 'Неделя применена';
  return `${what}: строк ${res.apply.applied}, пропущено ${res.apply.skipped}`;
}

/** Что страница знает о неделе заявки: открыта ли она, просрочена ли и кто её визирует. */
export interface WeeklyPageWeekState {
  /** Причина, по которой неделя закрыта для сборки и подачи; `null` — открыта. */
  weekBlocker: string | null;
  /** Ближайшая неделя, на которую заводят следующую заявку. */
  nextWeek: string | undefined;
  overdue: boolean;
  approvesOwn: boolean;
  canApproveWeek: boolean;
  canReject: boolean;
}

/**
 * Состояние недели этой заявки — одним расчётом, потому что все шесть его значений отвечают на один
 * вопрос: что с этой неделей уже нельзя, а что ещё можно.
 *
 * Неделя, до которой черновик дожил, закрыта — но не всем (ADR 0101): у кого есть право прошлого, у
 * того она открывается вместе с его глубиной, и отказа здесь нет вовсе. Права нет — прежний тупик,
 * только с выходом словами: подать и завизировать нельзя, отменить можно всегда (§8). Глубина и
 * границы считаются тем же `weeklyWeekBlocker` и с тем же аргументом доступа, каким их считает
 * сервер на всех пяти своих проверках.
 *
 * Автовиза при подаче — только объектной роли (Р12): администратор под неё не подпадает. У
 * просроченной недели её нет ни у кого (`approvesOwnWeeklyRequest`): проведение требует причины и
 * ключа операции, а тело подачи их не несёт — такая заявка доходит до визы, где их и спрашивают.
 *
 * Право визы **этой** недели: у будущей — `weeklyRequests.approve`, у просроченной — право
 * прошлого. Выбор делает контракт (`weeklyApprovalPermission`) — тот же, которым его делает сервер;
 * своё «если просрочена, то...» разошлось бы с ним при первой же правке правила.
 *
 * Право отказа недели не знает и остаётся прежним: отказ ничего в прошлом не двигает, он возвращает
 * заявку в черновик — и отдать его диспетчеру значило бы отдать ему решение о том, нужна ли технике
 * площадка, то есть ровно то, чего он не решает.
 */
export function weeklyPageWeekState(input: {
  weekStart: string;
  /** Состав ещё собирают: у применённой и снятой заявки неделю запирать не от чего. */
  composable: boolean;
  isPending: boolean;
  backdate: BackdateAccess;
  role: Role | null | undefined;
  can: (permission: Permission) => boolean;
}): WeeklyPageWeekState {
  const { weekStart, composable, isPending, backdate, role, can } = input;
  const today = weeklyToday();
  /** Неделя уже началась или прошла: виза по ней — операция задним числом. */
  const overdue = isWeeklyWeekOverdue(weekStart, today);
  return {
    weekBlocker: composable
      ? weeklyWeekBlocker(weekStart, today, WEEKLY_SELECTABLE_WEEKS, backdate)
      : null,
    nextWeek: selectableWeeks(today)[0],
    overdue,
    approvesOwn: !overdue && isObjectScopedRole(role) && can('weeklyRequests.approve'),
    canApproveWeek: can(weeklyApprovalPermission(weekStart, today)) && isPending,
    canReject: can('weeklyRequests.approve') && isPending,
  };
}

/** Причина отклонения показывается сверху в самой заявке, а не только в истории (§5 шаг 5). */
export function lastRejectionComment(
  entries: WeeklyRequestHistoryEntryDto[] | undefined,
): string | null {
  return (
    (entries ?? [])
      .filter((e) => e.event === 'status' && e.toStatus === 'draft' && e.comment)
      .at(-1)?.comment ?? null
  );
}

/**
 * Уход со страницы с несохранённым составом (§9). Текстом, а не пересказом «есть изменения»: не
 * сохранится ровно то, что человек только что делал руками, — решения по строкам и добавленная
 * техника, — и назвать это он должен успеть до того, как нажмёт «Уйти».
 */
export const WEEKLY_LEAVE_CONFIRM = {
  title: 'Уйти, не сохранив состав?',
  content: 'Решения по строкам и добавленная техника не сохранятся.',
  okText: 'Уйти',
  okButtonProps: { danger: true },
  cancelText: 'Остаться',
};

/**
 * Подписи окна причины: отказ и снятие — разные действия, и обещают они разное. Причина отказа
 * возвращается составителю на видное место в самой заявке, причина снятия остаётся историей —
 * человек должен понимать, кому он сейчас пишет.
 */
export function weeklyReasonText(reject: boolean): {
  title: string;
  label: string;
  okText: string;
  placeholderHint: string;
} {
  return reject
    ? {
        title: 'Отклонить недельную заявку',
        label: 'Причина',
        okText: 'Отклонить',
        placeholderHint: 'Причина покажется составителю сверху в самой заявке',
      }
    : {
        title: 'Снять недельную заявку',
        label: 'Причина',
        okText: 'Снять',
        placeholderHint: 'Причина останется в истории заявки',
      };
}
