/**
 * One size and one weight for every icon in the app.
 *
 * Icons come from Lucide, imported where they are used so only the ones drawn
 * end up in the bundle. Spreading this on each of them is what keeps a row of
 * buttons from looking like it was assembled from three different sets.
 */
export const ICON = { size: 14, strokeWidth: 1.75 } as const

/** Slightly larger, for a row that is a list rather than a button. */
export const ICON_LG = { size: 16, strokeWidth: 1.75 } as const
