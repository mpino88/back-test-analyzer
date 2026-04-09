// HITDASH — useAlerts
import { ref } from 'vue';
import { apiGet, apiPatch } from '../../utils/apiClient.js';

export function useAlerts() {
  const alerts    = ref([]);
  const loading   = ref(false);
  const error     = ref(null);
  const showAcked = ref(false);

  async function fetch() {
    loading.value = true;
    error.value   = null;
    try {
      alerts.value = await apiGet(`/api/agent/alerts?acknowledged=${showAcked.value}`);
    } catch (e) {
      error.value = e.message;
    } finally {
      loading.value = false;
    }
  }

  async function acknowledge(id) {
    try {
      await apiPatch(`/api/agent/alerts/${id}/acknowledge`);
      await fetch();
    } catch (e) {
      error.value = e.message;
    }
  }

  fetch();

  return { alerts, loading, error, showAcked, refresh: fetch, acknowledge };
}
