<template>
  <div
    class="dropzone"
    :class="{ 'dropzone--active': isDragging, 'dropzone--error': error }"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent="onDragOver"
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
  >
    <div class="dropzone__content">
      <div class="dropzone__icon">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
      </div>
      <h2 class="dropzone__title">Arrastra tu archivo JSON aquí</h2>
      <p class="dropzone__subtitle">
        o haz clic para seleccionar
      </p>
      <label class="dropzone__button" for="file-input">
        Seleccionar archivo
        <input
          id="file-input"
          type="file"
          accept=".json"
          class="dropzone__input"
          @change="$emit('file-input', $event)"
        />
      </label>
      <p v-if="error" class="dropzone__error">{{ error }}</p>
      <p class="dropzone__hint">
        Formato esperado: <code>ballbacktest_audit_report.json</code>
      </p>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';

defineProps({
  error: { type: String, default: '' },
});

const emit = defineEmits(['drop', 'file-input']);

const isDragging = ref(false);
let dragCounter = 0;

function onDragEnter() {
  dragCounter++;
  isDragging.value = true;
}

function onDragOver() {
  isDragging.value = true;
}

function onDragLeave() {
  dragCounter--;
  if (dragCounter <= 0) {
    isDragging.value = false;
    dragCounter = 0;
  }
}

function onDrop(event) {
  isDragging.value = false;
  dragCounter = 0;
  emit('drop', event);
}
</script>

<style scoped>
.dropzone {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: var(--space-8);
}

.dropzone__content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-16) var(--space-12);
  border: 2px dashed var(--border-dropzone);
  border-radius: var(--radius-2xl);
  background: var(--bg-dropzone);
  max-width: 520px;
  width: 100%;
  text-align: center;
  transition: all var(--transition-base);
  cursor: pointer;
  animation: fadeInUp 0.6s ease forwards;
}

.dropzone--active .dropzone__content {
  border-color: var(--accent-primary);
  background: var(--bg-dropzone-hover);
  transform: scale(1.02);
  box-shadow: var(--shadow-glow);
}

.dropzone--error .dropzone__content {
  border-color: var(--color-miss);
}

.dropzone__icon {
  color: var(--accent-primary-light);
  opacity: 0.7;
  transition: all var(--transition-base);
}

.dropzone--active .dropzone__icon {
  opacity: 1;
  transform: translateY(-4px);
}

.dropzone__title {
  font-size: var(--text-xl);
  font-weight: var(--font-semibold);
  color: var(--text-primary);
}

.dropzone__subtitle {
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.dropzone__button {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-6);
  background: var(--accent-primary);
  color: white;
  border-radius: var(--radius-lg);
  font-size: var(--text-sm);
  font-weight: var(--font-medium);
  cursor: pointer;
  transition: all var(--transition-fast);
  margin-top: var(--space-2);
}

.dropzone__button:hover {
  background: var(--accent-primary-light);
  box-shadow: var(--shadow-glow);
}

.dropzone__input {
  display: none;
}

.dropzone__error {
  color: var(--color-miss);
  font-size: var(--text-sm);
  font-weight: var(--font-medium);
}

.dropzone__hint {
  color: var(--text-tertiary);
  font-size: var(--text-xs);
  margin-top: var(--space-4);
}

.dropzone__hint code {
  font-family: var(--font-mono);
  color: var(--text-secondary);
  background: rgba(255, 255, 255, 0.05);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
}
</style>
