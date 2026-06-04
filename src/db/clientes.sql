CREATE TABLE IF NOT EXISTS clientes (
  id SERIAL PRIMARY KEY,
  pms_reservation_id BIGINT UNIQUE,
  pms_guest_id BIGINT,
  nome TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  canal TEXT,
  qualificacao TEXT,
  check_in DATE,
  check_out DATE,
  noites INTEGER,
  pessoas INTEGER,
  receita_cents BIGINT DEFAULT 0,
  acomodacao TEXT,
  status_reserva TEXT,
  boas_vindas_enviada BOOLEAN DEFAULT false,
  auto_boas_vindas BOOLEAN DEFAULT false,
  ai_enabled BOOLEAN DEFAULT true,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_clientes_checkin ON clientes(check_in);
CREATE INDEX IF NOT EXISTS idx_clientes_phone ON clientes(phone);
