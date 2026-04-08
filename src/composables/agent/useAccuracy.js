// HITDASH — useAccuracy

import { ref, watch } from 'vue';

export function useAccuracy() {
  const data    = ref(null);
  const loading = ref(false);
  const error   = ref(null);
  const range   = ref('30d');

  async function fetch() {
    loading.value = true;
    error.value   = null;
    try {
      const res = await window.fetch(`/api/agent/accuracy?range=${range.value}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data.value = await res.json();
    } catch (e) {
      error.value = e.message;
    } finally {
      loading.value = false;
    }
  }

  watch(range, fetch, { immediate: true });

  return { data, loading, error, range, refresh: fetch };
}
