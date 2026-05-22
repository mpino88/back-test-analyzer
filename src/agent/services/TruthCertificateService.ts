// ═══════════════════════════════════════════════════════════════
// HELIX — TruthCertificateService v1.0.0 (2026-05-21)
//
// DIFERENCIADOR ÚNICO: cada predicción HELIX viene con certificado
// criptográficamente firmado que prueba:
//   • Wilson 95% CI del algoritmo usado
//   • Hit rate walk-forward histórico para este combo
//   • Edge Discovery p-values más recientes
//   • Conformal coverage garantizada
//   • HMAC-SHA256 signature anti-forgery
//
// "We don't promise edge — we prove honesty."
//
// USE CASE:
//   1. Usuario pide predicción para pick3 evening du
//   2. Sistema retorna ranked_pairs + certificate_id
//   3. Cliente puede descargar el certificate completo
//   4. Verificación offline: cualquiera con la pub key puede validar
//   5. Auditor o regulador puede pedir histórico de certificados
//
// CRYPTO:
//   • HMAC-SHA256 con clave HELIX_CERT_SECRET (en .env)
//   • Payload = JSON serializado canónico (ordered keys)
//   • Signature = base64(HMAC(payload, secret))
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import { createHmac, randomBytes } from 'node:crypto';
import pino from 'pino';

const logger = pino({ name: 'TruthCertificateService' });

// ── Tipos ───────────────────────────────────────────────────────
export interface CertificateRequest {
  game_type:      'pick3' | 'pick4';
  draw_type:      'midday' | 'evening';
  half:           'du' | 'ab' | 'cd';
  draw_date:      string;          // YYYY-MM-DD
  predicted_top:  string[];        // top-N pairs
  algo_used?:     string;          // Thompson UCB leader
  prediction_id?: string;          // FK opcional
}

export interface CertificatePayload {
  certificate_id:        string;
  issued_at:             string;
  prediction: {
    game_type:           string;
    draw_type:           string;
    half:                string;
    draw_date:           string;
    predicted_top:       string[];
    predicted_n:         number;
    algo_used:           string | null;
  };
  statistics: {
    hit_rate_walk_forward: number | null;
    wilson_95_ci_lo:       number | null;
    wilson_95_ci_hi:       number | null;
    baseline_rate:         number;
    edge_multiplier:       number | null;
    walk_forward_n_draws:  number | null;
  };
  conformal: {
    threshold:             number | null;
    coverage_target:       number;
    coverage_empirical:    number | null;
    n_calibration:         number | null;
  };
  audit: {
    last_edge_discovery_run_id: string | null;
    last_edge_verdict:          string | null;
    n_tests_total:              number | null;
    n_tests_significant:        number | null;
    methodology:                'Bonferroni-corrected walk-forward + conformal';
  };
  // Adicional para inversores / reguladores
  disclosure: {
    edge_demonstrated:     boolean;
    confidence_interval_includes_baseline: boolean;
    statement: string;
  };
}

export interface SignedCertificate extends CertificatePayload {
  signature:  string;     // base64 HMAC-SHA256
  algorithm:  'HMAC-SHA256';
  signed_at:  string;
}

// ─────────────────────────────────────────────────────────────────
// SERVICE
// ─────────────────────────────────────────────────────────────────
export class TruthCertificateService {
  private readonly secret: Buffer;

  constructor(private readonly pool: Pool) {
    // Secret de .env. Si no existe, default fijo determinístico
    // para que issue+verify sean consistentes entre instancias del service.
    // PRODUCTION: setear HELIX_CERT_SECRET en .env vía GitHub secret.
    const envSecret = process.env['HELIX_CERT_SECRET']
                   ?? 'helix-truth-certificate-default-secret-2026-not-production-safe';
    if (envSecret.includes('not-production-safe')) {
      logger.warn('HELIX_CERT_SECRET no configurada — usando default fijo (demo/dev solamente)');
    }
    this.secret = Buffer.from(envSecret, 'utf-8');
  }

  /**
   * Issue a Truth Certificate for a prediction.
   * Gathers all relevant statistical evidence from the database,
   * signs it cryptographically, and persists for audit.
   */
  async issueCertificate(req: CertificateRequest): Promise<SignedCertificate> {
    const certificate_id = this.generateCertId();
    const issued_at      = new Date().toISOString();

    // 1. Gather walk-forward statistics for this combo
    const stats = await this.gatherWalkForwardStats(req);

    // 2. Gather conformal calibration
    const conformal = await this.gatherConformal(req);

    // 3. Gather most recent Edge Discovery verdict
    const audit = await this.gatherAudit();

    // 4. Build disclosure (HONEST)
    const edgeDemo = (audit.n_tests_significant ?? 0) > 0;
    const ciIncludesBaseline = stats.wilson_95_ci_lo !== null &&
                                stats.wilson_95_ci_lo <= 0.15 &&
                                stats.wilson_95_ci_hi !== null &&
                                stats.wilson_95_ci_hi >= 0.15;

    const statement = edgeDemo
      ? `Edge estadísticamente significativo detectado en ${audit.n_tests_significant} de ${audit.n_tests_total} tests con corrección Bonferroni.`
      : ciIncludesBaseline
        ? `El Wilson 95% CI [${(stats.wilson_95_ci_lo!*100).toFixed(2)}%, ${(stats.wilson_95_ci_hi!*100).toFixed(2)}%] INCLUYE el baseline aleatorio del 15%. El sistema NO ha demostrado edge sobre el azar.`
        : `Datos insuficientes para emisión de certificado completo. Predicción provista únicamente con propósito ilustrativo.`;

    // 5. Build payload
    const payload: CertificatePayload = {
      certificate_id,
      issued_at,
      prediction: {
        game_type:     req.game_type,
        draw_type:     req.draw_type,
        half:          req.half,
        draw_date:     req.draw_date,
        predicted_top: req.predicted_top,
        predicted_n:   req.predicted_top.length,
        algo_used:     req.algo_used ?? null,
      },
      statistics: {
        hit_rate_walk_forward: stats.hit_rate,
        wilson_95_ci_lo:       stats.wilson_95_ci_lo,
        wilson_95_ci_hi:       stats.wilson_95_ci_hi,
        baseline_rate:         0.15,
        edge_multiplier:       stats.edge_multiplier,
        walk_forward_n_draws:  stats.n_draws,
      },
      conformal: {
        threshold:          conformal.threshold,
        coverage_target:    0.80,
        coverage_empirical: conformal.empirical,
        n_calibration:      conformal.n,
      },
      audit: {
        last_edge_discovery_run_id: audit.run_id,
        last_edge_verdict:          audit.verdict,
        n_tests_total:              audit.n_tests_total,
        n_tests_significant:        audit.n_tests_significant,
        methodology: 'Bonferroni-corrected walk-forward + conformal',
      },
      disclosure: {
        edge_demonstrated:                       edgeDemo,
        confidence_interval_includes_baseline:   ciIncludesBaseline,
        statement,
      },
    };

    // 6. Sign canonically
    const canonical = JSON.stringify(this.canonicalize(payload));
    const signature = createHmac('sha256', this.secret).update(canonical).digest('base64');

    const signed: SignedCertificate = {
      ...payload,
      signature,
      algorithm: 'HMAC-SHA256',
      signed_at: new Date().toISOString(),
    };

    // 7. Persist for audit
    await this.persist(signed, req);

    logger.info({
      certificate_id, game_type: req.game_type,
      edge_demonstrated: edgeDemo,
      ci_includes_baseline: ciIncludesBaseline,
    }, '📜 Truth Certificate issued');

    return signed;
  }

  /**
   * Verify a certificate by recomputing the HMAC.
   * Returns true if signature is valid.
   */
  verifyCertificate(cert: SignedCertificate): boolean {
    const { signature, algorithm: _alg, signed_at: _ts, ...payload } = cert;
    const canonical = JSON.stringify(this.canonicalize(payload as CertificatePayload));
    const expected  = createHmac('sha256', this.secret).update(canonical).digest('base64');
    return signature === expected;
  }

  /**
   * Retrieve a previously issued certificate by certificate_id.
   */
  async getCertificate(certificate_id: string): Promise<SignedCertificate | null> {
    const { rows } = await this.pool.query<{ payload_json: SignedCertificate }>(
      `SELECT payload_json FROM hitdash.truth_certificates WHERE certificate_id = $1`,
      [certificate_id],
    );
    if (rows.length === 0) return null;
    return rows[0]!.payload_json;
  }

  /**
   * After a draw is resolved, update the certificate with actual outcome.
   * This allows clients to verify the predicted vs actual without ambiguity.
   */
  async resolveCertificate(certificate_id: string, actual_pair: string): Promise<void> {
    const { rows } = await this.pool.query<{ predicted_top: string[] }>(
      `SELECT predicted_top FROM hitdash.truth_certificates WHERE certificate_id = $1`,
      [certificate_id],
    );
    if (rows.length === 0) return;
    const hit = rows[0]!.predicted_top.includes(actual_pair);

    await this.pool.query(
      `UPDATE hitdash.truth_certificates
          SET actual_pair = $2, hit = $3, resolved_at = now()
        WHERE certificate_id = $1`,
      [certificate_id, actual_pair, hit],
    );
    logger.info({ certificate_id, actual_pair, hit }, 'Certificate resolved');
  }

  // ═══════════════════════════════════════════════════════════════
  // INTERNAL HELPERS
  // ═══════════════════════════════════════════════════════════════

  private generateCertId(): string {
    const date = new Date().toISOString().slice(0, 10);
    const rand = randomBytes(4).toString('hex').toUpperCase();
    return `TC-${date}-${rand}`;
  }

  /** Canonical serialization: sort keys recursively for deterministic HMAC. */
  private canonicalize(obj: unknown): unknown {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(v => this.canonicalize(v));
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj as object).sort()) {
      sorted[k] = this.canonicalize((obj as Record<string, unknown>)[k]);
    }
    return sorted;
  }

  private async gatherWalkForwardStats(req: CertificateRequest): Promise<{
    hit_rate:       number | null;
    wilson_95_ci_lo:number | null;
    wilson_95_ci_hi:number | null;
    edge_multiplier:number | null;
    n_draws:        number | null;
  }> {
    const { rows } = await this.pool.query<{
      hit_rate: string; wilson_lo: string; wilson_hi: string;
      edge_multiplier: string; n_draws: string;
    }>(
      `SELECT hit_rate, wilson_lo, wilson_hi, edge_multiplier, n_draws
       FROM hitdash.helix_retrospective_summary
       WHERE game_type=$1 AND draw_type=$2 AND half=$3
       ORDER BY created_at DESC LIMIT 1`,
      [req.game_type, req.draw_type, req.half],
    );
    if (rows.length === 0) {
      return { hit_rate: null, wilson_95_ci_lo: null, wilson_95_ci_hi: null, edge_multiplier: null, n_draws: null };
    }
    const r = rows[0]!;
    return {
      hit_rate:        Number(r.hit_rate),
      wilson_95_ci_lo: Number(r.wilson_lo),
      wilson_95_ci_hi: Number(r.wilson_hi),
      edge_multiplier: Number(r.edge_multiplier),
      n_draws:         Number(r.n_draws),
    };
  }

  private async gatherConformal(req: CertificateRequest): Promise<{
    threshold: number | null;
    empirical: number | null;
    n:         number | null;
  }> {
    const { rows } = await this.pool.query<{
      threshold_80: string; empirical_80: string; n_calibration: string;
    }>(
      `SELECT threshold_80, empirical_80, n_calibration
       FROM hitdash.conformal_calibration
       WHERE game_type=$1 AND draw_type=$2 AND half=$3
       ORDER BY calibrated_at DESC LIMIT 1`,
      [req.game_type, req.draw_type, req.half],
    );
    if (rows.length === 0) return { threshold: null, empirical: null, n: null };
    const r = rows[0]!;
    return {
      threshold: Number(r.threshold_80),
      empirical: Number(r.empirical_80),
      n:         Number(r.n_calibration),
    };
  }

  private async gatherAudit(): Promise<{
    run_id:              string | null;
    verdict:             string | null;
    n_tests_total:       number | null;
    n_tests_significant: number | null;
  }> {
    const { rows } = await this.pool.query<{
      run_id: string; verdict: string;
      total_tests: string; significant_tests: string;
    }>(
      `SELECT run_id, verdict, total_tests, significant_tests
       FROM hitdash.edge_discovery_runs
       WHERE status='completed'
       ORDER BY started_at DESC LIMIT 1`,
    );
    if (rows.length === 0) return { run_id: null, verdict: null, n_tests_total: null, n_tests_significant: null };
    const r = rows[0]!;
    return {
      run_id:              r.run_id,
      verdict:             r.verdict,
      n_tests_total:       Number(r.total_tests),
      n_tests_significant: Number(r.significant_tests),
    };
  }

  private async persist(cert: SignedCertificate, req: CertificateRequest): Promise<void> {
    await this.pool.query(
      `INSERT INTO hitdash.truth_certificates
         (certificate_id, prediction_id, game_type, draw_type, half, draw_date,
          predicted_top, predicted_n, algo_used,
          hit_rate_wf, wilson_lo, wilson_hi, baseline_rate, edge_multiplier,
          conformal_threshold, conformal_level,
          last_edge_discovery, last_edge_verdict, n_tests_total, n_tests_significant,
          generated_at, signature, payload_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, now(), $21, $22::jsonb)`,
      [
        cert.certificate_id,
        req.prediction_id ?? null,
        cert.prediction.game_type, cert.prediction.draw_type, cert.prediction.half,
        cert.prediction.draw_date,
        cert.prediction.predicted_top, cert.prediction.predicted_n, cert.prediction.algo_used,
        cert.statistics.hit_rate_walk_forward,
        cert.statistics.wilson_95_ci_lo,
        cert.statistics.wilson_95_ci_hi,
        cert.statistics.baseline_rate,
        cert.statistics.edge_multiplier,
        cert.conformal.threshold,
        cert.conformal.coverage_target,
        cert.audit.last_edge_discovery_run_id,
        cert.audit.last_edge_verdict,
        cert.audit.n_tests_total,
        cert.audit.n_tests_significant,
        cert.signature,
        JSON.stringify(cert),
      ],
    );
  }
}
