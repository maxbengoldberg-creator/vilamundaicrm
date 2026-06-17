import { promises as fs } from 'fs';
import * as Lead from '../models/lead.model.js';
import * as Message from '../models/message.model.js';
import * as Conversation from '../models/conversation.model.js';
import { zapi } from '../services/zapi.service.js';
import { anthropic } from '../services/claude.service.js';
import { gerarContratoPdf, uploadPdf, limparWorkDir } from '../services/contrato.service.js';

// Mensagem que acompanha o contrato. Personalizada com o primeiro nome do lead.
function msgContrato(nome) {
  const primeiro = (nome || '').trim().split(/\s+/)[0] || '';
  return `${primeiro ? primeiro + ', ' : ''}segue contrato elaborado, por gentileza confirme os dados, me confirme que está tudo ok.`;
}

// POST /api/v1/leads/:id/contrato/preparar — lê a conversa, extrai os dados do
// contrato (nome completo, CPF, nascimento, datas, pessoas, apto, valor) e
// PREENCHE o que falta na ficha do lead. NÃO fala nada com o lead.
export async function prepararContrato(req, res) {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ ok: false, erro: 'lead não encontrado' });

    const conv = (await Conversation.findOpenByLead(lead.id)) || (await Conversation.findOpenByPhone(lead.phone));
    const msgs = conv ? await Message.listForPanel(conv.id) : [];
    const transcript = msgs.slice(-60)
      .map(m => `${m.sender === 'lead' ? 'LEAD' : 'ATENDENTE'}: ${m.content}`).join('\n');
    if (!transcript.trim()) return res.status(400).json({ ok: false, erro: 'sem conversa para ler' });

    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 500,
      system: `Você lê uma conversa de reserva de hospedagem e extrai os dados para o contrato de locação. Responda APENAS com JSON válido, sem markdown, no formato:
{"nome_completo":null,"cpf":null,"data_nascimento":null,"checkin":null,"checkout":null,"guests":null,"acomodacao":null,"valor_total":null}
Regras: use null no que não encontrar na conversa. Datas em AAAA-MM-DD. "guests" é número inteiro. "valor_total" é o total da estadia em reais (número, sem R$). "acomodacao" deve ser exatamente um de: "1 Quarto - Térreo", "1 Quarto - Superior", "2 Quartos - Térreo", "2 Quartos - Superior" (o que o lead fechou); se só souber 1 ou 2 quartos sem o andar, use "1 Quarto - Térreo" ou "2 Quartos - Térreo". "nome_completo" é o nome completo do hóspede.`,
      messages: [{ role: 'user', content: 'CONVERSA:\n' + transcript }],
    });
    const raw = resp.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    let j;
    try { j = JSON.parse(raw.replace(/^```json\s*|```\s*$/g, '').trim()); }
    catch { return res.status(502).json({ ok: false, erro: 'não consegui interpretar os dados da conversa' }); }

    // Preenche só o que falta. Para o nome, prefere o mais completo (contrato
    // precisa do nome completo, não só do primeiro nome).
    const wc = s => String(s || '').trim().split(/\s+/).filter(Boolean).length;
    const patch = {};
    if (j.nome_completo && wc(j.nome_completo) > wc(lead.nome)) patch.nome = String(j.nome_completo).trim();
    if (j.cpf && !lead.cpf) patch.cpf = String(j.cpf).trim();
    if (j.data_nascimento && !lead.data_nascimento) patch.data_nascimento = j.data_nascimento;
    if (j.checkin && !lead.checkin) patch.checkin = j.checkin;
    if (j.checkout && !lead.checkout) patch.checkout = j.checkout;
    if (j.guests && !lead.guests) patch.guests = parseInt(j.guests, 10) || null;
    if (j.acomodacao && !lead.acomodacao) patch.acomodacao = j.acomodacao;
    if (j.valor_total && !lead.valor_cotado) patch.valor_cotado = Number(j.valor_total) || null;
    if (Object.keys(patch).length) await Lead.update(lead.id, patch);

    res.json({ ok: true, preenchido: patch, extraido: j });
  } catch (e) {
    console.error('[contrato] prepararContrato erro:', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
}

// GET /api/v1/leads/:id/contrato — gera e devolve o PDF inline.
export async function verContrato(req, res, next) {
  let workDir;
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ error: 'lead não encontrado' });

    const r = await gerarContratoPdf(lead);
    workDir = r.workDir;
    const pdf = await fs.readFile(r.pdfPath);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="contrato-${lead.id}.pdf"`);
    res.send(pdf);
  } catch (e) {
    console.error('[contrato] verContrato erro:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    await limparWorkDir(workDir);
  }
}

// POST /api/v1/leads/:id/contrato/enviar — gera, sobe no Cloudinary e envia via Z-API.
export async function enviarContrato(req, res, next) {
  let workDir;
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ error: 'lead não encontrado' });
    if (!lead.phone) return res.status(400).json({ error: 'lead sem telefone' });

    const r = await gerarContratoPdf(lead);
    workDir = r.workDir;
    const url = await uploadPdf(r.pdfPath, lead);

    const fileName = `Contrato Vila Mundaí - ${lead.nome || 'lead ' + lead.id}.pdf`;
    await zapi.sendDocument(lead.phone, url, fileName);
    await zapi.sendText(lead.phone, msgContrato(lead.nome));

    // Contrato enviado: move para Assinatura e mantém a IA desligada (a etapa de
    // assinatura é conduzida pela equipe). As próximas etapas ficam para depois.
    await Lead.update(lead.id, { stage: 'assinatura', ai_enabled: false });

    res.json({ ok: true, url, enviado_para: lead.phone, stage: 'assinatura' });
  } catch (e) {
    console.error('[contrato] enviarContrato erro:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    await limparWorkDir(workDir);
  }
}
