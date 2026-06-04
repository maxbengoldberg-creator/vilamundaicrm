import { pool } from '../config/db.js';

async function seed() {
  console.log('[seed] inserindo automações de exemplo...');
  const autos = [
    ['VM - Qualificação', 'Qualifica o lead e aplica tags', true],
    ['VM - Apresentação', 'Apresenta acomodações com fotos após qualificar', true],
    ['VM - Lead Quente', 'Cota, negocia e envia link de pagamento', false],
    ['Agente Claude', 'Agente de vendas com Claude AI e histórico de conversa', true],
  ];
  for (const [nome, descricao, enabled] of autos) {
    await pool.query(
      `INSERT INTO automations (nome, descricao, enabled) VALUES ($1,$2,$3)`,
      [nome, descricao, enabled]
    );
  }
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('automation_rule', $1)
     ON CONFLICT (key) DO NOTHING`,
    [JSON.stringify({ pct: 75 })]
  );
  console.log('[seed] concluído.');
  await pool.end();
}

seed().catch((e) => { console.error(e.message); process.exit(1); });
