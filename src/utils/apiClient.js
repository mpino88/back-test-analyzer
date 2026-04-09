// ═══════════════════════════════════════════════════════════════
// HITDASH — API Client (Capa de Seguridad Frontend)
// Centraliza TODAS las peticiones HTTP → inyecta X-API-Key
// SSE también protegido via URL param (EventSource no soporta headers)
// ═══════════════════════════════════════════════════════════════

const API_KEY = import.meta.env.VITE_AGENT_API_KEY || '';

/**
 * Fetch centralizado con autenticación automática.
 * Reemplaza window.fetch() en todos los composables.
 */
export async function apiFetch(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(API_KEY ? { 'X-API-Key': API_KEY } : {}),
    ...(options.headers || {}),
  };

  const res = await window.fetch(path, {
    ...options,
    headers,
  });

  return res;
}

/**
 * Helper GET → JSON directamente con manejo de errores uniforme.
 */
export async function apiGet(path) {
  const res = await apiFetch(path);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Helper POST → JSON.
 */
export async function apiPost(path, body) {
  const res = await apiFetch(path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Helper PATCH → JSON.
 */
export async function apiPatch(path, body) {
  const res = await apiFetch(path, {
    method: 'PATCH',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * SSE autenticado via query param (EventSource no soporta headers custom).
 * El backend acepta ?api_key= como alternativa al header X-API-Key.
 */
export function createAuthSSE(path) {
  const url = API_KEY ? `${path}?api_key=${encodeURIComponent(API_KEY)}` : path;
  return new EventSource(url);
}
