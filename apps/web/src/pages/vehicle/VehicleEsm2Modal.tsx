import { useEffect, useMemo } from 'react';
import { App, DatePicker, Form, Typography } from 'antd';
import type { Dayjs } from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  assignmentTitle,
  esm2Periods,
  type VehicleDto,
  vehicleLabel,
  type VehicleRequestDto,
} from '@technic/contracts';
import { driversApi, vehicleRequestsApi, vehiclesApi } from '../../api/resources';
import { AutoSelect } from '@shared/ui';
import { FormGrid } from '@shared/ui';
import { FormModal, useFormBlockers } from '@shared/ui';
import { useIsMobile } from '@shared/lib';
import { errorMessage } from '../../utils/format';
import { formatDateOnly } from './shared';

/**
 * Выписка недельного ЭСМ-2 по требованию (ADR 0100 решение 6).
 *
 * У обычного заказа техники на объект листы выписывает сам портал: срок режется на недели, и на
 * каждую уходит бланк (ADR 0060). У линейного заказа так нельзя — машина вечером возвращается на
 * базу, за день работает на нескольких площадках, и недели, которую она отстояла бы целиком, у
 * заявки просто нет. Поэтому бланк рождается здесь: человек говорит, за какую неделю и на кого.
 *
 * Спрашиваются три вещи, и каждая — потому что портал не вправе решить за человека:
 *
 * - **неделя**: любой её день; границы листа считает сервер — календарная неделя, урезанная
 *   сроком заявки, тем же `esm2Periods`, которым выписывает автомат;
 * - **машина**: за неделю на объекте могли отработать две разных, и лист принадлежит той, чьи
 *   моточасы в нём стоят (ADR 0100 решение 7). Умолчание — машина заявки: ею закрывают
 *   большинство недель;
 * - **машинист**: **без умолчания и всегда** (ADR 0083, ADR 0100 решение 6). В бланке графа одна
 *   на неделю, а водитель у каждого дня свой; унаследованная фамилия напечатала бы в недельном
 *   листе человека, отработавшего один вторник.
 *
 * Своим файлом, а не блоком карточки заявки: карточка стоит вплотную к своему лимиту длины, а
 * окно с формой, тремя запросами и мутацией — самостоятельная вещь, как и соседний перегон.
 */

interface Props {
  /** null — окно закрыто. Заявка должна быть линейной, в работе и на собственной машине. */
  request: VehicleRequestDto | null;
  onClose: () => void;
  onDone: (request: VehicleRequestDto) => void;
}

interface FormValues {
  /** Любой день недели: границы листа сервер посчитает сам. */
  weekOf?: Dayjs | null;
  vehicleId?: string;
  driverPersonId?: string;
}

export function VehicleEsm2Modal({ request, onClose, onDone }: Props) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  const [form] = Form.useForm<FormValues>();
  const blockers = useFormBlockers(form);

  /**
   * Поля сбрасываются при смене цели, а не при размонтировании: окно переиспользуется под разные
   * заявки, и оставленный от прошлой машинист читался бы как решение по этой.
   *
   * Подставляется одна машина. Неделя пустая — её и выбирают этим окном; машинист пустой всегда,
   * и это то самое осознанное решение, ради которого окно и заведено.
   */
  useEffect(() => {
    if (!request) return;
    form.setFieldsValue({
      weekOf: null,
      vehicleId: request.assignment?.vehicleId,
      driverPersonId: undefined,
    });
    // Зависимость — идентификатор заявки, а не она сама: инвалидация списка приносит ту же заявку
    // новым объектом, и подстановка стёрла бы уже выбранную неделю (тот же приём в окне
    // назначения).
  }, [request?.id]);

  const weekOf = Form.useWatch('weekOf', form);

  /**
   * Что попадёт в лист: календарная неделя выбранного дня, пересечённая со сроком заявки. Считает
   * сервер, но обещание портала обязано совпасть с выпиской — поэтому здесь тот же `esm2Periods`,
   * которым режет срок автомат, а не вторая реализация недели.
   *
   * `null` — выбранный день за сроком заявки: сервер такую неделю не примет, и сказать об этом
   * надо до нажатия, а не отказом на нём.
   */
  const period = useMemo(() => {
    const day = weekOf?.format('YYYY-MM-DD');
    if (!day || request?.requestType !== 'special_equipment') return null;
    const found = esm2Periods(request.dateFrom, request.dateTo).find(
      (p) => p.from <= day && day <= p.to,
    );
    return found ?? null;
  }, [request, weekOf]);

  /**
   * Собственная техника парка: лист на арендную выписывает арендодатель, и предлагать её здесь
   * значило бы обещать бланк, которого портал не выпишет.
   *
   * Весь активный парк, а не машины дней недели: дни линейного заказа приезжают следующим этапом
   * (ADR 0100 решение 8), и до тех пор сузить список нечем. Ошибиться этим нельзя — какая единица
   * отработала неделю, знает человек, а не портал.
   */
  const { data: fleet, isFetching: fleetLoading } = useQuery({
    queryKey: ['vehicles', 'esm2-issue'],
    queryFn: () =>
      vehiclesApi.list({
        status: 'active',
        ownership: 'own',
        page: 1,
        pageSize: 500,
        sortBy: 'registrationNumber',
        sortOrder: 'asc',
      }),
    enabled: !!request,
  });

  const vehicleOptions = useMemo(() => {
    const options = (fleet?.items ?? [])
      .map((v: VehicleDto) => ({
        value: v.id,
        label: [vehicleLabel(v), v.modelName, v.categoryName ?? v.typeName]
          .filter((s): s is string => !!s)
          .filter((s, i, all) => all.indexOf(s) === i)
          .join(' · '),
      }))
      .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
    // Машина заявки могла уйти из активного парка (сломалась, продана), а лист за отработанную
    // неделю выписывать всё равно надо. Без этой строки поле показало бы голый идентификатор.
    const assignment = request?.assignment;
    if (assignment && !options.some((o) => o.value === assignment.vehicleId)) {
      options.unshift({ value: assignment.vehicleId, label: assignmentTitle(assignment) });
    }
    return options;
  }, [fleet, request?.assignment]);

  /**
   * Машинисты — весь справочник водителей, тем же запросом и тем же ключом кэша, что и в форме
   * перевода в работу: в бланке ЭСМ-2 нет ни граф СНИЛС, ни граф удостоверения (ADR 0095), и
   * отбирать по документам здесь некого.
   */
  const { data: drivers, isFetching: driversLoading } = useQuery({
    queryKey: ['drivers', 'machinists'],
    queryFn: () => driversApi.list({ pageSize: 200, sortBy: 'fullName', sortDir: 'asc' }),
    enabled: !!request,
  });
  const driverOptions = (drivers?.items ?? []).map((d) => ({
    value: d.id,
    label: [d.fullName, d.personnelNo && `таб. ${d.personnelNo}`].filter(Boolean).join(' · '),
  }));

  const issue = useMutation({
    mutationFn: (v: FormValues) =>
      vehicleRequestsApi.issueEsm2(request!.id, {
        weekOf: v.weekOf!.format('YYYY-MM-DD'),
        vehicleId: v.vehicleId!,
        driverPersonId: v.driverPersonId!,
        version: request!.version,
      }),
    onSuccess: async (updated) => {
      message.success('Лист ЭСМ-2 выписан');
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['vehicle-requests'] }),
        // Печатают лист из журнала, и идут туда сразу же следом за выпиской: непогашенный журнал
        // показал бы вчерашний список ещё десять секунд (`staleTime` приложения).
        qc.invalidateQueries({ queryKey: ['waybills'] }),
      ]);
      onDone(updated);
    },
    // Отказы сервера здесь именные — «день вне срока», «машина арендная», «человек не водитель», —
    // и ложатся они на своё поле (ADR 0094). Тост остаётся для того, у чего поля нет: занятой
    // недели с уже выписанным листом и конфликта версий.
    onError: (e) => {
      if (!blockers.fromApi(e)) message.error(errorMessage(e));
    },
  });

  return (
    <FormModal
      title={request ? `Выписать ЭСМ-2 · ${request.displayNumber}` : 'Выписать ЭСМ-2'}
      open={!!request}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={issue.isPending}
      okText="Выписать лист"
      width={640}
    >
      <Form<FormValues>
        form={form}
        layout="vertical"
        onFinish={(v) => issue.mutate(v)}
        {...blockers.formProps}
      >
        <FormGrid>
          <FormGrid.Full>
            <Typography.Paragraph type="secondary">
              По этой заявке портал листы сам не выписывает — их выписывают здесь, по неделе за раз.
              Работа каждого дня печатается своим 4-П.
            </Typography.Paragraph>
          </FormGrid.Full>

          <Form.Item
            name="weekOf"
            label="Неделя"
            rules={[{ required: true, message: 'Укажите неделю' }]}
            extra={
              period
                ? `Лист покроет ${formatDateOnly(period.from)} – ${formatDateOnly(period.to)}`
                : weekOf
                  ? 'Этот день за сроком заявки — выберите день внутри срока'
                  : 'Достаточно любого дня недели: границы листа считает сервер'
            }
          >
            <DatePicker format="DD.MM.YYYY" style={{ width: '100%' }} inputReadOnly={isMobile} />
          </Form.Item>

          {/* Машина спрашивается, а не берётся из назначения молча: у линейного заказа назначение
            — машина по умолчанию (ADR 0100 решение 4), и неделю могли закрыть две разных единицы.
            Умолчанием стоит назначенная: ею работают чаще всего, и переспрашивать её каждый раз
            заново было бы работой ради работы. */}
          <Form.Item
            name="vehicleId"
            label="Машина"
            rules={[{ required: true, message: 'Выберите машину' }]}
            extra="Подставлена машина заявки; за неделю на объекте могли отработать две разных"
          >
            <AutoSelect
              options={vehicleOptions}
              showSearch
              optionFilterProp="label"
              loading={fleetLoading}
              placeholder="Выберите машину"
              notFoundContent="Собственной техники в работе нет"
            />
          </Form.Item>

          {/* Машинист — пустым полем, и это не забывчивость портала. Графа в бланке одна на всю
            неделю, а водитель у каждого дня свой: подставить сюда вчерашнего значит напечатать в
            недельном листе человека, отработавшего один вторник (ADR 0083). */}
          <FormGrid.Full>
            <Form.Item
              name="driverPersonId"
              label="Машинист"
              rules={[{ required: true, message: 'Выберите машиниста' }]}
              extra="Графа в бланке одна на неделю, а водитель у каждого дня свой — портал его не подставляет"
            >
              <AutoSelect
                autoSelectSole={false}
                options={driverOptions}
                showSearch
                optionFilterProp="label"
                loading={driversLoading}
                placeholder="Кто отработал эту неделю"
                notFoundContent="В справочнике нет действующих водителей"
              />
            </Form.Item>
          </FormGrid.Full>
        </FormGrid>
      </Form>
    </FormModal>
  );
}
