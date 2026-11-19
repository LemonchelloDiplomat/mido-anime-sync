/**
 * MAL accepts integer scores from 1 to 10, while the app stores 0 to 100.
 * Conversion is intentionally lossy and rounds to the nearest MAL point.
 */
export function toMyAnimeListScore(score) {
  const numeric = score == null ? 0 : Number(score);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) {
    throw new RangeError("Оценка MAL должна находиться в диапазоне 0–100.");
  }
  return numeric === 0 ? 0 : Math.max(1, Math.min(10, Math.round(numeric / 10)));
}
