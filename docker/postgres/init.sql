-- Script de inicialización del contenedor PostgreSQL
-- Se ejecuta automáticamente la primera vez que arranca el contenedor

-- Habilitar extensiones necesarias
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- El schema hitdash lo crea el migration runner (npm run migrate)
-- Este archivo solo prepara las extensiones base
