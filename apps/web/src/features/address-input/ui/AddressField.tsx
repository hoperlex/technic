import { useEffect, useState, type ReactNode } from 'react';
import { Checkbox, Form } from 'antd';
import {
  ADDRESS_NOT_VERIFIED_MESSAGE,
  type AddressMeta,
  isAddressVerified,
  isDirectoryAddressSource,
} from '@technic/contracts';
import { AddressAutoComplete, directoryAddressMeta } from '@entities/address';
import { buildDirectoryGroups } from '../model/suggestions';
import { useDirectoryOptions, type DirectoryOption } from '../model/useDirectoryOptions';
import { DirectorySelect } from './DirectorySelect';

interface Props {
  /** Поле формы со строкой адреса — значение поля остаётся строкой в любом режиме. */
  name: string;
  label: ReactNode;
  required?: boolean;
  /** Чего именно не хватает: «Укажите место погрузки» точнее общего «Укажите адрес». */
  requiredMessage?: string;
  /**
   * Жёсткая модель (ADR 0006): пока адрес не верифицирован — форма не отправляется. Включается
   * там, где этого требует сущность; у перегона свободная строка допустима.
   */
  verified?: boolean;
  /**
   * Скрытое поле формы с метаданными адреса. Не задано — метаданные не сохраняются: компонент
   * собирает их всегда, а хранить их есть куда не везде (у маршрутов колонок пока нет).
   */
  metaField?: string;
  /** Чекбокс «Из справочника». Выключен там, где справочник сам и есть источник списка. */
  directory?: boolean;
  /**
   * Что предложить первым, пока поиск не начат: объект заявки, затем площадки учётки. Порядок
   * значим; собирает его вызывающая сторона — она одна знает, чья это заявка.
   */
  suggestObjectIds?: readonly string[];
  placeholder?: string;
  maxLength?: number;
  disabled?: boolean;
  tooltip?: ReactNode;
  extra?: ReactNode;
}

type Mode = 'suggest' | 'directory';

const DIRECTORY_HINT = 'В списке — объекты и склады с заполненным адресом';

function modeOf(meta: AddressMeta | null | undefined): Mode {
  return meta && isDirectoryAddressSource(meta.source) ? 'directory' : 'suggest';
}

/**
 * Адресное поле портала (ADR 0069): подсказки DaData и выбор из справочника под одним заголовком,
 * переключаются чекбоксом.
 *
 * Компонент владеет своим `Form.Item` целиком — иначе заголовок с чекбоксом не собрать, а правило
 * «адрес должен быть верифицирован» осталось бы копией в каждой форме. Значение поля при этом
 * остаётся тем же, чем было, — строкой адреса; метаданные живут отдельным скрытым полем той же
 * формы, поэтому `resetFields` и `setFieldsValue` работают над ними сами.
 */
export function AddressField({
  name,
  label,
  required,
  requiredMessage = 'Укажите адрес',
  verified,
  metaField,
  directory,
  suggestObjectIds = [],
  placeholder,
  maxLength = 1000,
  disabled,
  tooltip,
  extra,
}: Props) {
  const form = Form.useFormInstance();
  const value = Form.useWatch<string | undefined>(name, form);
  // Поле без метаданных наблюдает за заведомо несуществующим именем: `useWatch` — хук, и вызывать
  // его по условию нельзя, а поле, которого в форме нет, просто всегда отдаёт `undefined`.
  const meta = Form.useWatch<AddressMeta | null | undefined>(
    metaField ?? '__no_address_meta__',
    form,
  );

  const [mode, setMode] = useState<Mode>(() => modeOf(form.getFieldValue(metaField ?? '')));
  /** Выбор, когда метаданные не сохраняются: у маршрута ссылке на запись лечь некуда. */
  const [pickedId, setPickedId] = useState<string>();
  const [search, setSearch] = useState('');

  const selectedId = meta?.refId ?? pickedId;

  /*
   * Режим следует за формой, а не только за чекбоксом: форму заполняют снаружи — правкой заявки,
   * сбросом при смене типа, подстановкой адреса объекта в окне перегона, — и поле обязано
   * показать то, что в нём лежит. Собственные действия компонента под эти условия не подпадают:
   * переключение чекбокса стирает и строку, и метаданные, а выбор из справочника оставляет ссылку.
   */
  useEffect(() => {
    const fromMeta = modeOf(meta);
    if (fromMeta === 'directory' && mode === 'suggest') setMode('directory');
    else if (fromMeta === 'suggest' && mode === 'directory' && !!value && !selectedId) {
      setMode('suggest');
    }
    if (!value && pickedId) setPickedId(undefined);
  }, [meta, value, mode, selectedId, pickedId]);

  const { objects, warehouses, loading } = useDirectoryOptions(!!directory && mode === 'directory');
  const groups = buildDirectoryGroups({
    objects,
    warehouses,
    suggestIds: suggestObjectIds,
    searching: !!search.trim(),
  });

  const setMeta = (next: AddressMeta | null) => {
    if (metaField) form.setFieldValue(metaField, next);
  };

  /** Переключение режима: прежний адрес не переносится — за ним не стоит нового способа ввода. */
  const switchMode = (next: Mode) => {
    setMode(next);
    setPickedId(undefined);
    setSearch('');
    form.setFieldValue(name, undefined);
    setMeta(null);
    // Ошибку прежнего режима снимаем: она относилась к тому, чего в поле уже нет.
    form.setFields([{ name, errors: [] }]);
  };

  const pick = (option: DirectoryOption) => {
    setPickedId(option.value);
    form.setFieldValue(name, option.address);
    setMeta(directoryAddressMeta(option));
    form.validateFields([name]).catch(() => undefined);
  };

  return (
    <div className="address-field">
      {directory && (
        // Чекбокс стоит напротив заголовка, но не внутри него: `<label>` внутри `<label>` — это
        // клик по чекбоксу, уходящий в поле адреса, и открытый список вместо переключения.
        <div className="address-field__toggle">
          <Checkbox
            checked={mode === 'directory'}
            disabled={disabled}
            onChange={(e) => switchMode(e.target.checked ? 'directory' : 'suggest')}
          >
            Из справочника
          </Checkbox>
        </div>
      )}
      <Form.Item
        name={name}
        label={label}
        required={required}
        tooltip={tooltip}
        // В режиме справочника поле объясняет, чего в списке нет: площадка без заполненного
        // адреса ничего не называет, и по одному списку не понять, почему её там не видно.
        extra={mode === 'directory' ? (extra ?? DIRECTORY_HINT) : extra}
        rules={[
          { required, message: requiredMessage },
          // Жёсткая модель проверяется правилом поля, а не кодом отправки: ошибка садится на само
          // поле, и человек видит, к какому из двух адресов она относится.
          ...(verified && metaField
            ? [
                () => ({
                  validator: (_: unknown, v: unknown) => {
                    if (!v) return Promise.resolve();
                    return isAddressVerified(form.getFieldValue(metaField) as AddressMeta | null)
                      ? Promise.resolve()
                      : Promise.reject(new Error(ADDRESS_NOT_VERIFIED_MESSAGE));
                  },
                }),
              ]
            : []),
        ]}
      >
        {mode === 'directory' ? (
          <DirectorySelect
            selectedId={selectedId}
            address={value}
            groups={groups}
            loading={loading}
            disabled={disabled}
            onPick={pick}
            onSearch={setSearch}
          />
        ) : (
          <AddressAutoComplete
            placeholder={placeholder}
            maxLength={maxLength}
            disabled={disabled}
            onMetaChange={setMeta}
          />
        )}
      </Form.Item>
      {metaField && <Form.Item name={metaField} hidden noStyle />}
    </div>
  );
}
