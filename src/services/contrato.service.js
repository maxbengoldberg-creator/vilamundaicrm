import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { promises as fs } from 'fs';
import os from 'os';
import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(__dirname, '../templates/contrato_modelo.docx');
const SCRIPT = join(__dirname, '../scripts/gerar_contrato.py');
const PYTHON = process.env.PYTHON_BIN || 'python3';

// ── Helpers de formatação ────────────────────────────────────────────────────

function dataBR(valor) {
  // Aceita AAAA-MM-DD ou ISO; devolve DD/MM/AAAA. Vazio vira "____".
  if (!valor) return '____';
  const s = String(valor).slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return String(valor);
}

function moedaBR(valor) {
  if (valor === null || valor === undefined || valor === '') return '____';
  const n = Number(valor);
  if (Number.isNaN(n)) return String(valor);
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function noites(checkin, checkout) {
  if (!checkin || !checkout) return null;
  const ci = new Date(checkin), co = new Date(checkout);
  const d = Math.round((co - ci) / (1000 * 60 * 60 * 24));
  return d > 0 ? d : null;
}

// "1 Quarto - Superior" / "2 Quartos - Térreo" → "01 apartamento de 1 quarto"
function descreverApartamentos(acomodacao) {
  if (!acomodacao) return '____';
  const dois = /2\s*quart/i.test(acomodacao);
  return dois ? '01 apartamento de 2 quartos' : '01 apartamento de 1 quarto';
}

const MESES = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];

// ── Monta o contexto a partir da ficha do lead ────────────────────────────────

export function montarContexto(lead) {
  const cond = lead.condicoes_pagamento && typeof lead.condicoes_pagamento === 'object'
    ? lead.condicoes_pagamento : {};

  const total = cond.valor_total != null ? Number(cond.valor_total)
              : lead.valor_cotado != null ? Number(lead.valor_cotado) : null;
  const sinal = cond.valor_sinal != null ? Number(cond.valor_sinal)
              : total != null ? Math.round(total * 0.3 * 100) / 100 : null;
  const residual = (total != null && sinal != null) ? Math.round((total - sinal) * 100) / 100 : null;

  const n = noites(lead.checkin, lead.checkout);
  const hoje = new Date();

  return {
    nome: lead.nome || '____',
    cpf: lead.cpf || '____',
    data_nascimento: dataBR(lead.data_nascimento),
    checkin: dataBR(lead.checkin),
    checkout: dataBR(lead.checkout),
    quantidade_dias: n != null ? String(n) : '____',
    quantidade_pessoas: lead.guests != null ? String(lead.guests) : '____',
    apartamentos: descreverApartamentos(lead.acomodacao),
    valor_total: moedaBR(total),
    valor_sinal: moedaBR(sinal),
    valor_residual: moedaBR(residual),
    data_hoje: String(hoje.getDate()).padStart(2, '0'),
    mes_hoje: MESES[hoje.getMonth()],
    ano_hoje: String(hoje.getFullYear()),
  };
}

// ── Geração do PDF (docxtpl + LibreOffice via script Python) ───────────────────

export async function gerarContratoPdf(lead) {
  const ctx = montarContexto(lead);
  const workDir = await fs.mkdtemp(join(os.tmpdir(), 'contrato_'));
  const ctxPath = join(workDir, 'context.json');
  await fs.writeFile(ctxPath, JSON.stringify(ctx), 'utf-8');

  const resultado = await new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [SCRIPT, TEMPLATE, ctxPath, workDir]);
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('error', reject);
    proc.on('close', code => {
      try {
        const linha = out.trim().split('\n').filter(Boolean).pop() || '{}';
        const json = JSON.parse(linha);
        if (code === 0 && json.ok) resolve(json);
        else reject(new Error(json.erro || err || `script saiu com código ${code}`));
      } catch (e) {
        reject(new Error(`saída inválida do script: ${err || out || e.message}`));
      }
    });
  });

  return { pdfPath: resultado.pdf, workDir, ctx };
}

// Limpa o diretório temporário de trabalho.
export async function limparWorkDir(workDir) {
  if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
}

// Sobe o PDF no Cloudinary e devolve a URL pública (para enviar via Z-API).
export async function uploadPdf(pdfPath, lead) {
  const publicId = `contratos/contrato-lead-${lead.id}`;
  const res = await cloudinary.uploader.upload(pdfPath, {
    resource_type: 'raw',
    public_id: publicId,
    overwrite: true,
  });
  return res.secure_url;
}
