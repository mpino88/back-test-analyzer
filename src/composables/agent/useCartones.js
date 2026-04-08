// HITDASH — useCartones

import { ref, watch } from 'vue';

export function useCartones(filters = {}) {
  const cartones  = ref([]);
  const loading   = ref(false);
  const error     = ref(null);

  const gameType  = ref(filters.gameType  ?? 'pick3');
  const drawType  = ref(filters.drawType  ?? null);
  const status    = ref(filters.status    ?? 'all');
  const limit     = ref(filters.limit     ?? 50);

  async function fetch() {
    loading.value = true;
    error.value   = null;
    try {
      const params = new URLSearchParams({ limit: String(limit.value) });
      if (gameType.value) params.set('game_type', gameType.value);
      if (drawType.value) params.set('draw_type', drawType.value);
      if (status.value && status.value !== 'all') params.set('status', status.value);

      const res  = await window.fetch(`/api/agent/cartones?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      cartones.value = await res.json();
    } catch (e) {
      error.value = e.message;
    } finally {
      loading.value = false;
    }
  }

  watch([gameType, drawType, status, limit], fetch, { immediate: true });

  return { cartones, loading, error, gameType, drawType, status, limit, refresh: fetch };
}
