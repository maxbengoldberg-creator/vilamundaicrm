-- ==========================================================
--  Schema do Vila Mundaí CRM
-- ==========================================================

CREATE TABLE IF NOT EXISTS leads (
  id            BIGSERIAL PRIMARY KEY,
  nome          TEXT,
  phone         TEXT UNIQUE NOT NULL,         -- E.164 sem "+", ex: 5573999990000
  email         TEXT,
  origem        TEXT DEFAULT 'whatsapp',
  stage         TEXT DEFAULT 'qualif',        -- qualif | apres | quente | reserva | ganho | perdido
  qual_score    INT  DEFAULT 0,               -- 0..100
  tags          TEXT[] DEFAULT '{}',
  -- dados extraídos pela IA da conversa:
  checkin       DATE,
  checkout      DATE,
  guests        INT,
  acomodacao    TEXT,
  valor_cotado  NUMERIC(12,2),
  -- controle de atendimento:
  ai_enabled    BOOLEAN DEFAULT TRUE,         -- false = humano assumiu
  assigned_to   TEXT,                         -- id/nome do atendente humano
  extra         JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id            BIGSERIAL PRIMARY KEY,
  lead_id       BIGINT REFERENCES leads(id) ON DELETE CASCADE,
  phone         TEXT NOT NULL,
  status        TEXT DEFAULT 'aberta',        -- aberta | finalizada
  last_message  TEXT,
  last_at       TIMESTAMPTZ DEFAULT now(),
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conv_phone ON conversations(phone);

-- Histórico salvo para o agente dar continuidade de onde parou.
CREATE TABLE IF NOT EXISTS messages (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,              -- user | assistant | system | tool
  content         TEXT,                       -- texto exibível
  raw             JSONB,                      -- bloco bruto (tool_use/tool_result) p/ reconstruir o contexto
  sender          TEXT DEFAULT 'lead',        -- lead | ia | humano
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS automations (
  id          BIGSERIAL PRIMARY KEY,
  nome        TEXT NOT NULL,
  descricao   TEXT,
  enabled     BOOLEAN DEFAULT FALSE,
  -- fluxo gerado pelo construtor / pela Claude (nós, condições, ações):
  flow        JSONB DEFAULT '[]',
  prompt      TEXT,                            -- prompt original que gerou o fluxo
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Cache local de reservas criadas no PMS (para auditoria).
CREATE TABLE IF NOT EXISTS reservations (
  id            BIGSERIAL PRIMARY KEY,
  lead_id       BIGINT REFERENCES leads(id) ON DELETE SET NULL,
  pms_id        TEXT,                          -- id retornado pelo Hospedin
  checkin       DATE,
  checkout      DATE,
  guests        INT,
  acomodacao    TEXT,
  valor         NUMERIC(12,2),
  status        TEXT DEFAULT 'pendente',       -- pendente | confirmada | cancelada
  payload       JSONB,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Configurações gerais (régua de automação, system prompt, etc.)
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  JSONB
);
