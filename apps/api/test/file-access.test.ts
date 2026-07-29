import { describe, expect, it, vi } from 'vitest';
import type { Role } from '@technic/contracts';
import type { Principal } from '../src/auth/principal';

// Модуль маршрутов тянет S3-клиент и конфиг — для правила доступа нужен только сам файл.
vi.mock('../src/db/client', () => ({ db: {}, pingDb: async () => {} }));
vi.mock('../src/lib/s3', () => ({
  buildObjectKey: () => 'key',
  deleteObject: async () => {},
  headObject: async () => null,
  presignGet: async () => 'url',
  presignPut: async () => 'url',
}));
vi.mock('../src/config', () => ({
  config: { files: { maxSize: 1 }, s3: { bucket: 'b', uploadUrlTtl: 1, downloadUrlTtl: 1 } },
}));

const { decideFileAccess } = await import('../src/routes/files');

/**
 * Доступ к файлу — единственное место, где право выводится не из роли, а из связанной записи
 * (ADR 0021). Два обхода, которые здесь и закрыты: авторство загрузки как бессрочный ключ и
 * ветка «вывоз мусора», проходимая ролью без права на этот модуль.
 */

const UPLOADER = 'uploader-1';

function principal(role: Role | null, id = UPLOADER): Principal {
  return {
    id,
    email: 'user@test.local',
    fullName: 'Пользователь',
    role,
    isActive: true,
    mustChangePassword: false,
    constructionObjectId: null,
    counterpartyId: null,
    authVersion: 1,
  };
}

const NOWHERE = { visibleWaste: false, visibleVehicle: false, linkedAnywhere: false };
const IN_WASTE = { visibleWaste: true, visibleVehicle: false, linkedAnywhere: true };
const IN_VEHICLE = { visibleWaste: false, visibleVehicle: true, linkedAnywhere: true };
/** Файл лежит в заявке, которую этот пользователь не видит (чужой объект, чужой контрагент). */
const IN_INVISIBLE_REQUEST = { visibleWaste: false, visibleVehicle: false, linkedAnywhere: true };

describe('файл, ещё не привязанный к заявке', () => {
  it('виден тому, кто его загрузил: иначе не заполнить форму', () => {
    expect(decideFileAccess(principal('shtab'), UPLOADER, NOWHERE)).toBe(true);
  });

  it('чужому не виден, какой бы ни была роль', () => {
    expect(decideFileAccess(principal('admin', 'other-user'), UPLOADER, NOWHERE)).toBe(false);
  });

  it('файл без автора не виден никому', () => {
    expect(decideFileAccess(principal('admin'), null, NOWHERE)).toBe(false);
  });
});

describe('привязанный файл живёт по правилам своей заявки', () => {
  it('автор теряет доступ, когда заявка перестала быть ему видна', () => {
    // Тот же человек, тот же файл: заявку перенесли на другой объект (или сменилась роль) —
    // видимости нет, и прежняя загрузка больше ничего не даёт.
    expect(decideFileAccess(principal('shtab'), UPLOADER, IN_INVISIBLE_REQUEST)).toBe(false);
  });

  it('видимая заявка вывоза открывает файл тому, кто вправе её читать', () => {
    for (const role of [
      'admin',
      'manager',
      'dispatcher',
      'shtab',
      'rukstroy',
      'operator',
    ] as Role[]) {
      expect(decideFileAccess(principal(role, 'other'), UPLOADER, IN_WASTE), role).toBe(true);
    }
  });

  it('вложение заказа ТС оператору вывоза недоступно (ADR 0010)', () => {
    expect(decideFileAccess(principal('operator', 'other'), UPLOADER, IN_VEHICLE)).toBe(false);
    expect(decideFileAccess(principal('dispatcher', 'other'), UPLOADER, IN_VEHICLE)).toBe(true);
  });
});

describe('учётка без роли', () => {
  it('не получает файл ни одной заявки, даже зная её связь', () => {
    expect(decideFileAccess(principal(null, 'other'), UPLOADER, IN_WASTE)).toBe(false);
    expect(decideFileAccess(principal(null, 'other'), UPLOADER, IN_VEHICLE)).toBe(false);
    expect(decideFileAccess(principal(null, 'other'), UPLOADER, IN_INVISIBLE_REQUEST)).toBe(false);
  });

  it('её собственный неприкреплённый файл ей доступен — он больше ничей', () => {
    expect(decideFileAccess(principal(null), UPLOADER, NOWHERE)).toBe(true);
  });
});
