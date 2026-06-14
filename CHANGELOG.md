# Changelog — Vila Mundaí CRM

Registro de atualizações para acompanhar mudanças e poder voltar atrás.
Cada versão tem uma tag git de mesmo nome (ex.: `atualizacao-4.0`).

## Atualização 4.2 — 2026-06-13

Reforço da regra de estilo: o bot estava usando travessão ("—").
- REGRA_PRECO (vale nos 2 modelos): regra explícita proibindo travessão/hífen
  para separar ideias, com exemplo certo/errado. Separar com ponto ou vírgula.

## Atualização 4.1 — 2026-06-13

Correção do preço inflado (ex.: 1Q Superior saindo R$ 6.000 em vez de R$ 1.990).

**Causa:** em `consultar_disponibilidade`, quando a cotação real (pré-reserva
temporária) de um tipo falhava (unidade ocupada/instabilidade), o código caía
num fallback que mostrava a **tarifa cheia do calendário** (`rates_and_availabilities`,
SEM desconto por ocupação). A superior tem desconto grande (cheia ~R$600 →
R$199 para casal), então o fallback gerava 600×10 = R$6.000.

**Correção (`src/tools/handlers.js`):**
- Retry (até 3x) na cotação real por tipo.
- Removido o fallback de tarifa cheia: tipo sem cotação real é **omitido**, nunca
  apresentado com a tarifa do calendário (regra de ouro: preço só da pré-reserva).
- Itens montados só com os valores do `cotarNativo` (a diária do calendário não
  vaza mais nem em caso de sucesso). Se todos falharem, retorna erro → o agente
  refaz a consulta calado.

## Atualização 4.0 — 2026-06-13

Refino do convite de pré-reserva e alinhamento da etapa Lead Quente nos dois modelos.

**REGRA_PRECO (regras de condução — valem em Modelo 1 e Modelo 2):**
- **R1 — não repetir o convite de pré-reserva:** convidar no máximo 1 vez de cada vez; se já convidou e o lead fez outra pergunta, responder só a pergunta e não reanexar o convite.
- **R2 — não emendar/forçar o CTA:** não grudar o convite no preço nem no fim de cada resposta; dar espaço para o lead responder.
- **R3 — CTA variado e sem "eu":** variar o jeito de convidar, nunca a mesma frase; não começar com "quer que eu faça a pré-reserva".
- **R4 — script de "como faz a pré-reserva":** nome completo, CPF e data de nascimento para cadastrar; depois contrato enviado por aqui; sinal de 30% para garantir, restante na chegada.

**Etapa Lead Quente (alinhada em M1 `prompt_body` e M2 `c4_quente`):**
- Exemplo de CTA trocado (sem "quer que eu… para você").
- Removido jargão do contrato ("PDF/WhatsApp/Gov.br") → "enviamos o contrato por aqui para conferir e assinar".
- Sinal corrigido: 30% Pix ou cartão em 1x (não parcelado), restante na chegada.

> Trabalho anterior a esta versão (modos Modelo 1/2, estágios sem_datas e assinatura,
> correções do contrato em PDF, regras de conduta e do sinal, anexo do contrato)
> não foi versionado; a partir do 4.0 seguimos com tags.
