import { handleIncoming } from '../services/agent.service.js';
import { query } from '../config/db.js';

// ==========================================================
//  Webhook do Z-API. Configure na Z-API (Webhooks > "Ao receber")
//  a URL:  https://SEU-APP.up.railway.app/webhooks/whatsapp
//
//  O payload do Z-API varia conforme o evento. Tratamos mensagens
//  de texto recebidas e ignoramos as enviadas por nós (fromMe).
// ==========================================================
export async function whatsappWebhook(req, res) {
  // Responde rápido para a Z-API não reenviar; processa em background.
  res.status(200).json({ received: true });

  try {
    const body = req.body || {};

    // Ignora mensagens que nós mesmos enviamos.
    if (body.fromMe) return;

    // Telefone do contato (Z-API manda em "phone").
    const phone = body.phone || body.participantPhone;
    if (!phone) return;

    const pushName = body.senderName || body.chatName || null;

    // Extrai o texto (Z-API: text.message). Outros tipos podemos tratar depois.
    const text =
      body.text?.message ||
      body.message?.text ||
      body.body ||
      null;

    if (!text) {
      // Mídia/áudio/etc. — opcionalmente avise o time. Por ora, ignora.
      console.log('[webhook] mensagem sem texto, ignorada.');
      return;
    }

    await handleIncoming({ phone, text, pushName });
  } catch (e) {
    console.error('[webhook] erro ao processar:', e.message);
  }
}

// ==========================================================
//  Webhook Meta Ads → Google Sheets → CRM
//  URL pública: POST /webhooks/meta-leads (sem x-api-key)
// ==========================================================
export async function metaLeadsWebhook(req, res) {
  const body = req.body || {};

  if (!body.phone_number) {
    return res.status(400).json({ ok: false, error: 'phone_number obrigatório' });
  }

  try {
    // Limpa o telefone: remove "p:+", caracteres não numéricos, garante prefixo 55
    let phone = String(body.phone_number).replace(/\D/g, '');
    if (!phone.startsWith('55')) phone = '55' + phone;

    const nome     = body.full_name  || null;
    const email    = body.email      || null;
    const campanha = body.campaign_name || '';
    const anuncio  = body.ad_name      || '';

    // Converte datas de dd/mm/yyyy para yyyy-mm-dd
    function parseDate(str) {
      if (!str) return null;
      const p = String(str).trim().split('/');
      if (p.length !== 3) return null;
      return `${p[2]}-${p[1].padStart(2,'0')}-${p[0].padStart(2,'0')}`;
    }

    const checkin  = parseDate(body['data_de_check-in_(ex:_10/10/2026)']);
    const checkout = parseDate(body['data_de_check-out_(ex:_10/10/2026)']);
    const guestsRaw = body['quantidade_de_pessoas_*número'];
    const guests   = guestsRaw ? (parseInt(guestsRaw, 10) || null) : null;
    const tags     = [campanha, anuncio].filter(Boolean);

    // Upsert: cria ou atualiza, mesclando tags sem duplicar
    const { rows } = await query(
      `INSERT INTO leads (phone, nome, email, origem, tags, checkin, checkout, guests)
       VALUES ($1, $2, $3, 'meta_ads', $4, $5, $6, $7)
       ON CONFLICT (phone) DO UPDATE SET
         nome     = COALESCE(EXCLUDED.nome,     leads.nome),
         email    = COALESCE(EXCLUDED.email,    leads.email),
         tags     = (SELECT array_agg(DISTINCT t) FROM unnest(leads.tags || EXCLUDED.tags) t),
         checkin  = COALESCE(EXCLUDED.checkin,  leads.checkin),
         checkout = COALESCE(EXCLUDED.checkout, leads.checkout),
         guests   = COALESCE(EXCLUDED.guests,   leads.guests),
         updated_at = now()
       RETURNING id`,
      [phone, nome, email, tags, checkin, checkout, guests]
    );

    const lead_id = rows[0].id;
    console.log(`[meta-lead] ${nome} ${phone} "${campanha}"`);
    res.json({ ok: true, lead_id });
  } catch (e) {
    console.error('[meta-lead] erro:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
}
