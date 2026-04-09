// HITDASH — useStrategies
import { ref } from 'vue';
import { apiGet } from '../../utils/apiClient.js';

export function useStrategies() {
  const strategies = ref([]);
  const loading    = ref(false);
  const error      = ref(null);

  async function fetch(sort = 'win_rate', order = 'desc') {
    loading.value = true;
    error.value   = null;
    try {
      strategies.value = await apiGet(`/api/agent/strategies?sort=${sort}&order=${order}`);
    } catch (e) {
      error.value = e.message;
    } finally {
      loading.value = false;
    }
  }

  fetch();

  return { strategies, loading, error, refresh: fetch };
}
