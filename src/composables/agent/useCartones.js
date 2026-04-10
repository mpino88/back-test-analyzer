// HITDASH — useCartones
import { ref, watch } from 'vue';
import { apiGet } from '../../utils/apiClient.js';
import { useBacktestControl } from './useBacktestControl.js';

export function useCartones(filters = {}) {
  const { gameType, mode, setGameType, setMode } = useBacktestControl();
  const cartones  = ref([]);
  const loading   = ref(false);
  const error     = ref(null);

  const status    = ref(filters.status    ?? 'all');
  const limit     = ref(filters.limit     ?? 50);

  async function fetch() {
    loading.value = true;
    error.value   = null;
    try {
      const params = new URLSearchParams({ limit: String(limit.value) });
      if (gameType.value) params.set('game_type', gameType.value);
      
      const parsedDrawType = mode.value === 'combined' ? '' : mode.value;
      if (parsedDrawType) params.set('draw_type', parsedDrawType);
      
      if (status.value && status.value !== 'all') params.set('status', status.value);

      cartones.value = await apiGet(`/api/agent/cartones?${params}`);
    } catch (e) {
      error.value = e.message;
    } finally {
      loading.value = false;
    }
  }

  watch([gameType, mode, status, limit], fetch, { immediate: true });

  return { cartones, loading, error, gameType, mode, status, limit, refresh: fetch, setGameType, setMode };
}
