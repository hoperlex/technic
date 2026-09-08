import { useEffect } from 'react';
import { Alert, App, Checkbox, Form, Input, Space } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  moduleMailOutcomeLabels,
  type ServiceRequestDto,
  type ServiceStatusChangeInput,
} from '@technic/contracts';
import {
  ServiceRequestContext,
  serviceRequestKeys,
  serviceRequestsApi,
} from '@entities/service-request';
import { officeEquipmentKeys } from '@entities/office-equipment';
import { FormModal } from '@shared/ui';
import { errorMessage } from '@shared/lib';

/** Поля окна. У расходников из них живёт одно: причина. */
interface Values {
  reason?: string;
  resolution?: string;
  replacementRecommended?: boolean;
}

/**
 * Отмена заявки на обслуживание (Р10 плана `office-equipment-card-and-list-cleanup-plan.md`).
 *
 * СВОЁ ОКНО, А НЕ ОБЩИЙ `ReasonModal`. Пока объём работ был обязателен любому ремонту, «чинить
 * нецелесообразно, аппарат под замену» говорилось отказом по смете — единственным местом, где
 * ставятся `replacementRecommended` и решение (Н3). После Р5 у внутреннего ремонта отказа по смете
 * не бывает вовсе, и без этого окна волна закрыла бы этап вместе со списком «что пора менять»,
 * который по нему и собирают. Общее окно причины при этом не трогается: им пользуются вывоз
 * мусора, заказ ТС и заявки на регистрацию, и третье поле там было бы чужим у всех троих.
 *
 * РЕШЕНИЕ ОБЯЗАТЕЛЬНО РОВНО ПРИ ГАЛОЧКЕ. Обычная отмена — это дубль, ошибка заведения или заявка,
 * потерявшая смысл: спрашивать у неё «что делаем вместо ремонта» значило бы требовать ответ на
 * вопрос, которого никто не задавал. А вот «аппарат под замену» без сказанного «что дальше» —
 * пометка, по которой через месяц не восстановить, купили ему смену или забыли: список замен
 * читают глазами, и пустая строка в нём хуже отсутствующей.
 *
 * У ЗАЯВКИ НА РАСХОДНИКИ ЭТИХ ПОЛЕЙ НЕТ ВОВСЕ, и это не экономия места: замене подлежит аппарат, а
 * не картридж, — сервер и принимает оба поля только у `kind === 'repair'` (Р10). Показанное здесь
 * поле молча терялось бы на сервере.
 *
 * Массовая отмена (`ServiceBulkModal`) остаётся с одной общей причиной: одна галочка на пачку
 * пометила бы к замене все аппараты разом — решение относится к одному, и вводят его в его
 * карточке.
 */
export function ServiceCancelModal({
  request,
  erases,
  onClose,
}: {
  /** `null` — окно закрыто. Открывается там, где коридор даёт дугу в «Отменена». */
  request: ServiceRequestDto | null;
  /**
   * Что заявка потеряет по нажатию (ADR 0161) — перечень собирает вызывающий экран, как у возврата
   * в «Новую». Считать его здесь нельзя: тот же перечень служит основанием возврата отменённой
   * заявки, и две копии правила разошлись бы на первой правке матрицы сброса. Пусто — терять
   * нечего, и блок не рисуется: пустой список «будет стёрто» читается как недогрузившийся.
   */
  erases: string[];
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<Values>();
  /*
   * Замена — свойство ремонта. Вид заявки спрашивается у самой заявки, а не у наличия аппарата:
   * заявку заводят и на технику, которой ещё нет в справочнике (ADR 0165), и её тоже бывает
   * дешевле заменить, чем чинить.
   */
  const repair = request?.kind === 'repair';

  // Окно переоткрывают на соседней заявке: причина прошлой отмены не должна подставляться.
  useEffect(() => {
    if (request) form.resetFields();
  }, [request, form]);

  const mutation = useMutation({
    mutationFn: (values: Values) => {
      const body: ServiceStatusChangeInput = {
        status: 'cancelled',
        reason: values.reason?.trim() ?? '',
        version: request!.version,
      };
      /*
       * Поля ремонта не уходят у расходников даже пустыми: сервер принимает их только при
       * `kind === 'repair'` и отвечает отказом на непустые (Р10), а «послали, но не применилось» —
       * худший из исходов, потому что о нём никто не узнает.
       */
      if (repair) {
        body.resolution = values.resolution?.trim() || undefined;
        body.replacementRecommended = !!values.replacementRecommended;
      }
      return serviceRequestsApi.changeStatus(request!.id, body);
    },
    onSuccess: (result) => {
      message.success('Заявка отменена');
      /*
       * Судьба письма «не выезжайте». Отмена адресована и подрядчику: он уже собрался ехать, и
       * ненастроенный канал отменивший обязан увидеть здесь, а не узнать по приехавшей машине.
       *
       * Тостом `error`, а не `warning`: пофайловое исключение ADR 0094 выдано модулю
       * `pages/service/serviceMailNotice.ts`, а он лежит слоем выше — feature до него не
       * дотянется (тот же довод и то же решение, что в `AssignServiceModal`). Молчат три исхода:
       * `queued` — обычный ход, `not_needed` — писать было некому по составу, `event_off` —
       * рубильник события выключен администратором намеренно.
       */
      const mail = result.mail;
      if (mail && mail !== 'queued' && mail !== 'not_needed' && mail !== 'event_off') {
        message.error(moduleMailOutcomeLabels[mail]);
      }
      void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
      onClose();
    },
    // Отказ сервера здесь содержателен: заявку уже подвинули (409), статус закрыт коридором (422).
    onError: (e) => message.error(errorMessage(e)),
  });

  return (
    <FormModal
      title={request ? `Отмена заявки ${request.displayNumber}` : 'Отмена заявки'}
      open={!!request}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={mutation.isPending}
      okText="Отменить заявку"
      cancelText="Не отменять"
      okDanger
      width={520}
    >
      {request && (
        <Space orientation="vertical" size={12} style={{ width: '100%', marginBottom: 12 }}>
          {/* О какой заявке речь (Р57): отменяют, глядя на то, что чинят и где оно стоит. */}
          <ServiceRequestContext request={request} />
          {/*
           * Что заявка потеряет — блоком НАД полем причины (ADR 0161): отмена снимает исполнителей
           * и согласование, а восстанавливать после нажатия будет нечего.
           */}
          {erases.length > 0 && (
            <Alert
              type="warning"
              showIcon
              title="Что снимется с заявки"
              description={
                <ul style={{ margin: '4px 0 0', paddingInlineStart: 20 }}>
                  {erases.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              }
            />
          )}
        </Space>
      )}

      <Form form={form} layout="vertical" onFinish={(values) => mutation.mutate(values)}>
        <Form.Item
          name="reason"
          label="Причина отмены"
          extra="Уйдёт комментарием перехода в историю: по ней и разбирают отменённую заявку"
          rules={[
            { required: true, message: 'Укажите причину' },
            { whitespace: true, message: 'Укажите причину' },
          ]}
        >
          <Input.TextArea
            rows={3}
            maxLength={1000}
            showCount
            autoFocus
            placeholder="Например: аппарат списан, заявка больше не нужна"
          />
        </Form.Item>

        {repair && (
          <>
            <Form.Item
              name="resolution"
              label="Что делаем вместо ремонта"
              extra="Остаётся полем заявки: с него начинают разбор отменённой заявки через месяц"
              /*
               * Обязательным поле становится ровно тогда, когда его обещали заполнить галочкой:
               * «менять» без ответа «на что и когда» — пометка, по которой ничего не сделают.
               *
               * Галочка спрашивается ВАЛИДАТОРОМ у самой формы, а не через `Form.useWatch` в теле
               * компонента, и это не стилистика. `useWatch` отдаёт новое значение следующим
               * рендером, а правило `required` собирается в текущем: человек, поставивший галочку
               * и сразу нажавший «Отменить заявку», проходил бы валидацию со старым правилом —
               * пометка «менять» уехала бы на сервер без решения, ради которого её и спрашивают.
               * Тест «галочка без решения не уходит» ловит ровно этот тик.
               *
               * `dependencies` держит вторую половину: поле, однажды показавшее отказ,
               * перепроверяется при снятии галочки, а не остаётся с красной подписью.
               */
              dependencies={['replacementRecommended']}
              rules={[
                ({ getFieldValue }) => ({
                  validator: (_rule, value: string | undefined) =>
                    getFieldValue('replacementRecommended') && !value?.trim()
                      ? Promise.reject(
                          new Error('Замену рекомендуют с решением: что делаем вместо ремонта'),
                        )
                      : Promise.resolve(),
                }),
              ]}
            >
              <Input.TextArea
                rows={2}
                maxLength={500}
                showCount
                placeholder="Например: аппарат под замену, заявка на закупку заведена"
              />
            </Form.Item>
            <Form.Item
              name="replacementRecommended"
              valuePropName="checked"
              extra="По этой пометке собирают список того, что пора обновить. Ставится рукой: отмена сама по себе не значит «менять»"
              style={{ marginBottom: 0 }}
            >
              <Checkbox>Рекомендована замена аппарата</Checkbox>
            </Form.Item>
          </>
        )}
      </Form>
    </FormModal>
  );
}
