import { Checkbox, Form, Input } from 'antd';
import { FormGrid } from '@shared/ui';
import type { TrailerSlotMode } from '@entities/vehicle-route';
import { TrailerPicker } from './TrailerPicker';

/**
 * Одна пара граф бланка: чекбокс «Из справочника» над ней и два вида ввода под ним (Р17).
 *
 * Слоты одинаковы во всём, кроме номера, поэтому описаны одним компонентом: правило «пара граф
 * переключается целиком» иначе стояло бы в двух экземплярах, и второй прицеп повторил бы историю
 * §2 — то, что заводили копированием, разошлось с оригиналом.
 */
export function TrailerSlot({
  slot,
  mode,
  onMode,
  modelPlaceholder,
  regNumberPlaceholder,
  vehicleId,
  excludeRegNumber,
}: {
  slot: 1 | 2;
  mode: TrailerSlotMode;
  onMode: (mode: TrailerSlotMode) => void;
  modelPlaceholder: string;
  regNumberPlaceholder: string;
  vehicleId?: string | null;
  excludeRegNumber?: string;
}) {
  return (
    <>
      {/* Чекбокс стоит НАД графами и в своём блоке, а не в подписи поля: `<label>` внутри
        `<label>` отправляет клик в поле — вместо переключения открывался бы список. Тот же приём и
        по той же причине, что у выбора адреса (`features/address-input/ui/AddressField.tsx`). */}
      <FormGrid.Full>
        <Checkbox
          checked={mode === 'directory'}
          onChange={(e) => onMode(e.target.checked ? 'directory' : 'manual')}
        >
          Из справочника
        </Checkbox>
      </FormGrid.Full>
      {mode === 'directory' && (
        /* Список занимает строку целиком: подпись строки — марка, госномер и метка состояния, и в
           половине ширины она обрезается ровно на госномере, ради которого её и читают. */
        <FormGrid.Full>
          <TrailerPicker slot={slot} vehicleId={vehicleId} excludeRegNumber={excludeRegNumber} />
        </FormGrid.Full>
      )}
      {/* Графы остаются полями формы в обоих режимах и в справочнике лишь прячутся — убрать их
        со страницы значило бы убрать из отправки: `onFinish` получает значения **заведённых**
        полей, а не весь склад формы (rc-field-form: `validateFields` собирает `getFieldEntities`).
        Ровно так рейс уже уезжал с половиной состава прицепов (§2, расхождение 1), и повторять это
        под новым предлогом нельзя. Заодно отсюда и «переключение не теряет набранного»: поле не
        подменяется списком, а заполняется им. */}
      <Form.Item
        name={`trailer${slot}Model`}
        label={`Прицеп ${slot}: марка`}
        hidden={mode === 'directory'}
      >
        <Input placeholder={modelPlaceholder} />
      </Form.Item>
      <Form.Item
        name={`trailer${slot}RegNumber`}
        label={`Прицеп ${slot}: госномер`}
        hidden={mode === 'directory'}
      >
        <Input placeholder={regNumberPlaceholder} />
      </Form.Item>
    </>
  );
}
