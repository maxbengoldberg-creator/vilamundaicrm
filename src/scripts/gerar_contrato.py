#!/usr/bin/env python3
"""
Gera o contrato preenchido a partir do modelo .docx e converte para PDF.

Uso:
  python3 gerar_contrato.py <template.docx> <context.json> <output_dir>

Imprime no stdout uma linha JSON: {"ok": true, "pdf": "<caminho>", "docx": "<caminho>"}
ou {"ok": false, "erro": "..."} em caso de falha.
"""
import sys
import os
import json
import shutil
import subprocess
import tempfile

from docxtpl import DocxTemplate


def converter_para_pdf(docx_path, out_dir):
    """Converte um .docx para PDF usando o LibreOffice headless."""
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        raise RuntimeError("LibreOffice (soffice) não encontrado no PATH.")

    # Perfil isolado para evitar conflito entre execuções concorrentes
    profile = tempfile.mkdtemp(prefix="lo_profile_")
    try:
        cmd = [
            soffice,
            "--headless",
            "--norestore",
            "--nolockcheck",
            f"-env:UserInstallation=file://{profile}",
            "--convert-to", "pdf",
            "--outdir", out_dir,
            docx_path,
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if res.returncode != 0:
            raise RuntimeError(f"LibreOffice falhou: {res.stderr or res.stdout}")
    finally:
        shutil.rmtree(profile, ignore_errors=True)

    base = os.path.splitext(os.path.basename(docx_path))[0]
    pdf_path = os.path.join(out_dir, base + ".pdf")
    if not os.path.exists(pdf_path):
        raise RuntimeError("PDF não foi gerado pelo LibreOffice.")
    return pdf_path


def main():
    if len(sys.argv) != 4:
        print(json.dumps({"ok": False, "erro": "uso: gerar_contrato.py <template> <context.json> <outdir>"}))
        sys.exit(1)

    template_path, context_path, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    try:
        with open(context_path, "r", encoding="utf-8") as f:
            ctx = json.load(f)

        os.makedirs(out_dir, exist_ok=True)
        tpl = DocxTemplate(template_path)
        tpl.render(ctx)
        docx_out = os.path.join(out_dir, "contrato.docx")
        tpl.save(docx_out)

        pdf_path = converter_para_pdf(docx_out, out_dir)
        print(json.dumps({"ok": True, "pdf": pdf_path, "docx": docx_out}))
    except Exception as e:
        print(json.dumps({"ok": False, "erro": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
