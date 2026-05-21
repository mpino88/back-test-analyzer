// ═══════════════════════════════════════════════════════════════
// HELIX — Format Utilities (F10, 2026-05-21)
//
// Helper único compartido en todas las vistas/composables.
// Antes había 5 definiciones divergentes de pct() — algunas filtraban
// negativos, otras no. Comportamiento inconsistente entre vistas.
// ═══════════════════════════════════════════════════════════════

/**
 * Format a decimal proportion as a percentage string.
 *
 * - null/undefined/NaN → "—"
 * - 0.15 → "15.0%"
 * - -0.03 → "-3.0%" (NEGATIVES PRESERVED — important for vs_azar deltas)
 *
 * @param {number|null|undefined} v - decimal proportion (e.g. 0.15)
 * @param {number} [digits=1] - decimal places
 * @returns {string}
 */
export function pct(v, digits = 1) {
  if (v == null || isNaN(v)) return '—';
  return (Number(v) * 100).toFixed(digits) + '%';
}

/**
 * Format a number with optional decimals; null-safe.
 */
export function fmtN(v, digits = 3) {
  if (v == null || isNaN(v)) return '—';
  return Number(v).toFixed(digits);
}

/**
 * Format a rank/integer (rounded).
 */
export function rank(v) {
  if (v == null || isNaN(v)) return '—';
  return Number(v).toFixed(1);
}

/**
 * Format a date ISO string; null-safe; locale-aware.
 */
export function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return String(iso);
  }
}

/**
 * Format a date as YYYY-MM-DD.
 */
export function formatDateShort(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return String(iso);
  }
}
