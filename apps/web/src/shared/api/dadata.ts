// Клиент подсказок адресов DaData (сервис «Подсказки», ADR 0006).
// Вызывается напрямую из браузера — endpoint поддерживает CORS; токен публичный,
// но ДОЛЖЕН быть ограничен по домену в кабинете DaData (иначе сольют квоту).
// Секретный ключ «Стандартизации» здесь НЕ используется (мягкая модель верификации).

const ENDPOINT = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address';
const TOKEN = (import.meta.env.VITE_DADATA_SUGGEST_TOKEN as string | undefined)?.trim();

/** Предупреждение печатается один раз: иначе им зальёт консоль на каждом адресном поле. */
let warned = false;

/** Подсказки доступны только при заданном токене; иначе поле работает как обычный ввод. */
export function dadataEnabled(): boolean {
  if (!TOKEN && !warned) {
    warned = true;
    // Диагностика деградации: без токена подсказки отключены на всех адресных полях. Печатается
    // отсюда, а не при импорте модуля: после сборки сегмента в один вход предупреждение звучало бы
    // у всех, кто взял из `@shared/api` хоть что-нибудь, и мешало бы отбрасывать неиспользуемый код.
    console.warn(
      '[dadata] VITE_DADATA_SUGGEST_TOKEN не задан на сборке — подсказки адресов отключены, поля адреса работают как обычный ввод.',
    );
  }
  return !!TOKEN;
}

export interface DadataAddressData {
  fias_id: string | null;
  fias_level: string | null;
  geo_lat: string | null;
  geo_lon: string | null;
  [k: string]: unknown;
}

export interface DadataSuggestion {
  value: string;
  unrestricted_value: string;
  data: DadataAddressData;
}

/** Запрос подсказок. Короткие запросы (<3 симв.) и отсутствие токена → пустой список. */
export async function suggestAddress(
  query: string,
  count = 8,
  signal?: AbortSignal,
): Promise<DadataSuggestion[]> {
  if (!TOKEN || query.trim().length < 3) return [];
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Token ${TOKEN}`,
    },
    body: JSON.stringify({ query, count }),
  });
  if (!res.ok) throw new Error(`DaData ${res.status}`);
  const json = (await res.json()) as { suggestions?: DadataSuggestion[] };
  return json.suggestions ?? [];
}
