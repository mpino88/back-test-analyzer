# 🧪 Labs · Sports Vertical

**Status**: SKELETON · No funcional · Activación tentativa Q3 2026

## Propósito

Aplicar el stack HELIX (Bayesian + Conformal + Edge Discovery + Walk-forward + Truth Certificates) al dominio de sports betting líneas, donde el edge ESTÁ publicado académicamente:

- **Closing Line Value (CLV)** — línea inicial vs línea de cierre
- **Reverse line movement** — sharp money vs public money divergence
- **Hawkes self-exciting** sobre movimiento de líneas (Hawkes & Almeida 2018)
- **Late lines** — overreaction a injuries / weather news

## Arquitectura (cuando se active)

```
src/agent/labs/sports/
├── ingestion/
│   ├── PinnacleAdapter.ts       ← Líneas de cierre referenciales
│   ├── DraftKingsAdapter.ts     ← Líneas públicas (NA market)
│   └── OddsAPIAdapter.ts        ← Aggregator multi-book
├── services/
│   ├── SportsPredictor.ts       ← implements PredictorProtocol
│   ├── CLVAnalyzer.ts           ← Closing Line Value tracker
│   ├── ReverseLineMovementDetector.ts
│   └── LineMovementHawkesAnalyzer.ts
├── analysis/
│   └── SportsEdgeDiscovery.ts   ← Extension de EdgeDiscoveryEngine
└── db/migrations/
    ├── XXX_sports_lines.sql
    └── XXX_sports_outcomes.sql
```

## Foundation reutilizado (sin escribir código nuevo)

Todo el stack actual aplica:

| Servicio HELIX | Uso en Sports |
|----------------|----------------|
| `PredictorProtocol` | `SportsPredictor implements ProtocolProtocol` |
| `EdgeDiscoveryEngine` | Tests Bonferroni-honest sobre features sports |
| `ConformalPredictor` | Coverage guarantee 80% para sets de bets |
| `HelixRetrospectiveSimulator` | Walk-forward season-by-season |
| `TruthCertificateService` | Cert HMAC por cada pick recommended |
| `ThompsonSampler` | Bayesian update por sportsbook/market |
| `PublicVerifyView` | `/verify?id=TC-...` aplica universalmente |

## Roadmap

- **Fase 0** ✅ (hoy): Skeleton, README, placeholder UI admin-only
- **Fase 1**: SportsPredictor + ingestion adapters
- **Fase 2**: Hawkes line movement analyzer + backtest 2024-2026
- **Fase 3**: Edge Discovery extended con features sports
- **Fase 4**: Truth Certificates por pick
- **Fase 5**: B2B pilot con 1 sportsbook white-label

## Activation criterion

Activar este vertical cuando:
1. Opción A (transparencia matemática loto) tiene MRR > $5K
2. O bien: Opción A no escala y necesitamos pivote
