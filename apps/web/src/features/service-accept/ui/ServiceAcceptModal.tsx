import { useEffect, useState } from 'react';
import { Alert, App, Form, Input, Space } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  hasServiceClosingDocument,
  SERVICE_CLOSING_DOCUMENT_KINDS,
  type ServiceRequestDto,
} from '@technic/contracts';
import {
  SERVICE_CLOSING_DOCUMENT_HINT,
  ServiceDocumentUpload,
  ServiceRequestContext,
  serviceRequestKeys,
  serviceRequestsApi,
} from '@entities/service-request';
import { officeEquipmentKeys } from '@entities/office-equipment';
import { FormModal, useFormBlockers } from '@shared/ui';
import { errorMessage } from '@shared/lib';
import { filesApi } from '../../../api/resources';
import { useAuth } from '../../../auth/AuthContext';

export type AcceptMode = 'accept' | 'rework';

function money(value: number | null): string {
  if (value == null) return '—';
  return `${value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

/**
 * Приёмка и возврат на доработку (§9.3) — два ответа на один и тот же предъявленный факт, и
 * потому одно окно с двумя режимами: решают по одним и тем же цифрам, отличается лишь цена
 * решения. У возврата она высокая — стираются отметки выполнения, итог и посчитанные гарантии, —
 * поэтому там обязательна причина и красная кнопка.
 *
 * Принять работу без закрывающего документа нельзя (Р112, отменяет Р16): пока к заявке не подшит
 * ни акт, ни счёт, ни гарантийный талон, кнопка неактивна — сервер откажет тем же условием, и
 * кнопка, ведущая в 422, была бы обещанием, которого он не даёт. Бумагу подшивают здесь же (Р120):
 * иначе подпись списка «Вам: нужен закрывающий документ» звала бы в заблокированное окно, а
 * человек шёл бы искать вкладку документов сам. Возврата на доработку планка не касается — там
 * принимать нечего.
 */
export function ServiceAcceptModal({
  request,
  mode,
  onClose,
}: {
  /** `null` — окно закрыто. */
  request: ServiceRequestDto | null;
  mode: AcceptMode;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [form] = Form.useForm<{ text?: string }>();
  const blockers = useFormBlockers(form);
  const rework = mode === 'rework';

  /**
   * Своя копия заявки (Р120). Проп приходит из состояния, поднятого при открытии окна, и
   * `invalidateQueries` его не трогает: подшив акт, человек смотрел бы на ту же заблокированную
   * кнопку и закрывал окно, чтобы открыть заново. Ручка `POST /:id/files` отвечает свежим DTO —
   * его и держим до закрытия.
   */
  const [fresh, setFresh] = useState<ServiceRequestDto | null>(null);
  const shown = fresh && request && fresh.id === request.id ? fresh : request;

  useEffect(() => {
    // Открылось окно другой заявки — своя копия начинается заново, иначе планка считалась бы по
    // предыдущей.
    setFresh(request);
    if (request) form.resetFields();
  }, [request, mode]);

  const mutation = useMutation({
    mutationFn: () =>
      rework
        ? serviceRequestsApi.rework(shown!.id, {
            reason: text().trim(),
            version: shown!.version,
          })
        : serviceRequestsApi.accept(shown!.id, {
            comment: text().trim(),
            version: shown!.version,
          }),
    onSuccess: () => {
      message.success(rework ? 'Заявка возвращена в работу' : 'Работы приняты');
      void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
      onClose();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  /** Значение поля берётся у формы: окно об этом ничего не помнит и хранить не должно. */
  const text = () => form.getFieldValue('text') ?? '';

  const submit = () => {
    // Причина возврата — обязательное поле, а не тост поверх окна: правят её здесь же (ADR 0094).
    if (blockers.raise({ text: rework && !text().trim() && 'Укажите, что доделать' })) return;
    mutation.mutate();
  };

  /**
   * Планка закрывающего документа **уехала с приёмки на «Решена»** (Н8 плана переработки заявок):
   * сервер её здесь больше не спрашивает, и держать окно запертым значило бы запирать то, что
   * сервер уже пропускает. Прямее всего это видно на заявке-наследии, доехавшей до «Решена» без
   * бумаги: принять её вручную — единственный способ закрыть, автозакрытие такую не берёт.
   *
   * Подсказка при этом остаётся: работа без бумаги — повод спросить её у исполнителя, а не повод
   * запретить приёмку. Считается по своей копии заявки — той, что знает о свежей загрузке.
   */
  const missingDocument = !rework && !!shown && !hasServiceClosingDocument(shown);
  const canAttach = can('serviceRequests.files');

  return (
    <FormModal
      title={
        rework
          ? `Вернуть на доработку ${shown?.displayNumber ?? ''}`
          : `Принять работу ${shown?.displayNumber ?? ''}`
      }
      open={!!request}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={mutation.isPending}
      okText={rework ? 'Вернуть на доработку' : 'Принять'}
      okDanger={rework}
      width={520}
    >
      {shown && (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <ServiceRequestContext request={shown} />
          <Alert
            type={rework ? 'warning' : 'info'}
            showIcon
            message={
              rework
                ? 'Факт закрытия будет стёрт'
                : `Предъявлено ${money(shown.completion?.totalAmount ?? null)}`
            }
            description={
              rework
                ? 'Отметки выполнения, итог и посчитанные гарантии снимутся: исполнитель закроет работы заново. Смета и документы останутся на месте.'
                : `Исполнитель: ${shown.service?.name ?? '—'}. После приёмки заявка закрыта: документы подшить к ней можно и потом.`
            }
          />

          {!rework && (
            <>
              {missingDocument && (
                <Alert
                  type="warning"
                  showIcon
                  message={SERVICE_CLOSING_DOCUMENT_HINT}
                  description="Работа предъявлена без бумаги — её стоит запросить у исполнителя. Подшить можно прямо здесь; принять работу портал не мешает, но заявка сама уже не закроется."
                />
              )}
              {/* Виды — только закрывающие: остальное подшивают на вкладке документов, а здесь
                  решают ровно один вопрос — чем закрыта работа. Право спрашивается то же, что и
                  там: правило «кто подшивает бумаги» записано один раз, иначе первая же новая
                  базовая роль под надстройкой оператора получила бы загрузчик, на который сервер
                  ответит 403. */}
              {canAttach && (
                <ServiceDocumentUpload
                  requestId={shown.id}
                  kinds={SERVICE_CLOSING_DOCUMENT_KINDS}
                  upload={filesApi.upload}
                  onUploaded={(updated) => {
                    // Свежая заявка — в своё состояние, и заодно гасим списки: столбец документов
                    // и очередь «Ожидаются документы» изменились у всех, кто смотрит тот же
                    // список.
                    setFresh(updated);
                    void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
                  }}
                />
              )}
            </>
          )}

          <Form form={form} layout="vertical" onFinish={submit} {...blockers.formProps}>
            <Form.Item
              name="text"
              label={rework ? 'Что доделать' : 'Комментарий'}
              style={{ marginBottom: 0 }}
            >
              <Input.TextArea
                rows={3}
                maxLength={1000}
                autoFocus
                placeholder={
                  rework
                    ? 'Причина возврата: она уйдёт в историю и будет видна исполнителю'
                    : 'Необязательно'
                }
              />
            </Form.Item>
          </Form>
        </Space>
      )}
    </FormModal>
  );
}
