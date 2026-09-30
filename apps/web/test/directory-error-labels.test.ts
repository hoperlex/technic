import { describe, expect, it } from 'vitest';
import { containerTypeErrorMessage } from '@entities/container-type';
import { counterpartyErrorMessage } from '@entities/counterparty';
import { departmentErrorMessage } from '@entities/department';
import { driverErrorMessage } from '@entities/driver';
import { mechModelErrorMessage } from '@entities/mech-model';
import { objectErrorMessage } from '@entities/object';
import { officeEquipmentErrorMessage } from '@entities/office-equipment';
import { vehicleTrailerErrorMessage } from '@entities/vehicle-trailer';
import { vehicleTypeErrorMessage } from '@entities/vehicle-type';
import { vehicleErrorMessage } from '@entities/vehicle';
import { warehouseErrorMessage } from '@entities/warehouse';
import { wasteTariffErrorMessage } from '@entities/waste-tariff';
import { wasteTypeErrorMessage } from '@entities/waste-type';

const failure = (field: string): unknown => ({
  code: 'validation_error',
  message: 'Ошибка валидации данных',
  fields: { [field]: 'Некорректное значение' },
  status: 400,
});

describe('directory domain error labels', () => {
  it.each([
    ['тип контейнера', containerTypeErrorMessage, 'code', 'Код'],
    ['контрагент', counterpartyErrorMessage, 'inn', 'ИНН'],
    ['отдел', departmentErrorMessage, 'constructionObjectIds', 'Площадки'],
    ['водитель', driverErrorMessage, 'license.categoryIds', 'Категории'],
    ['модель механизма', mechModelErrorMessage, 'name', 'Название'],
    ['объект', objectErrorMessage, 'address', 'Адрес'],
    ['оргтехника', officeEquipmentErrorMessage, 'inventoryNumber', 'Инвентарный номер'],
    ['прицеп', vehicleTrailerErrorMessage, 'position', 'Слот бланка'],
    ['тип техники', vehicleTypeErrorMessage, 'shortName', 'Короткое имя'],
    ['машина', vehicleErrorMessage, 'registrationNumber', 'Госномер'],
    ['склад', warehouseErrorMessage, 'contactPhone', 'Телефон'],
    ['тариф вывоза', wasteTariffErrorMessage, 'pricePerM3', 'Цена за м³'],
    ['тип мусора', wasteTypeErrorMessage, 'name', 'Название'],
  ] as const)('%s подписывает своё поле', (_domain, format, field, label) => {
    expect(format(failure(field))).toBe(`Ошибка валидации данных: ${label}`);
  });
});
