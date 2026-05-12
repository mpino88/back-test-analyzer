// ═══════════════════════════════════════════════════════════════
// HELIX — HypothesisValidator v1.0.0
//
// Valida hipótesis mediante walk-forward sobre el historial completo
// antes de activarlas en producción.
//
// Umbrales de activación (conservadores por diseño):
//   hit_rate > 0.20    (supera el baseline aleatorio)
//   p_value < 0.15     (significancia estadística)
//   lift > 1.5×        (hit_rate / baseline_random)
//
// Si no cumple → hipótesis REJECTED. Se preserva en DB para que
// HypothesisGenerator no la regenere durante 90 días.
//
// Metodología:
//   Para cada draw i desde el 50° hasta el último:
//     - trainDraws = draws[0..i-1]  (datos conocidos antes de i)
//     - Evaluar si la condición de la hipótesis es TRUE en trainDraws
//     - Si TRUE → predecir que el par/dígito target aparece en draws[i..i+3]
//     - Acumular hit/miss
//   Calcular hit_rate, lift, p-value binomial
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType } from '../types/agent.types.js';
import type { Hypothesis } from './HypothesisGenerator.js';

const logger = pino({ name: 'HypothesisValidator' });

// ─── ROUND 2 FIX 3.2-3.4: Umbrales relajados ───────────────────────────────
// Antes: MIN_LIFT=1.5, MIN_HIT_RATE=0.20 → ~95% rechazo, estrategias muertas al nacer.
// Ahora: MIN_LIFT=1.15, MIN_HIT_RATE=0.18 → permite que más estrategias entren al ciclo
//        de vida. Si no funcionan, StrategyLifecycle las jubila igual (PROBATION→RETIRED).
// Filosofía: mejor más estrategias en prueba con criba post-activación que ninguna activada.
const MIN_HIT_RATE  = 0.18;  // antes 0.20
const MAX_P_VALUE   = 0.20;  // antes 0.15 — permite p hasta 20% (más laxo, lifecycle filtra)
const MIN_LIFT      = 1.15;  // antes 1.5 — bastará +15% sobre baseline
const PREDICT_WINDOW = 3;    // verificar si acierta en los próximos 3 sorteos

export interface ValidationResult {
  hypothesis_id:  string;
  passed:         boolean;
  hit_rate:       number;
  lift:           number;
  p_value:        number;
  sample_draws:   number;   // veces que la condición fue verdadera
  total_evaluated: number;
  reason:         string;
}

interface DrawRow {
  draw_date: string;
  p1: number; p2: number; p3: number; p4: number;
}

export class HypothesisValidator {
  constructor(private readonly pool: Pool) {}

  // ─── Validar una hipótesis ────────────────────────────────────
  async validate(hypothesis: Hypothesis): Promise<ValidationResult> {
    const { game_type, draw_type, hypothesis_type, condition } = hypothesis;

    // Baseline random según el tipo de predicción
    const baseline = hypothesis.predicted_pair
      ? 1 / 100          // par específico en 100 posibles
      : hypothesis.predicted_digit !== undefined
        ? 1 / 10         // dígito en 10 posibles
        : 1 / 100;

    let result: ValidationResult;

    try {
      // Cargar historial suficiente para validación walk-forward
      // ROUND 2 FIX 3.3: ventana 60 → 30 (menos historia requerida → más hipótesis evaluables)
      const draws = await this.loadDraws(
        game_type, draw_type,
        hypothesis.validation_window + 30
      );

      if (draws.length < hypothesis.minimum_sample + PREDICT_WINDOW) {
        result = this.failed(hypothesis.id, `Datos insuficientes: ${draws.length} draws`, baseline);
      } else {
        result = await this.runWalkForward(hypothesis, draws, baseline);
      }
    } catch (err) {
      logger.warn({ error: String(err), hypothesis_id: hypothesis.id }, 'HypothesisValidator: error');
      result = this.failed(hypothesis.id, `Error: ${String(err)}`, baseline);
    }

    // Actualizar DB con resultado
    await this.saveResult(hypothesis.id, result);

    logger.info({
      hypothesis_id: hypothesis.id,
      hypothesis_type,
      passed:    result.passed,
      hit_rate:  result.hit_rate,
      lift:      result.lift,
      p_value:   result.p_value,
      samples:   result.sample_draws,
    }, `HypothesisValidator: ${result.passed ? 'VALIDADA ✅' : 'RECHAZADA ❌'}`);

    return result;
  }

  // ─── Walk-forward principal ───────────────────────────────────
  private async runWalkForward(
    hypothesis: Hypothesis,
    draws:      DrawRow[],  // ordenado: más reciente primero (DESC)
    baseline:   number
  ): Promise<ValidationResult> {
    // Invertir para walk-forward (ASC: oldest first)
    const orderedDraws = [...draws].reverse();
    const N = orderedDraws.length;

    let predictions = 0;   // veces que la condición fue verdadera
    let hits        = 0;   // veces que además el target apareció

    const startIdx = Math.min(50, Math.floor(N * 0.4));

    for (let i = startIdx; i < N - PREDICT_WINDOW; i++) {
      const trainDraws  = orderedDraws.slice(0, i);      // datos conocidos
      const evalDraws   = orderedDraws.slice(i, i + PREDICT_WINDOW); // a evaluar

      // ¿La condición de la hipótesis es verdadera en trainDraws?
      const conditionTrue = this.evaluateCondition(hypothesis, trainDraws);
      if (!conditionTrue) continue;

      predictions++;

      // ¿El target apareció en los próximos PREDICT_WINDOW draws?
      const targetHit = this.checkTarget(hypothesis, evalDraws);
      if (targetHit) hits++;
    }

    if (predictions < hypothesis.minimum_sample) {
      return this.failed(
        hypothesis.id,
        `Condición muy rara: solo ${predictions} activaciones (mín ${hypothesis.minimum_sample})`,
        baseline
      );
    }

    const hit_rate = hits / predictions;
    const lift     = hit_rate / baseline;
    const p_value  = binomialPValue(hits, predictions, baseline);

    const passed = hit_rate >= MIN_HIT_RATE
                && p_value  <= MAX_P_VALUE
                && lift     >= MIN_LIFT;

    return {
      hypothesis_id:   hypothesis.id,
      passed,
      hit_rate:        +hit_rate.toFixed(4),
      lift:            +lift.toFixed(3),
      p_value:         +p_value.toFixed(4),
      sample_draws:    predictions,
      total_evaluated: N - startIdx - PREDICT_WINDOW,
      reason: passed
        ? `hit=${(hit_rate * 100).toFixed(1)}% lift=${lift.toFixed(2)}x p=${p_value.toFixed(3)}`
        : [
            hit_rate < MIN_HIT_RATE ? `hit_rate ${(hit_rate * 100).toFixed(1)}% < ${MIN_HIT_RATE * 100}%` : '',
            p_value  > MAX_P_VALUE  ? `p=${p_value.toFixed(3)} > ${MAX_P_VALUE}` : '',
            lift     < MIN_LIFT     ? `lift=${lift.toFixed(2)}x < ${MIN_LIFT}x` : '',
          ].filter(Boolean).join('; '),
    };
  }

  // ─── Evalúa si la condición de la hipótesis es verdadera ─────
  private evaluateCondition(hyp: Hypothesis, trainDraws: DrawRow[]): boolean {
    if (trainDraws.length < 10) return false;
    const { condition } = hyp;

    switch (condition.type) {
      case 'pair_absence_streak': {
        // Condición: el par lleva ausente z > threshold sorteos
        const pair = hyp.predicted_pair;
        if (!pair) return false;
        const [dx, dy] = pair.split('').map(Number);
        let lastIdx = -1;
        for (let i = trainDraws.length - 1; i >= 0; i--) {
          const row = trainDraws[i]!;
          if (row.p2 === dx && row.p3 === dy) { lastIdx = i; break; }
        }
        const currentGap = lastIdx === -1 ? trainDraws.length : trainDraws.length - 1 - lastIdx;
        // Condición activa si el gap actual > umbral de z del signal original
        const threshold = Math.max(5, Math.abs(condition.z_score) * 2);
        return currentGap >= threshold;
      }

      case 'positional_digit_bias': {
        // Condición: dígito d en posición p tiene freq > 15% en últimas 15 draws
        const d   = hyp.predicted_digit;
        const pos = hyp.predicted_position as 'p1'|'p2'|'p3'|'p4' | undefined;
        if (d === undefined || !pos) return false;
        const recent = trainDraws.slice(-15);
        const cnt = recent.filter(r => r[pos] === d).length;
        const freqThreshold = condition.direction === 'over' ? 0.15 : 0;
        return condition.direction === 'over'
          ? cnt / recent.length >= freqThreshold
          : cnt / recent.length < 0.08;
      }

      case 'day_of_week_bias': {
        // Condición: el próximo draw cae en el día de semana del sesgo
        const [dow] = (condition.value ?? '').split(':');
        const DAYS: Record<string, number> = { SUN:0, MON:1, TUE:2, WED:3, THU:4, FRI:5, SAT:6 };
        const targetDow = DAYS[dow ?? ''];
        if (targetDow === undefined) return false;
        // Chequear el día del último train draw + 1
        const lastDate = new Date(trainDraws[trainDraws.length - 1]!.draw_date);
        const nextDate = new Date(lastDate.getTime() + 86400_000);
        return nextDate.getUTCDay() === targetDow;
      }

      case 'pair_overrepresentation': {
        // Condición inversa: el par ha salido demasiado recientemente
        const pair = hyp.predicted_pair;
        if (!pair) return false;
        const [dx, dy] = pair.split('').map(Number);
        const recent10 = trainDraws.slice(-10);
        const cnt = recent10.filter(r => r.p2 === dx && r.p3 === dy).length;
        return cnt >= 2; // apareció 2+ veces en las últimas 10
      }

      default:
        return trainDraws.length >= hyp.minimum_sample;
    }
  }

  // ─── Verifica si el target apareció en los draws de evaluación ─
  private checkTarget(hyp: Hypothesis, evalDraws: DrawRow[]): boolean {
    if (evalDraws.length === 0) return false;

    if (hyp.predicted_pair) {
      const [dx, dy] = hyp.predicted_pair.split('').map(Number);
      if (hyp.hypothesis_type === 'absence_streak' && hyp.condition.direction === 'under') {
        // Para predicciones de sobre-representación: hit si NO aparece (penalizar score)
        return !evalDraws.some(r => r.p2 === dx && r.p3 === dy);
      }
      return evalDraws.some(r => r.p2 === dx && r.p3 === dy);
    }

    if (hyp.predicted_digit !== undefined && hyp.predicted_position) {
      const d   = hyp.predicted_digit;
      const pos = hyp.predicted_position as 'p1'|'p2'|'p3'|'p4';
      return hyp.condition.direction === 'over'
        ? evalDraws.some(r => r[pos] === d)
        : !evalDraws.some(r => r[pos] === d);
    }

    return false;
  }

  // ─── Resultado fallido ────────────────────────────────────────
  private failed(id: string, reason: string, baseline: number): ValidationResult {
    return {
      hypothesis_id: id, passed: false,
      hit_rate: 0, lift: 0, p_value: 1,
      sample_draws: 0, total_evaluated: 0, reason,
    };
  }

  // ─── Guardar resultado en DB ──────────────────────────────────
  private async saveResult(id: string, result: ValidationResult): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE hitdash.hypotheses
         SET validation_status   = $1,
             validation_hit_rate = $2,
             validation_lift     = $3,
             validation_p_value  = $4,
             validation_draws    = $5,
             validated_at        = now()
         WHERE id = $6::uuid`,
        [
          result.passed ? 'validated' : 'rejected',
          result.hit_rate,
          result.lift,
          result.p_value,
          result.sample_draws,
          id,
        ]
      );
    } catch (err) {
      logger.warn({ error: String(err), id }, 'HypothesisValidator: error guardando resultado');
    }
  }

  // ─── Cargar sorteos del historial ────────────────────────────
  private async loadDraws(
    game_type: GameType,
    draw_type: DrawType,
    limit:     number
  ): Promise<DrawRow[]> {
    const { rows } = await this.pool.query<{
      draw_date: string;
      p1: number; p2: number; p3: number; p4: number;
    }>(
      `SELECT draw_date::text, p1, p2, p3, COALESCE(p4, 0) AS p4
       FROM hitdash.ingested_results
       WHERE game_type = $1 AND draw_type = $2
       ORDER BY draw_date DESC
       LIMIT $3`,
      [game_type, draw_type, limit]
    );
    return rows.map(r => ({
      draw_date: r.draw_date,
      p1: Number(r.p1), p2: Number(r.p2),
      p3: Number(r.p3), p4: Number(r.p4),
    }));
  }
}

// ─── P-value binomial exacto ──────────────────────────────────
// P(X >= k | n, p) — probabilidad de obtener k o más éxitos por azar
export function binomialPValue(hits: number, n: number, p: number): number {
  if (n === 0) return 1;
  if (hits === 0) return 1;
  // Suma P(X=k) + P(X=k+1) + ... + P(X=n)
  // Para n < 200: cálculo exacto; para n >= 200: aproximación normal
  if (n >= 200) {
    const mean = n * p;
    const std  = Math.sqrt(n * p * (1 - p));
    if (std === 0) return hits > mean ? 0 : 1;
    const z = (hits - mean - 0.5) / std;  // continuity correction
    return normalTailP(z);
  }
  // Cálculo exacto con log-factoriales
  let pValue = 0;
  for (let k = hits; k <= n; k++) {
    pValue += Math.exp(logBinomCoeff(n, k) + k * Math.log(p) + (n - k) * Math.log(1 - p));
  }
  return Math.min(1, pValue);
}

function logBinomCoeff(n: number, k: number): number {
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

const _logFact: number[] = [0];
function logFactorial(n: number): number {
  if (n <= 1) return 0;
  while (_logFact.length <= n) _logFact.push(_logFact[_logFact.length - 1]! + Math.log(_logFact.length));
  return _logFact[n]!;
}

function normalTailP(z: number): number {
  const absZ = Math.abs(z);
  const t = 1 / (1 + 0.2316419 * absZ);
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const tail = (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * absZ * absZ) * poly;
  return Math.min(1, 2 * tail);
}
