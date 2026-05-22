# 📜 HELIX · Disclosure Honesto

**Última actualización**: 2026-05-22 · Commit referenciable: ver git log

## 1. Lo que HELIX SÍ hace

HELIX es una plataforma de **transparencia matemática del juego de lotería**.

- ✅ Ejecuta 21+ algoritmos estadísticos sobre 5+ años de sorteos reales de Florida
- ✅ Calcula hit rates históricos con Wilson 95% Confidence Intervals
- ✅ Aplica corrección Bonferroni para comparaciones múltiples (rigor académico)
- ✅ Emite Truth Certificates HMAC-SHA256 verificables públicamente
- ✅ Walk-forward retrospective SIN future leakage
- ✅ Replica fielmente las estrategias del bot Ballbot para comparación auditable
- ✅ Reporta resultados honestos — incluyendo cuando NO hay edge

## 2. Lo que HELIX NO promete

- ❌ NO predice ganadores de lotería
- ❌ NO promete edge sostenido sobre el azar
- ❌ NO garantiza ROI positivo
- ❌ NO es asesoramiento financiero

## 3. Realidad estadística verificable

Sobre 422 tests rigurosos × 13 familias de hipótesis × 11,000+ predicciones walk-forward:

```
Wilson 95% Confidence Interval del consensus HELIX:
  Hit rate @ top-15 = 14.9% — 16.0%
  Baseline aleatorio = 15.0%
  Edge demostrado    = NO (CI incluye baseline)
```

**El sistema es estadísticamente indistinguible del azar** en las dimensiones medidas con la corrección apropiada por múltiples comparaciones (α=0.05/n).

## 4. ROI esperado de jugar

Con payout 50:1 (Florida pick3 box typical):

| Estrategia | Hit rate | Ticket cost | Expected return | ROI |
|-----------|----------|-------------|------------------|-----|
| Top 15 pares aleatorios | 15.0% | $15 | $7.50 | **-50%** |
| Top 15 vía HELIX | 14.9-16.0% | $15 | $7.45-$8.00 | **-47% a -49%** |
| Top 25 vía HELIX | 24.6-26.6% | $25 | $12.30-$13.30 | **-47% a -51%** |

**Jugar a la lotería es entretenimiento, NO inversión.** Toda estrategia produce pérdida esperada en el largo plazo.

## 5. Truth Certificates — qué garantizan

Un Truth Certificate `TC-YYYY-MM-DD-XXXXXXXX` firmado por HELIX garantiza:

- **Autenticidad**: HMAC-SHA256 verificable offline contra clave pública
- **Integridad**: payload canónico (JSON con keys ordenadas) inmutable
- **Auditabilidad**: cada cert referencia un `edge_discovery_run_id`
- **Disclosure**: incluye `edge_demonstrated: false` cuando aplica

NO garantizan:
- Que la predicción acierte
- Que jugar genere ganancia
- Edge sobre el azar

## 6. Uso recomendado

HELIX es útil para:

- **Entretenimiento con consciencia**: jugar sabiendo las probabilidades reales
- **Auditoría regulatoria**: reportar estadísticas honestas a entidades de control
- **Investigación académica**: dataset y metodología reproducibles
- **Compliance corporativo**: pool operators demostrando transparencia a clientes
- **Educación financiera**: visualizar conceptos de probabilidad y CI

NO use HELIX para:

- Apostar dinero que no pueda permitirse perder
- Tomar decisiones de inversión
- Reemplazar asesoría financiera profesional

## 7. Audit trail público

Todo análisis HELIX está sujeto a re-ejecución verificable:

```
POST /api/agent/edge-discovery/run    → ejecuta 187 tests con Bonferroni
GET  /api/public/certificate/:id      → descarga cert sin auth
POST /api/public/certificate/:id/verify → verifica HMAC sin auth
GET  /api/agent/retrospective/helix-v2/summary → walk-forward por combo
```

Cualquier afirmación estadística en HELIX debe respaldarse con `run_id` reproducible.

## 8. Limitaciones conocidas

- Datos: solo Florida Pick3 / Pick4 (otros estados requieren backfill)
- Algoritmos: 21 canónicos + 4 mirror-only (no incluyen ML / neural networks)
- Predicción: limitada a top-N pares en ventana de un sorteo
- Cobertura conformal: garantía teórica del 80%, sujeta a exchangeability

## 9. Contacto

Para preguntas sobre metodología, datos, o solicitudes de re-ejecución:
- Email: yanielrodriguezmorales@gmail.com
- Empresa: Bliss Systems LLC

---

*Este documento es parte del contrato implícito con cualquier usuario de HELIX. La transparencia matemática es nuestra responsabilidad fiduciaria.*
