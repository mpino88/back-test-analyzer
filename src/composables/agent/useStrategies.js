// HITDASH — useStrategies

import { ref } from 'vue';

export function useStrategies() {
  const strategies = ref([]);
  const loading    = ref(false);
  const error      = ref(null);

  async function fetch(sort = 'win_rate', order = 'desc') {
    loading.value = true;
    error.value   = null;
    try {
      const res = await window.fetch(`/api/agent/strategies?sort=${sort}&order=${order}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      strategies.value = await res.json();
    } catch (e) {
      error.value = e.message;
    } finally {
      loading.value = false;
    }
  }

  fetch();

  return { strategies, loading, error, refresh: fetch };
}
