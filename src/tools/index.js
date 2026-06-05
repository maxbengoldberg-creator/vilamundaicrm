// ==========================================================
//  Definição das ferramentas (tool use) disponíveis ao agente.
//  A Claude decide QUANDO chamar cada uma; o backend EXECUTA
//  em tools/handlers.js.
// ==========================================================

export const TOOLS = [
  {
    name: 'consultar_disponibilidade',
    description:
      'Consulta no PMS Hospedin quais acomodações estão disponíveis para um período e número de hóspedes, com a tarifa de cada uma. Use sempre antes de prometer datas ou cotar.',
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
      'Salva na ficha do lead os dados captados na conversa (datas, número de hóspedes, acomodação de interesse, orçamento). Use sempre que descobrir uma dessas informações.',
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string' },
        checkin: { type: 'string', description: 'AAAA-MM-DD' },
        checkout: { type: 'string', description: 'AAAA-MM-DD' },
        guests: { type: 'integer' },
        acomodacao: { type: 'string' },
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
    description:
      'Envia uma imagem ou vídeo ao lead pelo WhatsApp (ex.: fotos do chalé). Use URLs públicas das mídias da hospedagem.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: ['imagem', 'video'] },
        url: { type: 'string' },
        legenda: { type: 'string' },
      },
      required: ['tipo', 'url'],
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
      'Cria a reserva no PMS Hospedin com os dados confirmados do lead. Só use após o lead confirmar que quer reservar.',
    input_schema: {
      type: 'object',
      properties: {
        checkin: { type: 'string' },
        checkout: { type: 'string' },
        guests: { type: 'integer' },
        room_type_id: { type: ['string', 'integer'] },
        valor: { type: 'number' },
      },
      required: ['checkin', 'checkout', 'guests'],
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
