// HITDASH — useAlerts

import { ref } from 'vue';

export function useAlerts() {
  const alerts    = ref([]);
  const loading   = ref(false);
  const error     = ref(null);
  const showAcked = ref(false);

  async function fetch() {
    loading.value = true;
    error.value   = null;
    try {
      const res = await window.fetch(`/api/agent/alerts?acknowledged=${showAcked.value}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      alerts.value = await res.json();
    } catch (e) {
      error.value = e.message;
    } finally {
      loading.value = false;
    }
  }

  async function acknowledge(id) {
    try {
      await window.fetch(`/api/agent/alerts/${id}/acknowledge`, { method: 'PATCH' });
      await fetch();
    } catch (e) {
      error.value = e.message;
    }
  }

  fetch();

  return { alerts, loading, error, showAcked, refresh: fetch, acknowledge };
}
