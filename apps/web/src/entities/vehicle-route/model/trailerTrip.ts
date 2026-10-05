/** Form fields shared by every route editor that can describe up to two trailers. */
export interface TrailerTripInput {
  trailer1Model?: string;
  trailer1RegNumber?: string;
  trailer2Model?: string;
  trailer2RegNumber?: string;
  withTrailer?: boolean;
}

/**
 * Build the route trip fragment from trailer fields, with the same rules in every dialog.
 *
 * Trailer details go only together with the trailer itself: without it the server rejects them
 * ("trailer details are not printed without a trailer on the route"), and the route may still hold
 * them from last time (Ant Design also keeps hidden form fields) — removing the trailer takes its
 * details along.
 *
 * The second trailer goes on equal terms with the first. Before this was extracted, the assignment
 * dialog asked for it (after inheriting from the previous route) and **lost it on submit**: the
 * body had two keys, and the route left with half its composition without a word. Built in one
 * place for all route dialogs, that mistake has nowhere to come back from.
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
