/**
 * What the two kinds of request have in common: statuses, the history they are shown through and
 * the corridors their transitions may follow (ADR 0012, ADR 0015). «Заказ ТС» and «Вывоз мусора»
 * are slices of their own because their subjects differ — a machine for a day against a container
 * on a site — but the frame around both is one, and it is kept here. Outside the slice it is taken
 * as `@entities/request` and never by an inner module, so the slice can be rebuilt without
 * touching its consumers.
 *
 * Today that frame is the work window of a request (`TimeInput` and its form rule: 07:00–21:00,
 * read out of the contracts) and the two windows the corridor demands a reason for — cancelling a
 * request and rolling it back into «Новую».
 *
 * ONE DIRECTION ONLY, AND THE LINT HOLDS IT. `entities/waste-request` and
 * `entities/vehicle-request` may reach in here — the single permission granted between neighbours
 * of one layer (`eslint.config.mjs`) — and this slice may reach back at neither. The moment
 * `request` imported a kind of request it would stop being the common part: the common half would
 * depend on the particular halves that depend on it, and «common» would come to mean «knows about
 * waste removal». The ban is not left to discipline —
 * `test/fixtures/boundaries/entities/request/bad-uses-waste.ts` fails the run if the permission is
 * ever widened to «neighbours are fine».
 *
 * Nor does any of this belong in `shared`: a work window, a cancellation reason and a status
 * corridor are domain rules read out of the contracts, and the foundation is barred from the
 * contracts on purpose. Copying them into both kinds instead would give the two copies a chance to
 * drift apart silently — which is how transition bans have already been lost here once.
 *
 * The labels of the history itself live in a slice of their own (`@entities/request-history`), and
 * that is not a split of one thing in two: three modules read them, and the third — servicing
 * office equipment — has a cycle of its own (ADR 0085) and no business depending on a slice built
 * for the two kinds.
 */
export { TimeInput, optionalWorkTimeRule } from './ui/TimeInput';
export { CancelReasonModal, RollbackReasonModal } from './ui/RequestReasonModals';

/*
 * Поля контакта ответственного. Маску номера получают пропом: слайс учёток, где маска живёт, здесь
 * сосед по слою, а в фундамент она не уедет, потому что спрашивает контракты о числе цифр. Проп
 * выбран вместо второго написания маски осознанно — разошлись бы они молча, и увидел бы это
 * человек, чей телефон не сохранился.
 *
 * Показ того же контакта в карточке (`ResponsibleValue`) здесь НЕ живёт: домена заявки в нём нет,
 * только имя и номер, и рядом со ссылкой он обходится без пропа вовсе.
 */
export { ResponsibleFields } from './ui/ResponsibleFields';

/*
 * Право на вкладку архива. Здесь потому, что спрашивают его и три модуля напрямую, и по одной
 * обёртке адреса в каждом слайсе заявок, — а этот слайс единственный, читать который обоим видам
 * заявок разрешено матрицей границ.
 */
export { canSeeArchiveTab } from './model/archiveTab';
