import { promises as fs } from 'fs';
import * as Lead from '../models/lead.model.js';
import { zapi } from '../services/zapi.service.js';
import { gerarContratoPdf, uploadPdf, limparWorkDir } from '../services/contrato.service.js';

// Mensagem que acompanha o contrato. Personalizada com o primeiro nome do lead.
function msgContrato(nome) {
  const primeiro = (nome || '').trim().split(/\s+/)[0] || '';
  return `${primeiro ? primeiro + ', ' : ''}segue contrato elaborado, por gentileza confirme os dados, me confirme que está tudo ok.`;
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
