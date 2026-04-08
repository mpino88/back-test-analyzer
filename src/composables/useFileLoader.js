import { ref } from 'vue';

/**
 * Composable for loading and parsing JSON files via drag & drop or file input.
 */
export function useFileLoader() {
  const data = ref(null);
  const fileName = ref('');
  const error = ref('');
  const isLoading = ref(false);

  async function processFile(file) {
    if (!file) return;

    if (!file.name.endsWith('.json')) {
      error.value = 'Solo se aceptan archivos .json';
      return;
    }

    isLoading.value = true;
    error.value = '';

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);

      if (!parsed.forensicLog && !parsed.topSubsets) {
        throw new Error('El JSON no tiene la estructura esperada. Debe contener al menos "forensicLog" o "topSubsets".');
      }

      data.value = parsed;
      fileName.value = file.name;
    } catch (e) {
      error.value = e.message || 'Error al leer el archivo';
      data.value = null;
      fileName.value = '';
    } finally {
      isLoading.value = false;
    }
  }

  function handleDrop(event) {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    processFile(file);
  }

  function handleFileInput(event) {
    const file = event.target?.files?.[0];
    processFile(file);
  }

  function reset() {
    data.value = null;
    fileName.value = '';
    error.value = '';
  }

  return {
    data,
    fileName,
    error,
    isLoading,
    handleDrop,
    handleFileInput,
    reset,
  };
}
