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
  // Aceita AAAA-MM-DD, ISO ou objeto Date (o Postgres devolve colunas date como
  // Date — sem este tratamento virava "Mon Jul 27 2026 ... GMT" no contrato).
  // Devolve sempre DD/MM/AAAA. Vazio vira "____".
  if (!valor) return '____';
  if (valor instanceof Date && !Number.isNaN(valor.getTime())) {
    const d = String(valor.getUTCDate()).padStart(2, '0');
    const mes = String(valor.getUTCMonth() + 1).padStart(2, '0');
    return `${d}/${mes}/${valor.getUTCFullYear()}`;
  }
  const s = String(valor).slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return String(valor);
}

// CPF no padrão 035.342.715-21. Aceita com ou sem pontuação; se não tiver 11
// dígitos, devolve o que veio (não inventa).
function cpfBR(valor) {
  if (!valor) return '____';
  const d = String(valor).replace(/\D/g, '');
  if (d.length !== 11) return String(valor);
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
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

// Quais tipos a reserva contempla. Por enquanto a ficha guarda UMA acomodação;
// se um dia descrever os dois ("1 e 2 quartos"), ambos entram.
function tiposApartamento(acomodacao) {
  const s = String(acomodacao || '');
  const dois = /2\s*quart|dois\s*quart/i.test(s);
  const um = /1\s*quart|um\s*quart/i.test(s);
  // Sem acomodação reconhecível: assume 1 quarto (caso mais comum) para não
  // deixar o contrato sem descrição.
  if (!dois && !um) return { inc_1q: true, inc_2q: false };
  return { inc_1q: um, inc_2q: dois };
}

// "1 Quarto - Superior" / "2 Quartos - Térreo" → "01 apartamento de 1 quarto".
// Se a reserva contemplar os dois tipos, descreve ambos.
function descreverApartamentos(acomodacao) {
  const { inc_1q, inc_2q } = tiposApartamento(acomodacao);
  const partes = [];
  if (inc_1q) partes.push('01 apartamento de 1 quarto');
  if (inc_2q) partes.push('01 apartamento de 2 quartos');
  return partes.length ? partes.join(' e ') : '____';
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
  const tipos = tiposApartamento(lead.acomodacao);

  return {
    nome: lead.nome || '____',
    cpf: cpfBR(lead.cpf),
    data_nascimento: dataBR(lead.data_nascimento),
    checkin: dataBR(lead.checkin),
    checkout: dataBR(lead.checkout),
    quantidade_dias: n != null ? String(n) : '____',
    quantidade_pessoas: lead.guests != null ? String(lead.guests) : '____',
    apartamentos: descreverApartamentos(lead.acomodacao),
    inc_1q: tipos.inc_1q,
    inc_2q: tipos.inc_2q,
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
// O public_id TERMINA em .pdf: sem a extensão na URL, a Z-API/WhatsApp não
// reconhece o documento e a mensagem chega sem o anexo.
export async function uploadPdf(pdfPath, lead) {
  const publicId = `contratos/contrato-lead-${lead.id}.pdf`;
  const res = await cloudinary.uploader.upload(pdfPath, {
    resource_type: 'raw',
    public_id: publicId,
    overwrite: true,
    invalidate: true,
  });
  return res.secure_url;
}
