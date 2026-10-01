/** Semantic half of a period command: an omitted boundary is untouched; `null` removes dateTo. */
export interface VehiclePeriodCommand {
  dateFrom?: string;
  dateTo?: string | null;
}
