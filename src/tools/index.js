// ==========================================================
//  Definição das ferramentas (tool use) disponíveis ao agente.
//  A Claude decide QUANDO chamar cada uma; o backend EXECUTA
//  em tools/handlers.js.
// ==========================================================

export const TOOLS = [
  {
    name: 'consultar_disponibilidade',
    description:
      'Consulta no PMS Hospedin quais acomodações estão disponíveis para um período e número de hóspedes. Retorna, para cada acomodação, a diária JÁ ajustada pelo número de hóspedes e o total_estadia já calculado (diária × noites) — use esses valores exatamente como vieram, sem calcular nem descontar nada por conta própria. Se o número de hóspedes ou as datas mudarem na conversa, consulte de novo. Use sempre antes de prometer datas ou cotar.',
    input_schema: {
      type: 'object',
      properties: {
        checkin: { type: 'string', description: 'Data de check-in no formato AAAA-MM-DD' },
        checkout: { type: 'string', description: 'Data de check-out no formato AAAA-MM-DD' },
        guests: { type: 'integer', description: 'Número de hóspedes' },
      },
      required: ['checkin', 'checkout', 'guests'],
    },
  },
  {
    name: 'cotar',
    description:
      'Calcula o valor total de uma estadia (diária × noites + extras) e registra o valor cotado no lead. Use depois de confirmar a disponibilidade.',
    input_schema: {
      type: 'object',
      properties: {
        acomodacao: { type: 'string' },
        diaria: { type: 'number', description: 'Valor da diária em reais' },
        noites: { type: 'integer' },
        cafe_incluso: { type: 'boolean' },
      },
      required: ['acomodacao', 'diaria', 'noites'],
    },
  },
  {
    name: 'extrair_dados_lead',
    description:
      'Salva na ficha do lead os dados captados na conversa. Use sempre que descobrir qualquer uma dessas informações — incluindo nome completo, CPF e data de nascimento coletados na negociação.',
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string', description: 'Nome completo do lead' },
        checkin: { type: 'string', description: 'AAAA-MM-DD' },
        checkout: { type: 'string', description: 'AAAA-MM-DD' },
        guests: { type: 'integer' },
        acomodacao: { type: 'string' },
        cpf: { type: 'string', description: 'CPF do lead, somente números ou com pontuação' },
        data_nascimento: { type: 'string', description: 'Data de nascimento no formato AAAA-MM-DD' },
      },
    },
  },
  {
    name: 'qualificar_lead',
    description:
      'Define a pontuação de qualificação (0 a 100) e aplica tags ao lead. Use após entender o perfil e o interesse.',
    input_schema: {
      type: 'object',
      properties: {
        score: { type: 'integer', description: '0 a 100' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['score'],
    },
  },
  {
    name: 'mover_funil',
    description: 'Avança o lead para a próxima etapa do funil. O robô só pode avançar UMA etapa por vez — nunca pular. Sequência: qualif → apres → quente → negociacao → contrato → pagamento → ganho. De morno, avança para negociacao.',
    input_schema: {
      type: 'object',
      properties: {
        stage: {
          type: 'string',
          enum: ['qualif', 'apres', 'quente', 'negociacao', 'contrato', 'pagamento', 'ganho', 'morno'],
        },
      },
      required: ['stage'],
    },
  },
  {
    name: 'enviar_midia',
    description: 'Envia as fotos ou vídeos do tipo de apartamento indicado ao lead pelo WhatsApp. As mídias são buscadas automaticamente do banco conforme o tipo_apto.',
    input_schema: {
      type: 'object',
      properties: {
        tipo_apto: {
          type: 'string',
          enum: ['apto-1-quarto-terreo', 'apto-1-quarto-superior', 'apartamento-dois-quartos', 'area-externa', 'geral'],
          description: 'Nome da pasta no Cloudinary. Use "apto-1-quarto-superior" para fotos do apartamento de 1 quarto superior, "area-externa" para fotos da área comum/piscina, "geral" para fotos gerais da Vila.',
        },
      },
      required: ['tipo_apto'],
    },
  },
  {
    name: 'gerar_link_pagamento',
    description:
      'Gera um link de pagamento (sinal/total) para o lead. Use ao fechar a venda.',
    input_schema: {
      type: 'object',
      properties: {
        valor: { type: 'number' },
        descricao: { type: 'string' },
      },
      required: ['valor'],
    },
  },
  {
    name: 'criar_reserva',
    description:
      'Cria a reserva no PMS Hospedin com os dados confirmados do lead. Só use após o lead confirmar que quer reservar. Use o tipo de apto e a diária exatamente como retornados pela consulta de disponibilidade.',
    input_schema: {
      type: 'object',
      properties: {
        checkin: { type: 'string', description: 'AAAA-MM-DD' },
        checkout: { type: 'string', description: 'AAAA-MM-DD' },
        guests: { type: 'integer' },
        tipo_apto: {
          type: 'string',
          enum: ['1 Quarto - Térreo', '1 Quarto - Superior', '2 Quartos - Térreo', '2 Quartos - Superior'],
          description: 'Tipo de apartamento, exatamente como retornado pela consulta de disponibilidade (campo acomodacao).',
        },
        valor: { type: 'number', description: 'Valor da DIÁRIA em reais (não o total da estadia), exatamente como retornado pela consulta de disponibilidade desta conversa — já ajustado pelo número de hóspedes. É esse valor que será lançado no PMS.' },
      },
      required: ['checkin', 'checkout', 'guests', 'tipo_apto', 'valor'],
    },
  },
  {
    name: 'salvar_condicoes',
    description: 'Salva as condições de pagamento acordadas com o lead na negociação. Use quando todas as condições estiverem combinadas, antes de coletar os dados pessoais.',
    input_schema: {
      type: 'object',
      properties: {
        forma_pagamento: { type: 'string', description: 'Forma de pagamento acordada: "pix", "cartao" ou "misto"' },
        parcelas: { type: 'integer', description: 'Número de parcelas no cartão. Use 1 para Pix.' },
        desconto_pix: { type: 'boolean', description: 'true se o lead fechou com desconto de 5% no Pix' },
        valor_total: { type: 'number', description: 'Valor total da reserva em reais' },
        valor_sinal: { type: 'number', description: 'Valor do sinal em reais (30% do total ou valor acordado)' },
        data_sinal: { type: 'string', description: 'Data combinada para pagamento do sinal (opcional), formato AAAA-MM-DD' },
        observacoes: { type: 'string', description: 'Condições especiais acordadas, se houver (opcional)' },
      },
      required: ['forma_pagamento', 'parcelas', 'desconto_pix', 'valor_total', 'valor_sinal'],
    },
  },
  {
    name: 'escalar_humano',
    description:
      'Transfere a conversa para um atendente humano e PAUSA a IA neste lead. Use quando o caso for sensível, de alto valor, reclamação, ou quando o lead pedir para falar com uma pessoa.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: { type: 'string' },
      },
      required: ['motivo'],
    },
  },
];
