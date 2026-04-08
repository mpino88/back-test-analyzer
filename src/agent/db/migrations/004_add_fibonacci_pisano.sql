-- ═══════════════════════════════════════════════════════════════
-- Migración 004: registrar estrategia fibonacci_pisano
-- ═══════════════════════════════════════════════════════════════

INSERT INTO hitdash.strategy_registry (name, description, algorithm, parameters, status)
VALUES (
  'fibonacci_pisano',
  'Alineación de dígitos con el período de Pisano mod 10 = 60 (fase cíclica fibonacci)',
  'fibonacci',
  '{"pisano_period": 60, "min_alignment_score": 1.1}',
  'testing'
)
ON CONFLICT (name) DO NOTHING;
