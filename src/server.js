import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { env } from './config/env.js';
import routes from './routes/index.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { mornoJob } from './jobs/morno.job.js';
import { seedIfEmpty } from './models/automation_stage.model.js';
import { query } from './config/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(join(__dirname, '../public')));

app.use('/', routes);

app.use(notFound);
app.use(errorHandler);

app.listen(env.port, () => {
  console.log(`[server] Vila Mundaí CRM rodando na porta ${env.port}`);
  console.log(`[server] modelo Claude: ${env.anthropic.model}`);

  // Garante tabela e seed de prompts por etapa
  seedIfEmpty().catch(err => console.error('[server] seed stages falhou:', err.message));

  // Adiciona colunas de rastreamento de custo (idempotente)
  Promise.all([
    query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS total_tokens_input  INTEGER     DEFAULT 0`),
    query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS total_tokens_output INTEGER     DEFAULT 0`),
    query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS total_custo_brl     NUMERIC(10,4) DEFAULT 0`),
    query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS condicoes_pagamento JSONB DEFAULT '{}'`),
    query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS cpf TEXT`),
    query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS data_nascimento TEXT`),
    query(`CREATE TABLE IF NOT EXISTS fotos (
      id         BIGSERIAL PRIMARY KEY,
      tipo_apto  TEXT,
      descricao  TEXT,
      url        TEXT NOT NULL,
      public_id  TEXT UNIQUE NOT NULL,
      ordem      INTEGER,
      created_at TIMESTAMPTZ DEFAULT now()
    )`),
    query(`ALTER TABLE fotos ADD COLUMN IF NOT EXISTS ordem INTEGER`),
    // Painel de Atendimentos: não-lidas + resumo da conversa (visão do robô)
    // Vincula conversas órfãs ao lead do mesmo telefone (idempotente).
    query(`UPDATE conversations c SET lead_id = l.id
             FROM leads l WHERE l.phone = c.phone AND c.lead_id IS NULL AND c.status = 'aberta'`),
    query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ`),
    query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS resumo TEXT`),
    query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS resumo_at TIMESTAMPTZ`),
    query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS resumo_msgs INTEGER`),
    query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS conversao TEXT`),
    query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS conversao_pct INTEGER`),
    // Identidade WhatsApp: mapeia o "@lid" (identificador de privacidade) ao
    // telefone real, para a mesma pessoa não virar dois contatos.
    query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS lid TEXT`),
    query(`CREATE INDEX IF NOT EXISTS idx_leads_lid ON leads(lid)`),
    // ===== BASE DE APRENDIZADO (Gerente Max) =====
    // Rascunho de prompt por etapa: o Simulador testa o draft sem tocar produção.
    query(`ALTER TABLE automations_stages ADD COLUMN IF NOT EXISTS prompt_draft TEXT`),
    // Histórico de versões de prompt (auto-backup a cada alteração).
    query(`CREATE TABLE IF NOT EXISTS prompt_revisions (
      id          BIGSERIAL PRIMARY KEY,
      stage       TEXT NOT NULL,
      prompt_body TEXT NOT NULL,
      origem      TEXT DEFAULT 'edicao',   -- edicao | promocao_draft | restauracao
      created_at  TIMESTAMPTZ DEFAULT now()
    )`),
    // Sessões do Simulador (sandbox): lead virtual + histórico + relatório.
    query(`CREATE TABLE IF NOT EXISTS simulacoes (
      id          BIGSERIAL PRIMARY KEY,
      nome        TEXT,
      usar_draft  BOOLEAN DEFAULT FALSE,
      lead_json   JSONB DEFAULT '{}',      -- lead virtual (stage, datas, tags...)
      messages_json JSONB DEFAULT '[]',    -- histórico formato Claude (com tool_use)
      transcript  JSONB DEFAULT '[]',      -- visão humana (lead/agente/tools/etapa)
      relatorio   JSONB,                   -- saída do avaliador
      status      TEXT DEFAULT 'ativa',    -- ativa | avaliada | arquivada
      created_at  TIMESTAMPTZ DEFAULT now(),
      updated_at  TIMESTAMPTZ DEFAULT now()
    )`),
    // Insights do Analisador Passivo (Camada 2).
    query(`CREATE TABLE IF NOT EXISTS insights (
      id         BIGSERIAL PRIMARY KEY,
      padrao     TEXT,
      evidencia  TEXT,
      sugestao   TEXT,
      status     TEXT DEFAULT 'novo',      -- novo | aprovado | descartado
      created_at TIMESTAMPTZ DEFAULT now()
    )`),
    // Ator-lead: perfil (transcript de conversa real) que a IA-lead imita.
    query(`ALTER TABLE simulacoes ADD COLUMN IF NOT EXISTS perfil JSONB`),
    // Insights aplicáveis: etapa alvo, origem e camada (roteamento C1-C4).
    query(`ALTER TABLE insights ADD COLUMN IF NOT EXISTS etapa TEXT`),
    query(`ALTER TABLE insights ADD COLUMN IF NOT EXISTS origem TEXT`),
    query(`ALTER TABLE insights ADD COLUMN IF NOT EXISTS camada TEXT`),
    // Laboratório: camadas do comportamento do Atendente Max (C1-C4 editáveis).
    // chaves: c1_identidade, c2_fatos, c3_regras, c3_regras_draft, c4_<stage>
    query(`CREATE TABLE IF NOT EXISTS lab_camadas (
      chave      TEXT PRIMARY KEY,
      conteudo   TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT now()
    )`),
    // Intervenções do Gerente Ativo (Camada 3).
    query(`CREATE TABLE IF NOT EXISTS intervencoes (
      id              BIGSERIAL PRIMARY KEY,
      conversation_id BIGINT,
      detectado       TEXT,
      sugerido        TEXT,
      aprovado        BOOLEAN,
      resultado       TEXT,
      created_at      TIMESTAMPTZ DEFAULT now()
    )`),
  ]).catch(err => console.error('[server] migrate falhou:', err.message));

  // Job de morno DESATIVADO por ora: morno é só um estágio passivo de
  // estacionamento (IA desligada), sem mover leads automaticamente nem
  // reaquecer. Para religar o auto-movimento quente->morno, reative abaixo.
  void mornoJob; // mantém o import; job pausado intencionalmente
  // mornoJob();
  // setInterval(mornoJob, 60 * 60 * 1000);
  console.log('[server] morno.job PAUSADO (morno é estágio passivo)');
});
