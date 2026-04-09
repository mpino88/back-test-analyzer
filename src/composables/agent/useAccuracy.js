// HITDASH — useAccuracy
import { ref, watch } from 'vue';
import { apiGet } from '../../utils/apiClient.js';

export function useAccuracy() {
  const data    = ref(null);
  const loading = ref(false);
  const error   = ref(null);
  const range   = ref('30d');

  async function fetch() {
    loading.value = true;
    error.value   = null;
    try {
      data.value = await apiGet(`/api/agent/accuracy?range=${range.value}`);
    } catch (e) {
      error.value = e.message;
    } finally {
      loading.value = false;
    }
  }

  watch(range, fetch, { immediate: true });

  return { data, loading, error, range, refresh: fetch };
}
