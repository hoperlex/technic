import { App, Button, Input, Space, Tooltip, Typography } from 'antd';
import { canCoordinateServiceRequests, type ServiceRequestDto } from '@technic/contracts';
import { ServiceHint } from '@entities/service-request';
import { ViewModal } from '@shared/ui';
import { useAuth } from '../../../auth/AuthContext';
import { useEstimateEditor, type EstimateEditorIntent } from '../model/useEstimateEditor';
import { EstimateFreeFields, EstimateModeSwitch } from './EstimateFreeMode';
import { EstimateRowsGroup } from './EstimateRows';

/**
 * Что окно не даст сделать, пока висит предъявление (Р9). Одна строка на оба замка, потому что
 * замок один по смыслу: согласующий подписывает то, что видит.
 *
 * Ключ от него тоже один — «Вернуть объём работ в правку»: ручка возврата снимает и подпись, и
 * само предъявление, и потому названа здесь дословно. Скажи мы просто «нельзя» — исполнитель
 * искал бы выход в кнопках этого окна, где его нет вовсе.
 */
const LOCKED_HINT =
  'Отзовите его действием «Вернуть объём работ в правку» — оно снимает и предъявление, и подпись, — и правка откроется снова.';

/**
 * Чем раскладка отличается от правки — словами и до нажатия (Р2, ответ В9 заказчика от
 * 09.09.2026). Ревизию поднимает не человек, а сама ручка, и узнать об этом он обязан здесь: под
 * согласованной сметой стоит подпись, и «Разложить» отправляет заявку за новой.
 */
const BREAKDOWN_HINT =
  'Раскладка переиздаёт объём работ: у согласованной ревизии поднимется номер, подпись снимется, ' +
  'а заявка уйдёт на согласование заново — под новым составом подписываются отдельно.';

/**
 * Редактор объёма работ (§9.3): две группы строк либо одна свободная запись, итог на лету.
 *
 * ДВА РЕЖИМА ВВОДА, ОДНА МОДЕЛЬ (план
 * `docs/office-equipment-free-estimate-and-executor-scope-plan.md`, Р1 и Р8). Свободная запись —
 * обычная строка `kind = service`, `quantity = 1`, `unitPrice` = общая стоимость; второго
 * источника суммы не заводится, потому что итог, согласование, акт, факт, реестр гарантий и разбор
 * спора читают строки — вторая дорога заставила бы каждое из шести мест отвечать, какой источник
 * главный. Признака формата в БД нет: разложенная «Ведением» смета оставила бы его ложью.
 *
 * ДВЕ ДВЕРИ, ОДНО ОКНО (Р2). Исполнитель правит черновик (`PUT /:id/estimate`), «Ведение»
 * раскладывает присланный перечень по графам (`PUT /:id/estimate/breakdown`) — и по согласованной
 * ревизии вторая ручка переиздаёт документ. Второго окна для того же набора строк не заводится:
 * оно разошлось бы с этим на первой же правке состава.
 *
 * **Пока предъявление висит, окно не пускает никуда** (Р9). Прежде эту дверь запирал статус:
 * предъявленная смета стояла в «Смете на согласовании», где ни правка состава, ни повторное
 * предъявление были недоступны. Статуса больше нет, замок остался — и оба его засова сервер
 * держит одним признаком `serviceEstimatePending`, отвечая 409. Здесь про это сказано словами и
 * до нажатия: «ошибка сервера» на кнопке «Сохранить» читалась бы как поломка портала, а не как
 * «сначала отзовите предъявление».
 *
 * Состав, версия и три пути отправки живут в `useEstimateEditor` — здесь только то, как это
 * выглядит.
 */
export function EstimateEditorModal({
  request,
  intent = 'estimate',
  onClose,
}: {
  /**
   * `null` — окно закрыто. Открывается в «В работе»: до неё объёму работ взяться неоткуда, а
   * после закрытия работ он уже не правится.
   */
  request: ServiceRequestDto | null;
  /**
   * Чем окно открыли (Р2). Умолчание — правка исполнителя: так его открывали до этой волны, и все
   * прежние входы остаются прежними, не называя себя.
   */
  intent?: EstimateEditorIntent;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const { user } = useAuth();
  const editor = useEstimateEditor({ request, intent, onClose });
  const breakdown = intent === 'breakdown';
  /*
   * Кому положены пояснения (Р11): признак считает вызывающий, а не `ServiceHint`, — слой
   * сущностей `AuthContext` не видит, и правило живёт единственной функцией контрактов.
   */
  const coordinator = canCoordinateServiceRequests(user);
  const warrantyMode = !!request?.warrantyClaim && !breakdown;
  const { locked, mode, rows, issue, pending } = editor;
  const freeRow = rows[0];

  /**
   * Отказ по незаполненному — тостом, и это исключение записано в воротах поимённо (ADR 0094,
   * `check-form-blockers`): полей формы у окна нет — состав живёт состоянием ради итога на лету, —
   * помечать нечего, а список пропусков читается одной строкой под кнопкой. Стоит он ЗДЕСЬ, у
   * разметки, а не в хуке: послабление ворот выдано этому файлу, и разъехавшись, оно потребовало
   * бы второго.
   */
  const refuse = (problem: string | null): boolean => {
    if (!problem) return false;
    message.warning(problem);
    return true;
  };
  /*
   * У ЧЕРНОВИКА СВОЙ ВОПРОС, А НЕ «БЕЗ ВОПРОСОВ» (дефект Д1 тестовой волны). Прежде здесь стояло
   * `if (!asDraft && …)`: черновик уходил как есть — незаконченный набор законно сохранять. В
   * свободном режиме это оказалось дырой: описание без стоимости уходило строкой с подставленным
   * нулём, а при следующем открытии ноль приезжал готовым значением и предъявлялся уже молча. То
   * есть «пусто = 0», отменённое ответом В10, возвращалось в два шага. Черновик остался
   * черновиком: пустую свободную запись сохранять по-прежнему можно, начатую без стоимости —
   * нельзя.
   */
  const submit = (asDraft: boolean) => {
    if (refuse(asDraft ? editor.draftIssue : issue)) return;
    editor.submit(asDraft);
  };
  const runBreakdown = () => {
    if (refuse(issue)) return;
    editor.runBreakdown();
  };

  return (
    <ViewModal
      title={
        request
          ? `${breakdown ? 'Раскладка объёма работ заявки' : 'Объём работ заявки'} ${request.displayNumber}`
          : 'Объём работ'
      }
      open={!!request}
      onClose={onClose}
      width={860}
      destroyOnHidden
      /*
       * У раскладки подвал СВОЙ, а не общий с погашенными кнопками: ни черновика, ни предъявления
       * у «Ведения» нет — прав на них у него не бывает вовсе, — и выключенные кнопки обещали бы
       * действия, которых за этой дверью не существует.
       */
      footer={
        breakdown
          ? [
              <Button
                key="breakdown"
                type="primary"
                loading={editor.breakdownPending}
                disabled={locked}
                onClick={runBreakdown}
              >
                Разложить по графам
              </Button>,
            ]
          : [
              ...(warrantyMode
                ? [
                    <Tooltip
                      key="warranty"
                      title={
                        locked
                          ? 'Объём работ уже предъявлен: пока идёт согласование, предъявить заново нельзя'
                          : editor.filled
                            ? 'Уберите строки: гарантийный ремонт предъявляется без оплаты'
                            : 'Работы по гарантии: заявка уйдёт на согласование с нулевой суммой'
                      }
                    >
                      <span>
                        <Button
                          disabled={locked || editor.filled || pending}
                          loading={editor.warrantyPending}
                          onClick={editor.runWarranty}
                        >
                          Гарантийный ремонт без оплаты
                        </Button>
                      </span>
                    </Tooltip>,
                  ]
                : []),
              <Button key="draft" disabled={locked || pending} onClick={() => submit(true)}>
                Сохранить черновик
              </Button>,
              <Button
                key="submit"
                type="primary"
                loading={editor.saving}
                disabled={locked || editor.warrantyPending}
                onClick={() => submit(false)}
              >
                Предъявить на согласование
              </Button>,
            ]
      }
    >
      {request && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {locked ? (
            /*
             * Замок объясняется до нажатия, а не 409-й в ответ. Поля и кнопки погашены, и без этой
             * врезки окно выглядело бы сломанным: состав виден, а тронуть его нечем — причину
             * этого портал обязан назвать сам, ответ сервера сюда уже не придёт.
             *
             * Это причина блокировки, поэтому у некоординатора она сворачивается, но НЕ исчезает
             * (Р11): исчезни она — исполнитель остался бы с погашенными полями без единого слова.
             * Ключ от замка при этом уходит вместе с описанием, и это осознанная цена свёртки:
             * снять предъявление всё равно вправе не он, а «Ведение», у которого текст остался
             * целым.
             */
            <ServiceHint
              coordinator={coordinator}
              level="warning"
              title={`Ревизия ${request.estimatePendingRevision} предъявлена и ждёт ответа — правка закрыта`}
              description={`Пока предъявление висит, сервер не примет ни изменённый состав, ни повторное предъявление: согласующий подписывает то, что видит. ${LOCKED_HINT}`}
            />
          ) : (
            // Как считается итог и что случится со старой подписью — пояснение о правилах цикла:
            // вне «Ведения» его не рисуют вовсе, сумма же видна в самом окне и без плашки.
            <ServiceHint
              coordinator={coordinator}
              level="info"
              title={
                breakdown
                  ? 'Перенесите присланный перечень в графы: строка на позицию, цена на строку'
                  : request.estimateRevision > 0
                    ? `Ревизия ${request.estimateRevision} уже предъявлялась — следующее предъявление уйдёт ревизией ${request.estimateRevision + 1}`
                    : 'Черновик можно сохранять сколько угодно: на согласование уйдёт то, что предъявите'
              }
              description={
                [
                  breakdown ? BREAKDOWN_HINT : null,
                  warrantyMode
                    ? 'Заявка заведена как гарантийная — работы можно предъявить без оплаты.'
                    : null,
                  // Подпись обесценивается новым предъявлением (ревизии сверяются при закрытии
                  // работ), и узнать об этом надо до нажатия, а не по отказу на закрытии.
                  request.approval && !breakdown
                    ? `Согласована ревизия ${request.approval.revision}: новое предъявление снимет эту подпись — объём работ придётся согласовать заново.`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' ') || undefined
              }
            />
          )}

          {/* Переключатель стоит НАД составом: он меняет то, что под ним, и решение о способе
              ввода принимают до набора, а не дочитав до итога. */}
          <Space size={8}>
            <Typography.Text type="secondary">Как набрать:</Typography.Text>
            <EstimateModeSwitch
              mode={mode}
              rows={rows}
              disabled={locked}
              onChange={editor.switchMode}
            />
          </Space>

          {mode === 'free' && freeRow ? (
            <EstimateFreeFields
              row={freeRow}
              disabled={locked}
              onChange={(patch) => editor.changeRow(freeRow.key, patch)}
            />
          ) : (
            <>
              <EstimateRowsGroup
                kind="part"
                disabled={locked}
                rows={rows.filter((row) => row.kind === 'part')}
                onAdd={editor.addRow}
                onChange={editor.changeRow}
                onRemove={editor.removeRow}
              />
              <EstimateRowsGroup
                kind="service"
                disabled={locked}
                rows={rows.filter((row) => row.kind === 'service')}
                onAdd={editor.addRow}
                onChange={editor.changeRow}
                onRemove={editor.removeRow}
              />
            </>
          )}

          {/* Итог — строка, а не поле: его считает сумма строк, и разойтись с ней он не может. */}
          <Space size={8} style={{ justifyContent: 'flex-end', width: '100%' }}>
            <Typography.Text type="secondary">Итого по объёму работ:</Typography.Text>
            <Typography.Text strong style={{ fontSize: 16 }}>
              {editor.total.toLocaleString('ru-RU', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}{' '}
              ₽
            </Typography.Text>
          </Space>

          {/* Комментарий уходит с ПРЕДЪЯВЛЕНИЕМ, поэтому у раскладки его нет: «Ведение» ничего не
              предъявляет своими словами — предъявление ставит сама ручка, и поле, чей текст никуда
              не уедет, было бы обещанием несказанного. */}
          {!breakdown && (
            <Input.TextArea
              rows={2}
              maxLength={1000}
              disabled={locked}
              value={editor.comment}
              placeholder="Комментарий к объёму работ: что нашли при диагностике"
              onChange={(e) => editor.setComment(e.target.value)}
            />
          )}
          {issue && <Typography.Text type="warning">{issue}</Typography.Text>}
        </div>
      )}
    </ViewModal>
  );
}
