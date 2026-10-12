import type { ServiceRequestDto } from '@technic/contracts';
import { ServiceHint } from '@entities/service-request';
import { DirectDocumentIntro } from './EstimateDocumentWorkflow';

/**
 * What the window will not let anyone do while a submission is pending (R9). One line for both
 * locks, because the lock is one in meaning: the approver signs what they see.
 *
 * Its key is one too — "Вернуть объём работ в правку": that route removes both the signature and
 * the submission, so it is named here word for word. Saying just "not allowed" would send the
 * executor looking for a way out among this window's buttons, where there is none.
 */
const LOCKED_HINT =
  'Отзовите его действием «Вернуть объём работ в правку» — оно снимает и предъявление, и подпись, — и правка откроется снова.';

/**
 * How the breakdown differs from an edit — in words and before the press (R2, customer answer V9
 * of 09.09.2026). The revision is raised by the route, not by the person, and the person must learn
 * it here: the agreed estimate carries a signature, and "Разложить" sends the request for a new one.
 */
const BREAKDOWN_HINT =
  'Раскладка переиздаёт объём работ: у согласованной ревизии поднимется номер, подпись снимется, ' +
  'а заявка уйдёт на согласование заново — под новым составом подписываются отдельно.';

/**
 * Where to take the items from when a DOCUMENT revision is broken down (R8) — the only path of
 * such a request to a sum, warranties and the per-row fact, promised to the person in three places
 * of the portal.
 *
 * Said exactly here, because the breakdown window opens empty: a document revision has no rows at
 * all, and without this line the coordinator would look at an empty table not knowing what to
 * carry over and from where. The invoice lies on the "Документы" tab — the window itself does not
 * show it: a file reader nested in the breakdown window would be a third layer over the card.
 */
const BREAKDOWN_DOCUMENT_HINT =
  'Объём работ подан счётом: строк у ревизии нет, и переносить позиции нужно из самого документа — ' +
  'он на вкладке «Документы» карточки. После раскладки заявка вернётся в обычный порядок: появятся ' +
  'сумма, построчный факт и гарантии.';

/** The explanation above the composition: the lock, the direct document door, or the cycle rules. */
export function EstimateEditorHint({
  request,
  coordinator,
  locked,
  breakdown,
  directDocument,
  workDone,
  warrantyMode,
}: {
  request: ServiceRequestDto;
  /** Who gets the explanations (R11): computed by the caller, the entity layer has no auth. */
  coordinator: boolean;
  locked: boolean;
  breakdown: boolean;
  directDocument: boolean;
  workDone: boolean;
  warrantyMode: boolean;
}) {
  /*
   * A DOCUMENT revision is broken down (R8): no rows on screen and none will come — they are carried
   * over from the invoice. The format is read from the card's field, not inferred from "zero rows":
   * an empty draft looks the same, and the hint would send the coordinator to look for a document
   * that does not exist.
   */
  const documentBreakdown = breakdown && request.estimateFormat === 'document';

  if (locked) {
    /*
     * The lock is explained before the press, not by a 409 in reply. Fields and buttons are
     * disabled, and without this note the window would look broken: the composition is visible
     * but nothing can touch it — the portal must name the reason itself, no server answer will
     * come here any more.
     *
     * It is the reason of a block, so for a non-coordinator it collapses but does NOT disappear
     * (R11): if it disappeared, the executor would be left with disabled fields without a word.
     * The key to the lock goes away with the description, a conscious price of collapsing: taking
     * the submission back is not the executor's right anyway but the coordinator's, whose text
     * stays whole.
     */
    return (
      <ServiceHint
        coordinator={coordinator}
        level="warning"
        title={`Ревизия ${request.estimatePendingRevision} предъявлена и ждёт ответа — правка закрыта`}
        description={`Пока предъявление висит, сервер не примет ни изменённый состав, ни повторное предъявление: согласующий подписывает то, что видит. ${LOCKED_HINT}`}
      />
    );
  }
  if (directDocument) return <DirectDocumentIntro workDone={workDone} />;
  // How the total is counted and what happens to the old signature — an explanation of the cycle
  // rules: outside the coordinator it is not drawn at all, the sum is visible in the window anyway.
  return (
    <ServiceHint
      coordinator={coordinator}
      level="info"
      title={
        breakdown
          ? documentBreakdown
            ? 'Перенесите позиции счёта в графы: строка на позицию, цена на строку'
            : 'Перенесите присланный перечень в графы: строка на позицию, цена на строку'
          : request.estimateRevision > 0
            ? `Ревизия ${request.estimateRevision} уже предъявлялась — следующее предъявление уйдёт ревизией ${request.estimateRevision + 1}`
            : 'Черновик можно сохранять сколько угодно: на согласование уйдёт то, что предъявите'
      }
      description={
        [
          breakdown ? BREAKDOWN_HINT : null,
          documentBreakdown ? BREAKDOWN_DOCUMENT_HINT : null,
          warrantyMode
            ? 'Заявка заведена как гарантийная — работы можно предъявить без оплаты.'
            : null,
          // A new submission devalues the signature (revisions are compared when the works are
          // closed), and the person must learn it before the press, not from a refusal at closing.
          request.approval && !breakdown
            ? `Согласована ревизия ${request.approval.revision}: новое предъявление снимет эту подпись — объём работ придётся согласовать заново.`
            : null,
        ]
          .filter(Boolean)
          .join(' ') || undefined
      }
    />
  );
}
