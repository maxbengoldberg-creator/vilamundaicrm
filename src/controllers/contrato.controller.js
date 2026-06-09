import { promises as fs } from 'fs';
import * as Lead from '../models/lead.model.js';
import { zapi } from '../services/zapi.service.js';
import { hospedin } from '../services/hospedin.service.js';
import { gerarContratoPdf, uploadPdf, limparWorkDir } from '../services/contrato.service.js';

// DIAGNÓSTICO TEMPORÁRIO — tenta criar uma reserva de teste e devolve o erro real do PMS.
export async function diagReserva(req, res) {
  const r = await hospedin.criarReserva({
    nome: 'Teste Diagnostico',
    checkin: '2026-07-02',
    checkout: '2026-07-05',
    guests: 2,
    place_type_id: 178135,
    diaria: 290,
  });
  res.json(r);
}

const MSG_CONTRATO =
  'Segue contrato em anexo, leia por gentileza, confira se os dados estão corretos e assine pelo Gov.br, em seguida envie de volta para a nossa assinatura.';

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
    await zapi.sendText(lead.phone, MSG_CONTRATO);

    res.json({ ok: true, url, enviado_para: lead.phone });
  } catch (e) {
    console.error('[contrato] enviarContrato erro:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    await limparWorkDir(workDir);
  }
}
