import { handleIncoming, persistOutboundHuman } from '../services/agent.service.js';
import * as Lead from '../models/lead.model.js';
import { query } from '../config/db.js';

// Registro em memória dos últimos webhooks recebidos (diagnóstico de conexão:
// ver se o clique do anúncio / a mensagem do lead chega até o servidor).
// Volátil (some em redeploy) — serve para depurar em tempo real.
const _hits = [];
function logHit(h) {
  _hits.unshift({ ts: new Date().toISOString(), ...h });
  if (_hits.length > 40) _hits.pop();
}
export function webhookLog(req, res) {
  res.json({ total: _hits.length, hits: _hits });
}

// Resolve a identidade do remetente. O WhatsApp às vezes entrega o contato
// como "@lid" (identificador de privacidade) em vez do número. Mapeamos o LID
// ao telefone real (guardado no lead) para a mesma pessoa não virar 2 contatos.
async function resolverContato(body) {
  const rawPhone = body.phone || body.participantPhone || null;
  // chatLid é o identificador mais estável segundo a doc da Z-API.
  const senderLid = body.chatLid || body.senderLid || body.participantLid || null;
  const lidNum = String(senderLid || (String(rawPhone).includes('@') ? rawPhone : '')).replace(/\D/g, '') || null;
  let phone = rawPhone;
  if (rawPhone && String(rawPhone).includes('@')) {
    console.warn('[webhook] phone veio como @lid:', JSON.stringify(body).slice(0, 900));
    if (lidNum) {
      const known = await Lead.findByLid(lidNum);
      if (known) {
        console.log(`[webhook] @lid ${lidNum} resolvido para ${known.phone} (lead ${known.id})`);
        phone = known.phone;
      } else {
        console.warn(`[webhook] @lid ${lidNum} sem mapeamento ainda — contato provisório`);
      }
    }
  }
  return { phone, lid: lidNum };
}

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

    // Resolve telefone real + LID (trata o caso "@lid").
    const { phone, lid } = await resolverContato(body);

    // Extrai o texto (Z-API: text.message). Outros tipos podemos tratar depois.
    const text =
      body.text?.message ||
      body.message?.text ||
      body.body ||
      null;

    // Registra o hit (diagnóstico): toda mensagem que chega aparece aqui.
    logHit({ tipo: 'whatsapp', phone: phone || body.phone || '?', fromMe: !!body.fromMe, texto: (text || '(sem texto)').slice(0, 80) });

    if (!phone) return;

    if (!text) {
      // Mídia/áudio/etc. — opcionalmente avise o time. Por ora, ignora.
      console.log('[webhook] mensagem sem texto, ignorada.');
      return;
    }

    // Mensagens que saíram do nosso número (app do celular, IA ou CRM):
    // grava como atendimento humano para aparecer no painel, sem reprocessar
    // pela IA. A deduplicação evita duplicar ecos da IA/CRM.
    if (body.fromMe) {
      await persistOutboundHuman({ phone, text });
      return;
    }

    const pushName = body.senderName || body.chatName || null;
    await handleIncoming({ phone, text, pushName, lid });
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

  logHit({ tipo: 'meta-leads', phone: body.phone_number || body.telefone || '?', nome: body.nome_completo || body.full_name || '?', campos: Object.keys(body).length });

  if (!body.phone_number) {
    return res.status(400).json({ ok: false, error: 'phone_number obrigatório' });
  }

  try {
    // Aceita tanto o formato do Sheets (telefone/nome_completo) quanto o padrão Meta
    const phoneRaw = body.telefone || body.phone_number || '';
    let phone = String(phoneRaw).replace(/\D/g, '');
    if (!phone.startsWith('55')) phone = '55' + phone;
    if (phone.length < 12) {
      console.warn('[meta-lead] telefone inválido após limpeza:', phoneRaw, '→', phone);
      return res.status(400).json({ ok: false, error: `telefone inválido: "${phoneRaw}"` });
    }

    const nome     = body.nome_completo || body.full_name  || null;
    const email    = body.email         || null;
    const campanha = body.campaign_name || '';
    const anuncio  = body.ad_name       || '';

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

    // Guarda dados de rastreamento no campo extra
    const extra = {};
    if (campanha)            extra.campaign_name = campanha;
    if (body.campaign_id)    extra.campaign_id   = body.campaign_id;
    if (anuncio)             extra.ad_name       = anuncio;
    if (body.ad_id)          extra.ad_id         = body.ad_id;
    if (body.adset_name)     extra.adset_name    = body.adset_name;
    if (body.form_name)      extra.form_name     = body.form_name;
    if (body.platform)       extra.platform      = body.platform;

    // Upsert: cria ou atualiza, mesclando tags sem duplicar
    const { rows } = await query(
      `INSERT INTO leads (phone, nome, email, origem, tags, checkin, checkout, guests, extra)
       VALUES ($1, $2, $3, 'meta_ads', $4, $5, $6, $7, $8)
       ON CONFLICT (phone) DO UPDATE SET
         nome     = COALESCE(EXCLUDED.nome,     leads.nome),
         email    = COALESCE(EXCLUDED.email,    leads.email),
         origem   = 'meta_ads',
         tags     = (SELECT array_agg(DISTINCT t) FROM unnest(leads.tags || EXCLUDED.tags) t),
         extra    = leads.extra || EXCLUDED.extra,
         checkin  = COALESCE(EXCLUDED.checkin,  leads.checkin),
         checkout = COALESCE(EXCLUDED.checkout, leads.checkout),
         guests   = COALESCE(EXCLUDED.guests,   leads.guests),
         updated_at = now()
       RETURNING id`,
      [phone, nome, email, tags, checkin, checkout, guests, JSON.stringify(extra)]
    );

    const lead_id = rows[0].id;
    console.log(`[meta-lead] ${nome} ${phone} "${campanha}"`);
    res.json({ ok: true, lead_id });
  } catch (e) {
    console.error('[meta-lead] erro:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
}
