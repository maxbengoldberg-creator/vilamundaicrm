# Changelog — Vila Mundaí CRM

Registro de atualizações para acompanhar mudanças e poder voltar atrás.
Cada versão tem uma tag git de mesmo nome (ex.: `atualizacao-4.0`).

## Atualização 5.11 — 2026-06-24

Localização: endereço + link do Google Maps (em texto).

- Quando o lead pergunta onde fica, o bot responde o endereço uma vez e manda o
  link do Google Maps (https://maps.app.goo.gl/P9DWNuW47tCi1EmY8). Em texto, sem
  depender de enviar imagem de mapa (onde ele falhava — anunciava "vou mandar o
  mapa" e não mandava) e sem repetir o endereço nem martelar o bairro.
- Regra em REGRA_PRECO (vale nos 2 modelos).

## Atualização 5.10 — 2026-06-24

Grupo grande (>7 pessoas) → funil "Grupo grande" + IA desligada.

- Grupos acima de 7 pessoas precisam de mais de um apartamento (o maior comporta
  7), e a ferramenta não cota múltiplas unidades — antes o bot dizia
  "indisponível" (falso). Agora: detecta >7 hóspedes → manda para o funil
  **"Grupo grande"** com **IA desligada** (a equipe atende), sem cotar nem dizer
  indisponível.
- Detecção `ehGrupoGrande` em `handlers.js` (extrair_dados_lead e
  consultar_disponibilidade), com prioridade sobre "reserva ruim".
- Regra curta em REGRA_PRECO; novo estágio `grupo_grande` (seed/trigger/lab/coluna).

## Atualização 5.9 — 2026-06-21

Corrige fragmentação de lead de anúncio (mesma pessoa virando 2 contatos) e a
reapresentação do bot.

**Causa:** anúncio com número de formulário INVÁLIDO (ex.: "0157398617339") era
usado como identidade do lead; as mensagens reais vinham pelo número verdadeiro
e criavam um 2º lead. O merge por @lid não juntava (só tratava o formato
`{lid}@lid`). Resultado: conversa partida (CRM incompleto) e o bot lia histórico
sem a abertura, então se reapresentava.

**Correção (`agent.service`):**
- `phoneValidoBR`: número de formulário só vira identidade se for telefone BR
  válido; senão mantém o @lid (que o merge junta com o número real depois).
- `mergeLidDuplicates`: ao processar um lead, funde qualquer OUTRO lead com o
  mesmo lid no atual (consolida a conversa; a IA passa a ler tudo).
- `mergeLeadInto`: preserva lid/datas/email/etc. e a origem (meta_ads/site) do
  duplicado.
- Endpoint `POST /leads/backfill-lid-duplicados` (canônico = telefone válido)
  para fundir os duplicados já existentes.

## Atualização 5.8 — 2026-06-18

Corrige erro 400 ("tool_use sem tool_result") ao instruir o agente.

- O histórico podia terminar com um `tool_use` sem o `tool_result` (par quebrado
  por turno interrompido ou pela janela de 20 msgs cortar o par). Ao colar a
  instrução do operador logo depois, a API da Anthropic rejeitava (todo tool_use
  exige tool_result na sequência).
- `toClaudeMessages` agora também remove um `assistant` com `tool_use` que não
  tem o `tool_result` na próxima mensagem (passo 4), além dos tool_result órfãos.

## Atualização 5.7 — 2026-06-17

Estadia curta (até 2 noites) → funil "Reserva ruim" + IA desligada.

- Datas que dão **1 ou 2 noites** → lead vai para o funil **"Reserva ruim"** e a
  **IA é desligada** (a equipe decide se atende). Não cota nem informa preço.
- Detecção `ehReservaRuim` (numNoites <= 2) em `handlers.js`, no
  `extrair_dados_lead` e no `consultar_disponibilidade` (bloqueia a cotação),
  depois das checagens de Réveillon e 2027.
- Regra curta em REGRA_PRECO; o bot nunca diz ao lead que é "reserva ruim".
- Novo estágio `reserva_ruim`: seed + trigger + camada + coluna no Kanban.

## Atualização 5.6 — 2026-06-17

Botão "Ler e gerar contrato" no funil Contrato.

- Novo botão (Pipelines, cards em contrato/assinatura) que **lê a conversa**,
  extrai os dados do contrato (nome completo, CPF, nascimento, datas, pessoas,
  apto, valor) com Haiku, **preenche o que falta na ficha** do lead e em seguida
  **gera/baixa o PDF** — SEM falar nada com o lead.
- Endpoint `POST /leads/:id/contrato/preparar` (lê chat → extrai → preenche;
  só completa campos vazios, prefere o nome mais completo). Depois o front chama
  o `verContrato` para baixar o PDF já completo.

## Atualização 5.5 — 2026-06-17

Apresentação antes do preço + fotos sob demanda (sem empurrar).

- **Ritmo do preço (REGRA_PRECO):** se o lead pede preço só 1 vez, primeiro
  apresenta o apartamento ideal e conduz (fotos só se ele pedir, responde
  dúvidas); o preço vem DEPOIS da apresentação. Preço de imediato só se o lead
  INSISTIR no valor (2+ pedidos). (Antes: pedir preço 1x já disparava o valor.)
- **Apresentação (apres / c4_apres, M1 e M2):** apresentar o apto que se adequa
  e aguardar; NÃO enviar foto por conta própria; foto só sob pedido (+ "é algo
  nesse sentido?"); se não pedir foto mas tiver dúvida, responder e mencionar que
  tem fotos uma vez; em 2ª dúvida seguida, só responder, sem insistir nas fotos.

## Atualização 5.4 — 2026-06-16

Reservas para 2027 → funil próprio + IA desligada.

- Datas em **2027** (check-in ou check-out) → lead vai para o funil **"Reservas
  2027"** e a **IA é desligada** (condições de 2027 ainda não definidas; humano assume).
- Detecção `ehReserva2027` em `handlers.js`: aplicada no `extrair_dados_lead` e no
  `consultar_disponibilidade` (bloqueia a cotação), igual ao Réveillon.
- Regra curta em REGRA_PRECO: não cotar/precificar 2027.
- Novo estágio `reservas_2027`: seed + trigger + camada + coluna no Kanban.
- Obs.: só ano 2027 (se um dia precisar 2028+, é fácil estender).

## Atualização 5.3 — 2026-06-14

Ajustes de condução (camadas/etapas, sem mexer na REGRA_PRECO):

- **Nome com rapport:** apresentar-se primeiro e só então pegar o primeiro nome
  de forma natural. Não abrir com "Com quem eu falo?" nem jogar essa pergunta
  solta depois do orçamento. (qualif / c4_qualif)
- **Grupo → categoria:** para 1, 2 ou 3 pessoas, apresentar e cotar SOMENTE o
  apartamento de 1 quarto. Só mostrar/cotar o de 2 quartos se o lead pedir um
  maior ou mais espaço. Aplicado também no orçamento. (apres+quente / c4_apres+c4_quente)

## Atualização 5.2 — 2026-06-14

Lead do site → funil próprio + IA desligada.

- Quando chega o **formulário de reserva do site** (texto estruturado "Gostaria
  de fazer uma reserva no Vila Mundaí… Detalhes da reserva: Check-in/Check-out/
  Hóspedes…"), o lead vai para o funil **"Lead do site"** e a **IA é desligada**
  (atendimento humano, com calma — não há conversa/rapport ainda, só o dado).
- Detecção `pareceSite` + `parseFormSite` em `handleIncoming`: salva nome/datas/
  hóspedes na ficha e NÃO deixa a IA disparar preço/condições.
- Novo estágio `lead_site`: seed + trigger + camada + coluna no Kanban.

## Atualização 5.1 — 2026-06-14

Volta a REGRA_PRECO 4.9 (enxuta) + ajustes de condução na apresentação e
qualificação (nas camadas/etapas, não na REGRA_PRECO, para não inchar):

- **Casal → só 1 quarto:** para 1 ou 2 pessoas, apresentar SOMENTE o apartamento
  de 1 quarto; não citar o de 2 quartos a menos que o lead peça mais espaço.
- **Pet sem over-qualify:** confirmar que aceita sem taxa e seguir; não perguntar
  porte nem quantidade.
- **Ritmo de qualificação mais leve:** sem interrogatório, sem emendar várias
  perguntas seguidas.

Aplicado em c4_apres/c4_qualif (Modelo 2) e nos prompts apres/qualif (Modelo 1).

## Atualização 5.0 — 2026-06-14

Revert: REGRA_PRECO volta à versão 4.8 (a pedido do CEO Max). Só o arquivo de
regras (src/services/stage.prompts.js) foi revertido; todo o resto (login,
dedup 9º dígito, avisos, diagnóstico Z-API) permanece. Observação: isso
reintroduz o comportamento de o Modelo 2 não se apresentar e usar preâmbulos,
que a 4.9 havia corrigido.

## Atualização 4.9 — 2026-06-14

Enxuga a REGRA_PRECO + regra de preço exato (ataca a apresentação sumida e o
preço transcrito errado no Modelo 2).

- REGRA_PRECO condensada de ~8.800 para ~4.165 chars (todas as regras mantidas,
  só o texto mais enxuto; exemplos verbosos removidos). Removido o trecho "estas
  regras valem SOBRE as instruções de etapa", que atropelava a apresentação das
  camadas (C1/C4) no Modelo 2.
- Nova regra: apresentar o preço EXATAMENTE como a ferramenta devolveu
  (total_formatado de cada opção), nunca recalcular/arredondar/trocar valores —
  corrige casos como 1Q superior saindo R$517 em vez de R$868.

Reversível: voltar para a tag atualizacao-4.8 se não ficar bom.

## Atualização 4.8 — 2026-06-14

Login real no painel + chave da API fora do HTML (etapa 1 do app no celular).

- Login com usuário/senha (`maxbgoldberg` / senha guardada como hash sha256, não
  em texto; sobrescrevível por CRM_USER/CRM_PASS_HASH no Railway).
- `POST /api/v1/auth/login` (público) devolve um token de sessão (HMAC stateless,
  30 dias, segredo AUTH_SECRET ou APP_API_KEY). `src/services/auth.js`.
- Middleware passa a aceitar `Authorization: Bearer <token>` OU `x-api-key`
  (chave mantida só para integrações servidor-a-servidor).
- Front: removida a API key embutida no HTML; agora usa o token do login
  (localStorage), entra direto se já logado, 401 derruba para o login. Tela de
  login funcional (Usuário/Senha) com Enter para entrar.

## Atualização 4.7 — 2026-06-14

A mensagem de aviso de novo lead passa a ser só o texto "Novo Lead" (sem nome,
telefone nem prévia), a pedido do dono.

## Atualização 4.6 — 2026-06-14

Aviso de novo lead no WhatsApp pessoal do dono.

- Quando um lead NOVO manda a primeira mensagem (`handleIncoming`), o dono recebe
  um WhatsApp via Z-API. Fire-and-forget, não atrasa a resposta ao lead.
- Configurável na aba Agente: número pessoal + liga/desliga (settings
  `notify_lead_phone` / `notify_lead_enabled`). Endpoints `GET/POST /notify/lead`.
- Não avisa em mensagens de operador nem se o número do aviso for o do próprio lead.

## Atualização 4.5 — 2026-06-14

Corrige duplicação de contato pelo 9º dígito (BR) e nome não gravado.

**Problema:** o WhatsApp/Z-API entrega o número ora com 13 dígitos (com o 9) ora
com 12 (sem o 9). Como o telefone é a chave de identidade, a mesma pessoa virava
2 leads e 2 conversas (ex.: Lucia/Lucia Vania, Alessandra×2). O nome (pushName)
também só era gravado na criação, nunca atualizado depois.

**Correção:**
- `lead.model`: `formasPhoneBR()` (gera as formas com/sem 9) e `findByPhoneFlex()`
  (casa o lead por qualquer forma). O número de ENVIO não muda (segurança Z-API).
- `agent.service`: `handleIncoming` usa lookup flexível, grava/atualiza o nome
  quando o pushName chega (prefere o mais completo) e funde duplicados do 9º
  dígito (`mergePhoneDuplicates` move conversas/mensagens para o lead mais antigo).
- Conversa consolidada por lead (`findOpenByLead`), não pela forma do telefone.
- `persistOutboundHuman` também usa a identidade consolidada.
- Endpoint `POST /leads/backfill-telefones` funde os duplicados já existentes.

## Atualização 4.4 — 2026-06-14

Corrige preço errado ao cotar vários tipos de uma vez (ex.: 1Q superior saindo
o dobro do térreo).

**Causa:** `consultar_disponibilidade` criava as pré-reservas temporárias de
todos os tipos em paralelo (`Promise.all`). O PMS precifica cada reserva pela
ocupação do momento, então as pré-reservas irmãs (criadas no mesmo instante)
inflavam a ocupação e contaminavam o preço umas das outras. Reproduzido: em
paralelo o 2Q saía R$750/R$1050 (errado) e as 4 reservas vinham com o mesmo
código; sequencial dava R$810/R$960 (correto).

**Correção (`src/tools/handlers.js`):** cotação SEQUENCIAL — cria, lê e cancela
uma pré-reserva por vez, só então o próximo tipo. Cada cotação enxerga só a
ocupação real. (Custa um pouco mais de tempo, mas o preço fica correto.)

## Atualização 4.3 — 2026-06-14

Funil "Reveillon" + bloqueio de cotação para datas de virada de ano.

- Datas que pegam **30 ou 31 de dezembro** → lead vai para o funil **reveillon**
  e a **IA é desligada**, sem cotar nem passar preço (condições especiais da equipe).
- Detecção em `handlers.js` (`periodoReveillon`): aplicada no `extrair_dados_lead`
  (assim que as datas aparecem) e no `consultar_disponibilidade` (bloqueia a cotação).
- Regra em REGRA_PRECO (vale nos 2 modelos): não cotar/precificar Réveillon.
- Novo estágio `reveillon`: seed + trigger + camada (lab) + coluna no Kanban.

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
