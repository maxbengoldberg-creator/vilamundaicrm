import { query } from '../config/db.js';

const LIMITE_H = 48;

export async function mornoJob() {
  try {
    const cutoff = new Date(Date.now() - LIMITE_H * 60 * 60 * 1000);

    // Leads quentes: busca a mensagem mais recente em qualquer conversa do lead.
    // Se não houver mensagens ou a última for mais antiga que LIMITE_H horas, move para morno.
    const { rows: leads } = await query(`
      SELECT l.id, l.phone, l.nome, MAX(m.created_at) AS ultima_msg
        FROM leads l
        LEFT JOIN conversations c ON c.lead_id = l.id
        LEFT JOIN messages m ON m.conversation_id = c.id
       WHERE l.stage = 'quente'
       GROUP BY l.id, l.phone, l.nome
    `);

    for (const lead of leads) {
      const ultima = lead.ultima_msg ? new Date(lead.ultima_msg) : null;
      if (!ultima || ultima < cutoff) {
        await query(
          `UPDATE leads SET stage = 'morno', updated_at = now() WHERE id = $1`,
          [lead.id]
        );
        console.log(
          `[morno.job] lead ${lead.id} (${lead.nome || lead.phone}) → morno` +
          ` | última msg: ${ultima ? ultima.toISOString() : 'nunca'}`
        );
      }
    }
  } catch (err) {
    console.error('[morno.job] erro:', err.message);
  }
}
