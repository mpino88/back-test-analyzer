-- ═══════════════════════════════════════════════════════════════
-- Migración 010: Extender alert_type constraint
--
-- FALLA F01 FORENSE: HitdashAgent inserta 'strategy_opportunity' y
-- 'backtest_triggered' que violan el CHECK original de 001_hitdash_schema.sql.
-- Consecuencia: AlertsView siempre vacía. Alertas prescriptivas silenciosas.
--
-- Fix: Drops + recreates constraint with the full valid set.
-- ═══════════════════════════════════════════════════════════════

-- Eliminar constraint actual (nombre generado por PostgreSQL)
ALTER TABLE hitdash.proactive_alerts
  DROP CONSTRAINT IF EXISTS proactive_alerts_alert_type_check;

-- Reinstalar con todos los tipos requeridos por el sistema vivo
ALTER TABLE hitdash.proactive_alerts
  ADD CONSTRAINT proactive_alerts_alert_type_check
  CHECK (alert_type IN (
    'anomaly',              -- Anomalía estadística detectada
    'streak',               -- Racha de ausencia/presencia extrema
    'overdue',              -- Dígito/par muy tiempo sin aparecer
    'drift',                -- Deriva en distribución de sorteos
    'system',               -- Alerta de infraestructura
    'low_data',             -- Datos insuficientes para análisis
    'strategy_opportunity', -- ← NUEVO: señal de estrategia activa
    'backtest_triggered'    -- ← NUEVO: backtest proactivo iniciado
  ));

-- ═══════════════════════════════════════════════════════════════
-- Validar que no quedan filas huérfanas (debería ser 0 tras esta mig)
-- SELECT COUNT(*) FROM hitdash.proactive_alerts
-- WHERE alert_type NOT IN ('anomaly','streak','overdue','drift','system','low_data',
--   'strategy_opportunity','backtest_triggered');
-- ═══════════════════════════════════════════════════════════════
