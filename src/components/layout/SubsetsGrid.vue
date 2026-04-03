<template>
  <section class="subsets-grid-section">
    <h2 class="section-title">{{ title }}</h2>
    <div class="subsets-grid">
      <div v-for="(subset, index) in subsets" :key="index" class="subset-wrapper">
        <SubsetCard :subset="subset" />
      </div>
    </div>
  </section>
</template>

<script setup>
import SubsetCard from '../cards/SubsetCard.vue';

defineProps({
  title: {
    type: String,
    required: true,
  },
  subsets: {
    type: Array,
    required: true,
  },
});
</script>

<style scoped>
.subsets-grid-section {
  margin-top: var(--space-6);
  margin-bottom: var(--space-6);
}

.section-title {
  font-size: var(--text-xl);
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: var(--space-4);
  padding-bottom: var(--space-2);
  border-bottom: 2px solid var(--border-color);
  display: inline-block;
}

.subsets-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--space-4);
}

.subset-wrapper {
  animation: fadeIn 0.4s ease forwards;
  opacity: 0;
}

/* Staggered animation */
.subset-wrapper:nth-child(1) { animation-delay: 0.1s; }
.subset-wrapper:nth-child(2) { animation-delay: 0.2s; }
.subset-wrapper:nth-child(3) { animation-delay: 0.3s; }
.subset-wrapper:nth-child(4) { animation-delay: 0.4s; }
.subset-wrapper:nth-child(5) { animation-delay: 0.5s; }
.subset-wrapper:nth-child(n+6) { animation-delay: 0.6s; }

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
