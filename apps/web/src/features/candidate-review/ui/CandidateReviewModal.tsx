import { Alert, Divider, Form, Typography } from 'antd';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  officeEquipmentCandidateStatusLabels,
  type OfficeEquipmentCandidateDto,
} from '@technic/contracts';
import { departmentOptionsQuery } from '@entities/department';
import { objectOptionsQuery } from '@entities/object';
import {
  officeEquipmentCandidateKeys,
  officeEquipmentCandidatesApi,
} from '@entities/office-equipment-candidate';
import {
  OfficeEquipmentFields,
  officeEquipmentPayload,
  officeEquipmentTypeOptionsQuery,
  type OfficeEquipmentFormValues,
} from '@entities/office-equipment';
import { FormModal, StaleRecordNotice, useFormBlockers, useFormRecordSession } from '@shared/ui';
import { CandidateDeclared } from './CandidateDeclared';
import { CandidateDecisions } from './CandidateDecisions';
import { useCandidateDecision } from '../model/decisions';

/**
 * Окно проверки сообщения о технике (план `docs/office-equipment-candidate-plan.md`, Р13, §9).
 *
 * ЭТО ФОРМА КАРТОЧКИ ПАРКА, А НЕ КНОПКА «ПОДТВЕРДИТЬ КАК ЕСТЬ», и решение это принято опросом.
 * Проверяющий здесь не соглашается с сообщением, а ЗАВОДИТ КАРТОЧКУ ПО СООБЩЕНИЮ: заявитель не
 * знает половины реквизитов учёта (Р7), и карточка, созданная из его слов один в один, была бы
 * неполной с первого дня — без модели-ссылки, без отдела-владельца и без гарантии, то есть
 * невидимой для счётчиков парка и для вкладки «Гарантии».
 *
 * Форма предзаполнена заявленным: тип, оба номера, площадка, место и комментарий переносятся один в
 * один — пределы длин у полей кандидата ровно те же, что у карточки, и обрезать при переносе
 * нечего. Модель проверяющий выбирает сам: у заявителя она текстом с шильдика (Р7), и превратить
 * строку в ссылку справочника может только человек, который справочник ведёт.
 *
 * КАРТОЧКА ПЕРЕЧИТЫВАЕТСЯ СВОИМ ЗАПРОСОМ, а не берётся строкой очереди: между открытием списка и
 * решением коллега мог поправить реквизиты (Р12), и форма, собранная из строки, отправила бы
 * устаревшую версию и получила бы 409 — уже после того, как проверяющий заполнил её целиком.
 *
 * The form is filled per window session and every door of the window sends the version taken at
 * that fill (stage 5 plan §4.5): a reread no longer wipes what the reviewer typed, and a colleague's
 * edit over a changed form raises the notice instead of being overwritten. The neighbouring block
 * "what was declared" is the same window: its save moves the snapshot and refills the untouched
 * fields of this form with the corrected values.
 *
 * РЕШЁННЫЙ КАНДИДАТ ОТКРЫВАЕТСЯ ТОЖЕ, но без формы: очередь показывают и с отбором по состоянию, и
 * строка исхода отвечает на «чем кончилось», не обещая действий, которых у неё уже нет — правки
 * после решения не предусмотрено вовсе («передумал» оформляется новой заявкой, Р15).
 */
export function CandidateReviewModal({
  candidateId,
  onClose,
}: {
  /** `null` — окно закрыто; строку очереди открывают идентификатором. */
  candidateId: string | null;
  onClose: () => void;
}) {
  const [form] = Form.useForm<OfficeEquipmentFormValues>();
  const blockers = useFormBlockers(form);
  const open = !!candidateId;

  const { data: candidate } = useQuery({
    queryKey: officeEquipmentCandidateKeys.detail(candidateId ?? ''),
    queryFn: () => officeEquipmentCandidatesApi.get(candidateId!),
    enabled: open,
  });
  const pending = candidate?.status === 'pending';

  const { data: typeOptions = [], isFetching: typesLoading } = useQuery({
    ...officeEquipmentTypeOptionsQuery(),
    enabled: open,
  });
  // Только действующие площадки и отделы: карточку заводят на то, что работает сегодня.
  const { data: objectOptions = [] } = useQuery({ ...objectOptionsQuery(), enabled: open });
  const { data: departmentOptions = [] } = useQuery({ ...departmentOptionsQuery(), enabled: open });

  const session = useFormRecordSession(form, {
    open,
    id: candidateId,
    data: candidate,
    version: (c: OfficeEquipmentCandidateDto) => c.contentVersion,
    values: (c: OfficeEquipmentCandidateDto) => ({
      equipmentTypeId: c.equipmentType.id,
      serialNumber: c.serialNumber,
      inventoryNumber: c.inventoryNumber,
      objectId: c.object.id,
      location: c.location,
      comment: c.comment,
      // Active right away: what is registered stands in the office and already has a request.
      isActive: true,
    }),
  });

  const confirm = useCandidateDecision(
    candidateId ?? '',
    (values: OfficeEquipmentFormValues) =>
      officeEquipmentCandidatesApi.confirm(candidateId!, {
        equipment: officeEquipmentPayload(values),
        expectedVersion: session.version!,
      }),
    { success: 'Карточка заведена', onDone: onClose, blockers },
  );

  return (
    <FormModal
      title="Проверка сообщения о технике"
      open={open}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={confirm.isPending}
      okText="Завести карточку"
      okDisabled={!pending}
      width={640}
      footerExtra={
        candidate && pending ? (
          <CandidateDecisions
            candidate={candidate}
            expectedVersion={session.version!}
            onDone={onClose}
          />
        ) : undefined
      }
    >
      {candidate && (
        <>
          <CandidateDeclared candidate={candidate} onSaved={session.accept} />
          {/* Ссылка на заявку — обязательная часть проверки: решение про технику принимают, глядя
              на то, зачем о ней сообщили. Статус тут же: заявку могли отменить или закрыть, пока
              сообщение стояло в очереди (Р16), и знать это надо ДО заведения карточки. */}
          {candidate.request && (
            <Typography.Paragraph>
              Заявка:{' '}
              <Link to={`/office-equipment?tab=requests&open=${candidate.request.id}`}>
                {candidate.request.displayNumber}
              </Link>
            </Typography.Paragraph>
          )}
          <Divider />
          {pending ? (
            <>
              <StaleRecordNotice session={session} />
              <Form
                form={form}
                layout="vertical"
                onFinish={(v) => confirm.mutate(v)}
                {...blockers.formProps}
              >
                <OfficeEquipmentFields
                  typeOptions={typeOptions}
                  typesLoading={typesLoading}
                  objectOptions={objectOptions}
                  departmentOptions={departmentOptions}
                />
              </Form>
            </>
          ) : (
            /* Исход словами, а не формой: у решённого кандидата действий нет вовсе, и открытая
               форма обещала бы кнопку, которую сервер встретит 409. */
            <Alert
              type={candidate.status === 'rejected' ? 'error' : 'success'}
              showIcon
              title={officeEquipmentCandidateStatusLabels[candidate.status]}
              description={
                candidate.decisionReason || candidate.resultEquipment?.title || 'Решение принято'
              }
            />
          )}
        </>
      )}
    </FormModal>
  );
}
