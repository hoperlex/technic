import { Form, InputNumber, Typography, type FormInstance } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  isPricedRequestType,
  isVolumeAllowed,
  MIN_WASTE_VOLUME_M3,
  volumeStepMessage,
  WASTE_REMOVAL_CONTAINER_KIND,
  type WasteRequestDto,
} from '@technic/contracts';
import { wastePricingHint } from '@entities/waste-request';
import { wasteTariffResolveQuery } from '@entities/waste-tariff';
import { withSavedOption } from '@shared/lib';
import { AutoSelect, FormGrid } from '@shared/ui';
import type { WasteRequestEditorSources, WasteRequestFormValues } from '../model/types';

interface Props {
  form: FormInstance<WasteRequestFormValues>;
  record: WasteRequestDto | null;
  wasteTypes: WasteRequestEditorSources['wasteTypes'];
}

/**
 * Removal subject: what is hauled and how much is the whole subject of a removal request. It names
 * no equipment (ADR 0022): the operator decides how to haul the volume and reports it at
 * completion. There is no cost field either: the price list gives the price by waste type and the
 * estimate is shown as a hint under the fields (ADR 0009). Replacement and removal of a container
 * have none of these fields because container operations are not priced (ADR 0019).
 *
 * The tariff preview lives here with the fields it explains; it renders nothing for other types.
 */
export function WasteRequestEditorRemovalFields({ form, record, wasteTypes }: Props) {
  const requestType = Form.useWatch('requestType', form);
  const wasteTypeId = Form.useWatch('wasteTypeId', form);
  const volumeM3 = Form.useWatch('volumeM3', form);
  // The operator affects the price: every operator has its own price list (ADR 0026).
  const operatorId = Form.useWatch('operatorCounterpartyId', form);
  // Only removal is priced (ADR 0019): waste type, volume and cost belong to it alone.
  const priced = requestType ? isPricedRequestType(requestType) : false;

  // The type of an existing request stays selectable even if its tariff was disabled since.
  const formWasteTypes = withSavedOption(wasteTypes.options, {
    id: record?.wasteTypeId,
    name: record?.wasteTypeName,
  });

  // The server resolves the preview tariff so the form and the save-time calculation cannot
  // diverge. The request names no equipment (ADR 0022), so the lookup uses the truck kind exactly
  // as the save does. With an operator selected it is that operator's price; without one it is the
  // minimum across operators, shown as "from" (ADR 0026). A missing price list arrives as
  // tariff: null with HTTP 200, so "no price" and "request failed" are separate branches rather
  // than one generic error.
  const { data: tariffResult, isError: tariffRequestFailed } = useQuery({
    ...wasteTariffResolveQuery({
      wasteTypeId,
      target: { containerKind: WASTE_REMOVAL_CONTAINER_KIND },
      operatorCounterpartyId: operatorId,
    }),
    enabled: priced && !!wasteTypeId,
  });
  const tariff = tariffResult?.tariff ?? null;
  const volumeStepM3 = tariff?.volumeStepM3 ?? null;
  // A missing tariff does not block the request (ADR 0046): the estimate turns into a warning and
  // the form is submitted as is, so the request is saved without a cost.
  const pricingHint = wastePricingHint({
    isPriced: priced,
    wasteTypeId,
    operatorSelected: !!operatorId,
    tariff,
    resolved: tariffResult != null,
    requestFailed: tariffRequestFailed,
    volumeM3: priced ? (volumeM3 ?? null) : null,
  });

  return (
    <>
      {priced && (
        // Adjacent grid cells: "what is hauled" and "how much" read as a pair.
        <>
          <Form.Item
            name="wasteTypeId"
            label="Тип мусора"
            rules={[{ required: true, message: 'Выберите тип мусора' }]}
          >
            <AutoSelect
              options={formWasteTypes}
              loading={wasteTypes.loading}
              showSearch
              optionFilterProp="label"
              placeholder="Что вывозим"
            />
          </Form.Item>
          <Form.Item
            name="volumeM3"
            label="Объём, м³"
            rules={[
              { required: true, message: 'Укажите объём' },
              {
                type: 'number',
                min: MIN_WASTE_VOLUME_M3,
                message: `Не менее ${MIN_WASTE_VOLUME_M3} м³`,
              },
              {
                // A per-container tariff charges the whole container: half a container is never
                // hauled, so the volume must be a multiple of the tariff step.
                validator: (_rule, value: number | undefined) =>
                  value == null || isVolumeAllowed(value, volumeStepM3)
                    ? Promise.resolve()
                    : Promise.reject(new Error(volumeStepMessage(volumeStepM3!))),
              },
            ]}
          >
            <InputNumber
              min={MIN_WASTE_VOLUME_M3}
              step={volumeStepM3 ?? 1}
              // The planned volume is an integer column in the database: a fractional value would
              // be rejected by server validation only after the form was submitted.
              precision={0}
              style={{ width: '100%' }}
              placeholder={volumeStepM3 ? `Кратно ${volumeStepM3}` : 'Например, 20'}
            />
          </Form.Item>
        </>
      )}
      {pricingHint && (
        // The estimate belongs to the waste type and volume pair as a whole, so it takes a
        // full-width row instead of being the hint of one field.
        <FormGrid.Full>
          <div style={{ marginTop: -16, marginBottom: 24 }}>
            <Typography.Text type={pricingHint.tone}>{pricingHint.text}</Typography.Text>
          </div>
        </FormGrid.Full>
      )}
    </>
  );
}
