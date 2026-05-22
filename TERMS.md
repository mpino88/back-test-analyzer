# ⚖️ Términos de Uso · HELIX

**Última revisión**: 2026-05-22

## 1. Naturaleza del servicio

HELIX (operado por Bliss Systems LLC) es una plataforma de **análisis estadístico y transparencia matemática** del juego de lotería. NO es:

- Un servicio de predicción de ganadores
- Un asesor financiero o de inversiones
- Un operador de loterías o juegos de azar

## 2. No se promete edge

Al usar HELIX usted reconoce que:

- **El sistema NO supera al azar de manera demostrable** en las dimensiones medidas
- Wilson 95% CI del consensus walk-forward INCLUYE el baseline aleatorio
- Toda estrategia produce **pérdida esperada negativa** en el largo plazo con payouts de lotería típicos
- Los Truth Certificates garantizan autenticidad de los datos, NO acierto de la predicción

## 3. Responsabilidad del usuario

El usuario acepta total responsabilidad por:

- Cualquier dinero apostado basado en información de HELIX
- Verificar de forma independiente las estadísticas reportadas vía endpoints públicos
- Cumplir con leyes locales sobre juegos de azar en su jurisdicción
- Reconocer que el juego compulsivo es un riesgo real

## 4. Limitaciones de responsabilidad

Bliss Systems LLC NO se hace responsable por:

- Pérdidas financieras derivadas del uso de HELIX
- Interpretaciones erróneas de los datos reportados
- Decisiones de juego del usuario
- Cambios en regulaciones locales sobre juegos de azar

## 5. Verificación pública

Cualquier afirmación estadística de HELIX puede verificarse vía:

```
https://dash.ballbot.tel/verify?id=TC-XXXX-XX-XX-XXXXXXXX
```

Si encuentra una afirmación NO verificable, repórtelo a yanielrodriguezmorales@gmail.com y será corregida públicamente.

## 6. Privacidad

HELIX no recopila datos personales más allá de:

- API key (para acceso autenticado a endpoints `/api/agent/*`)
- User ID externo (para vincular certs vía `/api/alliance/ballbot/predict`)
- IP de request (logs operativos, retenidos máx 30 días)

NO se recopila:

- Datos financieros
- Información de tarjetas
- Historial de juego personal

## 7. Servicios pagos (cuando aplique)

Los tiers pagos (Basic / Pro / Audit / Compliance) ofrecen:

- Acceso a certs ilimitados sin watermark
- API endpoints elevados
- Reportes de compliance regulatorio
- Edge Discovery on-demand

NO ofrecen mejor predicción — solo mejor herramienta de análisis y transparencia.

## 8. Juego responsable

Si el juego está afectando su vida financiera, emocional o social, contacte:

- **EE.UU.**: National Council on Problem Gambling — 1-800-522-4700
- **Puerto Rico**: Línea PAS — 1-800-981-0023

HELIX se reserva el derecho de NO procesar requests si detecta patrones de uso problemático.

## 9. Modificaciones

Estos términos pueden actualizarse. Cambios materiales serán comunicados vía:

- Banner en `/agent/dashboard`
- Email a usuarios pagos
- Commit visible en repositorio público

## 10. Jurisdicción

Operado bajo leyes de Puerto Rico, EE.UU. Disputas serán resueltas vía arbitraje en San Juan, PR.

---

*Al usar HELIX usted acepta estos términos y reconoce su carácter informativo, no transactional. El sistema entrega transparencia matemática; las decisiones financieras son enteramente responsabilidad del usuario.*
