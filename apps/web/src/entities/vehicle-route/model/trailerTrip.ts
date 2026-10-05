/** Form fields shared by every route editor that can describe up to two trailers. */
export interface TrailerTripInput {
  trailer1Model?: string;
  trailer1RegNumber?: string;
  trailer2Model?: string;
  trailer2RegNumber?: string;
  withTrailer?: boolean;
}

/**
 * Build the route trip fragment from trailer fields.
 *
 * Trailer details must disappear together with the checkbox. Ant Design preserves hidden form
 * fields, so copying values directly could send a trailer that the user has already disabled.
 * Keeping this conversion in the route entity also prevents the five route forms from drifting.
 */
export function trailerTripBody(input: TrailerTripInput): {
  trailer1Model: string;
  trailer1RegNumber: string;
  trailer2Model: string;
  trailer2RegNumber: string;
  withTrailer: boolean;
} {
  const withTrailer = input.withTrailer ?? false;
  return {
    withTrailer,
    trailer1Model: withTrailer ? (input.trailer1Model ?? '') : '',
    trailer1RegNumber: withTrailer ? (input.trailer1RegNumber ?? '') : '',
    trailer2Model: withTrailer ? (input.trailer2Model ?? '') : '',
    trailer2RegNumber: withTrailer ? (input.trailer2RegNumber ?? '') : '',
  };
}
