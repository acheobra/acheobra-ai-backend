/**
 * ================================================================
 * ACHE OBRA - JISA IA - BACKEND
 * server_ia.js
 * ================================================================
 *
 * Arquitetura 100% OpenAI:
 *   Flutter -> este servidor -> OpenAI Responses API
 *                            -> GPT (texto, contexto, visão e decisão)
 *                            -> GPT Image (geração e edição de imagens)
 *
 * Variável obrigatória no Render:
 *   OPENAI_API_KEY
 *
 * Variáveis opcionais:
 *   OPENAI_MAIN_MODEL
 *   OPENAI_IMAGE_MODEL
 *   OPENAI_IMAGE_QUALITY
 *
 * Endpoints mantidos para compatibilidade com o Flutter:
 *   POST /ia/processar
 *   POST /ia/perguntar
 *   POST /ia/gerar-imagem
 *   GET  /health
 *
 * A Jisa é especializada exclusivamente em construção civil,
 * com saudações, agradecimentos e despedidas sempre permitidos.
 * ================================================================
 */

'use strict';

import express from 'express';

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ extended: true, limit: '30mb' }));

// ----------------------------------------------------------------
// CONFIGURAÇÃO
// ----------------------------------------------------------------

const PORT = Number(process.env.PORT || 10000);

const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || '').trim();

// Modelo principal: conversa, contexto, visão, análise e orquestração.
const OPENAI_MAIN_MODEL = String(
  process.env.OPENAI_MAIN_MODEL || 'gpt-5.6-luna'
).trim();

// Modelo visual. Sunburst prioriza fidelidade de edição/continuidade.
const OPENAI_IMAGE_MODEL = String(
  process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2.5-sunburst'
).trim();

// Começamos em LOW para controlar custo. Pode ser alterado no Render.
const OPENAI_IMAGE_QUALITY = String(
  process.env.OPENAI_IMAGE_QUALITY || 'low'
).trim().toLowerCase();

const MAX_HISTORICO = 14;
const MAX_ARQUIVOS = 5;
const MAX_ARQUIVO_BYTES = 18 * 1024 * 1024;
const TIMEOUT_OPENAI_MS = 90000;
const TIMEOUT_IMAGEM_MS = 180000;

const RESPOSTA_FORA_ESCOPO =
  'Posso ajudar com assuntos relacionados à construção civil. ' +
  'Se quiser, me pergunte sobre obras, reformas, arquitetura, engenharia, ' +
  'materiais, ferramentas, instalações, orçamento, profissionais ou outros temas da construção.';

const INSTRUCAO_SISTEMA = `
Você é a Jisa, a assistente de inteligência artificial do Ache Obra.

IDENTIDADE E ESPECIALIDADE
- Responda sempre em português do Brasil.
- Você é especialista exclusivamente em construção civil.
- Seu domínio é amplo dentro da construção: obras, reformas, arquitetura,
  engenharia civil, projetos, fachadas, plantas, interiores ligados à obra,
  materiais, ferramentas, equipamentos, elétrica predial, hidráulica,
  estruturas, fundações, alvenaria, revestimentos, pintura, telhados,
  esquadrias, impermeabilização, orçamento, quantitativos, custos,
  cronogramas, segurança da obra, fornecedores, compras, vendas de materiais,
  atendimento, gestão, contratação de profissionais, prestação de serviços,
  imóveis quando o assunto estiver relacionado a construção/reforma,
  marketing e negócios de empresas/profissionais do setor da construção.
- Um pedido visual pode conter elementos secundários que não são construção.
  Exemplo: "crie uma casa com um cachorro no quintal" continua sendo construção,
  pois a casa/obra é o assunto principal.
- Se o pedido for claramente fora da construção civil e não for uma interação
  social simples, responda educadamente que você é especializada em construção civil.
- Saudações, agradecimentos, despedidas e conversa social curta são sempre permitidos.
  Exemplos: olá, bom dia, boa tarde, boa noite, tudo bem, obrigado, valeu,
  até mais, tchau. Responda naturalmente, sem forçar o assunto construção.

COMPORTAMENTO
- Responda exatamente ao que o usuário perguntar.
- Se ele fizer um pedido, execute quando possível.
- Seja simples, objetiva, clara e prática.
- Evite respostas longas quando uma resposta curta resolver.
- Não faça perguntas desnecessárias.
- Não repita informações que o usuário já forneceu.
- Não fique se apresentando durante a conversa.
- Não ofereça listas do que você sabe fazer sem necessidade.
- Quando faltar um detalhe secundário, faça uma suposição razoável e prossiga.
- Pergunte somente quando faltar uma informação indispensável.
- Quando o usuário corrigir algo, aceite a correção e continue a partir dela.
- Nunca invente informações técnicas que não saiba.
- Em temas de segurança estrutural, instalações críticas, normas ou cálculos que
  dependam de inspeção/projeto, deixe claro quando for necessária validação por
  profissional habilitado, sem transformar toda resposta em aviso genérico.

CONTEXTO
- Use o histórico recente para compreender referências como:
  "ela", "essa casa", "a anterior", "como pedi", "igual à anterior",
  "de verdade", "mais realista", "mude isso", "agora", "que pedi",
  "que descrevi", "que falei", "que mencionei".
- Preserve requisitos já definidos pelo usuário.
- Em uma correção ou continuação, altere somente o que foi pedido, salvo se uma
  mudança adicional for necessária para tornar o resultado coerente.
- Não peça novamente uma informação que já esteja disponível no histórico.

IMAGENS
- Quando o usuário pedir uma imagem relacionada à construção, considere isso
  uma ação visual, não apenas uma pergunta sobre imagens.
- Para pedidos como "casa de verdade", "mais realista" ou equivalentes, interprete
  como fotografia arquitetônica fotorrealista, construção em escala real,
  materiais reais, iluminação natural e proporções plausíveis. Evite aparência
  de maquete, miniatura, diorama ou brinquedo, salvo se isso for pedido.
`.trim();

const INSTRUCAO_ORQUESTRADOR = `
Você é o cérebro/orquestrador da Jisa, assistente do Ache Obra.

A Jisa é especialista EXCLUSIVAMENTE em construção civil.
Interprete semanticamente o pedido atual junto com o histórico. Não dependa de
listas rígidas de palavras-chave.

Saudações, agradecimentos, despedidas e conversa social curta são permitidos.

Classifique o pedido atual em UMA ação:
- "texto": conversa, pergunta, análise, cálculo, orientação ou análise de anexos.
- "imagem": criação de uma NOVA imagem relacionada à construção civil.
- "editar_imagem": alteração visual de uma imagem enviada agora ou continuação/
  modificação da última imagem gerada, quando ela estiver disponível.
- "fora_escopo": pedido claramente fora da construção civil, exceto interação social.

REGRAS:
- Uma imagem pode conter elementos secundários fora da construção se o assunto
  principal continuar sendo construção.
- Se o usuário enviou imagem apenas para analisar, use "texto".
- Se pediu para modificar visualmente uma imagem, use "editar_imagem".
- Se existe imagem anterior disponível e o pedido continua aquela criação
  ("troque o piso", "coloque garagem", "mais realista", "mude a janela",
  "agora mostre por dentro"), prefira "editar_imagem".
- Use "imagem" quando a criação for nova e independente.
- Para "imagem" e "editar_imagem", produza promptVisual em português, compacto,
  autocontido e fiel ao histórico.
- Em edição, diga explicitamente o que deve ser preservado e o que deve mudar.
- Para texto/fora_escopo, promptVisual deve ser vazio.

Responda SOMENTE JSON válido, sem Markdown:
{
  "acao": "texto|imagem|editar_imagem|fora_escopo",
  "promptVisual": "",
  "motivoCurto": ""
}
`.trim();

// ----------------------------------------------------------------
// UTILITÁRIOS
// ----------------------------------------------------------------

function logInfo(evento, dados = {}) {
  try {
    console.log(JSON.stringify({
      nivel: 'INFO',
      evento,
      ...dados,
      horario: new Date().toISOString(),
    }));
  } catch (_) {
    console.log(`[INFO] ${evento}`);
  }
}

function logErro(evento, erro, dados = {}) {
  const mensagem =
    erro instanceof Error ? erro.message : String(erro || 'Erro desconhecido');

  try {
    console.error(JSON.stringify({
      nivel: 'ERRO',
      evento,
      mensagem,
      ...dados,
      horario: new Date().toISOString(),
    }));
  } catch (_) {
    console.error(`[ERRO] ${evento}: ${mensagem}`);
  }
}

function textoSeguro(valor, limite = 12000) {
  if (valor === null || valor === undefined) return '';
  const texto = String(valor).trim();
  return texto.length <= limite ? texto : texto.slice(0, limite);
}

function limitarTextoPorCaracteres(texto, limite) {
  const valor = String(texto || '').trim();
  return valor.length <= limite ? valor : valor.slice(0, limite).trim();
}

function limparArtefatosResposta(texto) {
  return String(texto || '')
    .replace(/(^|\n)(\s*(?:[-*•]|\d+[.)])?\s*)\$1(?=\s)/g, '$1$2')
    .trim();
}

function removerCercasJson(texto) {
  return String(texto || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function extrairJsonObjeto(texto) {
  const limpo = removerCercasJson(texto);

  try {
    const direto = JSON.parse(limpo);
    if (direto && typeof direto === 'object' && !Array.isArray(direto)) {
      return direto;
    }
  } catch (_) {}

  const inicio = limpo.indexOf('{');
  const fim = limpo.lastIndexOf('}');

  if (inicio >= 0 && fim > inicio) {
    try {
      const objeto = JSON.parse(limpo.slice(inicio, fim + 1));
      if (objeto && typeof objeto === 'object' && !Array.isArray(objeto)) {
        return objeto;
      }
    } catch (_) {}
  }

  return null;
}

function mimeEhImagem(mimeType) {
  return String(mimeType || '').toLowerCase().startsWith('image/');
}

function normalizarMime(mimeType, nome = '') {
  let mime = String(mimeType || '').trim().toLowerCase();
  if (mime === 'image/jpg') mime = 'image/jpeg';
  if (mime) return mime;

  const extensao = String(nome || '').toLowerCase().split('.').pop();

  const mapa = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    html: 'text/html',
    htm: 'text/html',
    xml: 'text/xml',
    json: 'application/json',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    odt: 'application/vnd.oasis.opendocument.text',
    ods: 'application/vnd.oasis.opendocument.spreadsheet',
    odp: 'application/vnd.oasis.opendocument.presentation',
    rtf: 'application/rtf',
    sql: 'application/sql',
    js: 'application/javascript',
    css: 'text/css',
  };

  return mapa[extensao] || 'application/octet-stream';
}

function tamanhoBase64Aproximado(base64) {
  const valor = String(base64 || '').replace(/\s/g, '');
  if (!valor) return 0;

  let padding = 0;
  if (valor.endsWith('==')) padding = 2;
  else if (valor.endsWith('=')) padding = 1;

  return Math.max(0, Math.floor((valor.length * 3) / 4) - padding);
}

function validarArquivos(arquivos) {
  if (arquivos === undefined || arquivos === null) return [];

  if (!Array.isArray(arquivos)) {
    const erro = new Error('O campo "arquivos" deve ser uma lista.');
    erro.statusCode = 400;
    throw erro;
  }

  if (arquivos.length > MAX_ARQUIVOS) {
    const erro = new Error(
      `É permitido enviar no máximo ${MAX_ARQUIVOS} arquivos por mensagem.`
    );
    erro.statusCode = 400;
    throw erro;
  }

  return arquivos.map((arquivo, indice) => {
    if (!arquivo || typeof arquivo !== 'object') {
      const erro = new Error(`O arquivo ${indice + 1} é inválido.`);
      erro.statusCode = 400;
      throw erro;
    }

    const nome = textoSeguro(arquivo.nome || `arquivo_${indice + 1}`, 300);
    const mimeType = normalizarMime(arquivo.mimeType, nome);
    const base64 = String(arquivo.base64 || '').replace(/\s/g, '');

    if (!base64) {
      const erro = new Error(`O arquivo "${nome}" não possui conteúdo.`);
      erro.statusCode = 400;
      throw erro;
    }

    const bytes = tamanhoBase64Aproximado(base64);

    if (bytes > MAX_ARQUIVO_BYTES) {
      const erro = new Error(`O arquivo "${nome}" ultrapassa o limite de 18 MB.`);
      erro.statusCode = 413;
      throw erro;
    }

    return {
      nome,
      mimeType,
      base64,
      bytes,
      ehImagem: mimeEhImagem(mimeType),
    };
  });
}

function normalizarHistorico(historico) {
  if (!Array.isArray(historico)) return [];

  return historico
    .slice(-MAX_HISTORICO)
    .map((item) => {
      const roleOriginal = String(item?.role || '').toLowerCase();
      const role =
        roleOriginal === 'assistant' || roleOriginal === 'model'
          ? 'assistant'
          : 'user';

      return {
        role,
        content: textoSeguro(item?.content || item?.texto || '', 7000),
        teveImagemGerada: item?.teveImagemGerada === true,
      };
    })
    .filter((item) => item.content);
}

function historicoEmTexto(historico, limite = 10) {
  return normalizarHistorico(historico)
    .slice(-limite)
    .map((item) => {
      const papel = item.role === 'assistant' ? 'Jisa' : 'Usuário';
      const imagem = item.teveImagemGerada ? ' [imagem gerada]' : '';
      return `${papel}${imagem}: ${item.content}`;
    })
    .join('\n');
}

function possuiReferenciaVisualNoHistorico(historico) {
  return normalizarHistorico(historico).some(
    (item) => item.teveImagemGerada === true
  );
}

function dataUrlArquivo(arquivo) {
  return `data:${arquivo.mimeType};base64,${arquivo.base64}`;
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  return {
    signal: controller.signal,
    cancelar: () => clearTimeout(timer),
  };
}

async function fetchJson(url, opcoes = {}, timeoutMs = 60000) {
  const controle = withTimeout(timeoutMs);

  try {
    const resposta = await fetch(url, {
      ...opcoes,
      signal: controle.signal,
    });

    const texto = await resposta.text();
    let dados = null;

    try {
      dados = texto ? JSON.parse(texto) : null;
    } catch (_) {
      dados = texto;
    }

    if (!resposta.ok) {
      const detalhe =
        typeof dados === 'string'
          ? dados
          : dados?.error?.message ||
            dados?.errors?.[0]?.message ||
            JSON.stringify(dados || {});

      const erro = new Error(
        `HTTP ${resposta.status}: ${limitarTextoPorCaracteres(detalhe, 1400)}`
      );
      erro.statusCode = resposta.status;
      erro.responseData = dados;
      throw erro;
    }

    return {
      status: resposta.status,
      headers: resposta.headers,
      data: dados,
    };
  } finally {
    controle.cancelar();
  }
}

function headersOpenAI() {
  if (!OPENAI_API_KEY) {
    const erro = new Error('OPENAI_API_KEY não está configurada no Render.');
    erro.statusCode = 503;
    throw erro;
  }

  return {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

// ----------------------------------------------------------------
// OPENAI RESPONSES API - TEXTO / VISÃO / ORQUESTRAÇÃO
// ----------------------------------------------------------------

function extrairTextoOpenAI(dados) {
  if (typeof dados?.output_text === 'string' && dados.output_text.trim()) {
    return dados.output_text.trim();
  }

  const saidas = Array.isArray(dados?.output) ? dados.output : [];
  const textos = [];

  for (const item of saidas) {
    if (item?.type !== 'message' || !Array.isArray(item?.content)) continue;

    for (const parte of item.content) {
      if (
        (parte?.type === 'output_text' || parte?.type === 'text') &&
        typeof parte?.text === 'string'
      ) {
        textos.push(parte.text);
      }
    }
  }

  return textos.join('\n').trim();
}

function montarInputOpenAI({
  mensagem,
  historico = [],
  arquivos = [],
  instrucaoExtra = '',
}) {
  const input = [];

  for (const item of normalizarHistorico(historico)) {
    input.push({
      role: item.role,
      content: item.content,
    });
  }

  const conteudoAtual = [];
  const textoAtual =
    textoSeguro(mensagem, 12000) ||
    (arquivos.length > 0 ? 'Analise os arquivos enviados.' : 'Olá');

  conteudoAtual.push({
    type: 'input_text',
    text: instrucaoExtra
      ? `${instrucaoExtra}\n\nPEDIDO ATUAL DO USUÁRIO:\n${textoAtual}`
      : textoAtual,
  });

  for (const arquivo of arquivos) {
    if (arquivo.ehImagem) {
      conteudoAtual.push({
        type: 'input_image',
        image_url: dataUrlArquivo(arquivo),
      });
    } else {
      // Documentos são enviados como data URL pelo input_file.
      conteudoAtual.push({
        type: 'input_file',
        filename: arquivo.nome,
        file_data: dataUrlArquivo(arquivo),
      });
    }
  }

  input.push({
    role: 'user',
    content: conteudoAtual,
  });

  return input;
}

async function chamarOpenAITexto({
  mensagem,
  historico = [],
  arquivos = [],
  systemInstruction = INSTRUCAO_SISTEMA,
  instrucaoExtra = '',
  maxOutputTokens = 1800,
  reasoningEffort = 'low',
}) {
  const corpo = {
    model: OPENAI_MAIN_MODEL,
    instructions: systemInstruction,
    input: montarInputOpenAI({
      mensagem,
      historico,
      arquivos,
      instrucaoExtra,
    }),
    max_output_tokens: maxOutputTokens,
    reasoning: {
      effort: reasoningEffort,
    },
  };

  logInfo('openai_texto', {
    modelo: OPENAI_MAIN_MODEL,
    arquivos: arquivos.length,
  });

  const { data } = await fetchJson(
    'https://api.openai.com/v1/responses',
    {
      method: 'POST',
      headers: headersOpenAI(),
      body: JSON.stringify(corpo),
    },
    TIMEOUT_OPENAI_MS
  );

  const texto = extrairTextoOpenAI(data);

  if (!texto) {
    throw new Error('A OpenAI não retornou texto utilizável.');
  }

  return {
    texto,
    responseId: textoSeguro(data?.id, 300),
  };
}

// ----------------------------------------------------------------
// OPENAI - DECISÃO SEMÂNTICA DA JISA
// ----------------------------------------------------------------

async function decidirAcaoJisa({
  mensagem,
  historico = [],
  arquivos = [],
  forcarImagem = false,
  temImagemAnteriorDisponivel = false,
}) {
  const imagens = arquivos.filter((arquivo) => arquivo.ehImagem);
  const documentos = arquivos.filter((arquivo) => !arquivo.ehImagem);
  const contexto = historicoEmTexto(historico, 10);
  const temImagemAnterior = possuiReferenciaVisualNoHistorico(historico);

  const resumo = `
MENSAGEM ATUAL:
${textoSeguro(mensagem, 6000) || '(sem texto; há anexos)'}

CONTEXTO RECENTE:
${contexto || '(sem histórico)'}

ANEXOS:
- imagens enviadas agora: ${imagens.length}
- documentos enviados agora: ${documentos.length}
- existe indicação de imagem gerada anteriormente: ${temImagemAnterior ? 'sim' : 'não'}
- última imagem em bytes disponível para edição: ${temImagemAnteriorDisponivel ? 'sim' : 'não'}

COMPATIBILIDADE:
- endpoint visual solicitado explicitamente pelo aplicativo: ${forcarImagem ? 'sim' : 'não'}

Mesmo no endpoint visual, respeite o escopo da construção civil.
`.trim();

  const resposta = await chamarOpenAITexto({
    mensagem: resumo,
    historico: [],
    arquivos: [],
    systemInstruction: INSTRUCAO_ORQUESTRADOR,
    maxOutputTokens: 700,
    reasoningEffort: 'low',
  });

  const json = extrairJsonObjeto(resposta.texto);

  if (!json) {
    throw new Error('A OpenAI não retornou uma decisão de ação válida.');
  }

  const acoes = new Set([
    'texto',
    'imagem',
    'editar_imagem',
    'fora_escopo',
  ]);

  const acao = String(json.acao || '').trim().toLowerCase();

  if (!acoes.has(acao)) {
    throw new Error(`Ação inválida retornada pela OpenAI: ${acao || '(vazia)'}`);
  }

  return {
    acao,
    promptVisual: limitarTextoPorCaracteres(json.promptVisual || '', 3000),
    motivoCurto: limitarTextoPorCaracteres(json.motivoCurto || '', 300),
  };
}

// ----------------------------------------------------------------
// OPENAI RESPONSES API - GERAÇÃO / EDIÇÃO DE IMAGEM
// ----------------------------------------------------------------

function extrairImagemOpenAI(dados) {
  const saidas = Array.isArray(dados?.output) ? dados.output : [];

  for (const item of saidas) {
    if (item?.type === 'image_generation_call') {
      const base64 = String(item?.result || '').trim();
      if (base64) {
        return {
          imagemBase64: base64,
          mimeType: 'image/png',
          imageCallId: textoSeguro(item?.id, 300),
        };
      }
    }
  }

  return null;
}

function montarInputVisual({
  promptVisual,
  imagens = [],
  historico = [],
  editando = false,
}) {
  const contexto = historicoEmTexto(historico, 10);

  const instrucao = editando
    ? `Edite a imagem de referência conforme o pedido. Preserve rigorosamente tudo
que não foi solicitado para mudar: identidade do ambiente/construção, geometria,
composição, enquadramento, materiais, proporções, aberturas, iluminação e objetos.
Faça somente as alterações pedidas, salvo adaptação fisicamente indispensável.`
    : `Crie uma imagem nova relacionada à construção civil. Respeite integralmente
o pedido e as proporções plausíveis. Quando o pedido exigir realismo, produza
fotografia arquitetônica fotorrealista, em escala real, com materiais reais e
iluminação natural, evitando aparência de maquete ou brinquedo.`;

  const texto = [
    instrucao,
    contexto ? `CONTEXTO RECENTE:\n${contexto}` : '',
    `PEDIDO VISUAL:\n${limitarTextoPorCaracteres(promptVisual, 4000)}`,
  ].filter(Boolean).join('\n\n');

  const content = [{
    type: 'input_text',
    text: texto,
  }];

  for (const imagem of imagens.slice(0, 3)) {
    content.push({
      type: 'input_image',
      image_url: dataUrlArquivo(imagem),
    });
  }

  return [{
    role: 'user',
    content,
  }];
}

async function gerarOuEditarImagemOpenAI({
  promptVisual,
  imagens = [],
  historico = [],
  previousResponseId = '',
}) {
  const referencias = Array.isArray(imagens) ? imagens.slice(0, 3) : [];
  const editando = referencias.length > 0;

  const corpo = {
    model: OPENAI_MAIN_MODEL,
    instructions: INSTRUCAO_SISTEMA,
    input: montarInputVisual({
      promptVisual,
      imagens: referencias,
      historico,
      editando,
    }),
    tools: [{
      type: 'image_generation',
      model: OPENAI_IMAGE_MODEL,
      quality: OPENAI_IMAGE_QUALITY,
      size: '1024x1024',
      action: editando ? 'edit' : 'generate',
    }],
    tool_choice: {
      type: 'image_generation',
    },
    reasoning: {
      effort: 'low',
    },
  };

  // previous_response_id melhora continuidade quando o Flutter passar esse campo.
  // A imagem em bytes continua sendo aceita como fallback e para compatibilidade.
  if (previousResponseId) {
    corpo.previous_response_id = previousResponseId;
  }

  logInfo(editando ? 'openai_editar_imagem' : 'openai_gerar_imagem', {
    modeloPrincipal: OPENAI_MAIN_MODEL,
    modeloImagem: OPENAI_IMAGE_MODEL,
    qualidade: OPENAI_IMAGE_QUALITY,
    referencias: referencias.length,
    temPreviousResponseId: Boolean(previousResponseId),
  });

  const { data } = await fetchJson(
    'https://api.openai.com/v1/responses',
    {
      method: 'POST',
      headers: headersOpenAI(),
      body: JSON.stringify(corpo),
    },
    TIMEOUT_IMAGEM_MS
  );

  const imagem = extrairImagemOpenAI(data);

  if (!imagem) {
    const texto = extrairTextoOpenAI(data);
    throw new Error(
      texto
        ? `A OpenAI não gerou a imagem. Resposta: ${limitarTextoPorCaracteres(texto, 500)}`
        : 'A OpenAI não retornou uma imagem utilizável.'
    );
  }

  return {
    ...imagem,
    responseId: textoSeguro(data?.id, 300),
    modelo: OPENAI_IMAGE_MODEL,
    qualidade: OPENAI_IMAGE_QUALITY,
    tamanho: '1024x1024',
  };
}

// ----------------------------------------------------------------
// RESPOSTA TEXTUAL DA JISA - 100% OPENAI
// ----------------------------------------------------------------

async function responderTextoJisa({
  mensagem,
  historico = [],
  arquivos = [],
}) {
  const resposta = await chamarOpenAITexto({
    mensagem:
      textoSeguro(mensagem, 12000) ||
      (arquivos.length ? 'Analise os arquivos enviados.' : 'Olá'),
    historico,
    arquivos,
    systemInstruction: INSTRUCAO_SISTEMA,
    maxOutputTokens: 2200,
    reasoningEffort: 'low',
  });

  return {
    texto: limparArtefatosResposta(resposta.texto),
    responseId: resposta.responseId,
  };
}

// ----------------------------------------------------------------
// PROCESSAMENTO CENTRAL
// ----------------------------------------------------------------

async function processarPedido({
  mensagem,
  historico,
  arquivos,
  imagemAnterior,
  previousResponseId,
  forcarFluxoVisual = false,
}) {
  const mensagemLimpa = textoSeguro(mensagem, 12000);
  const historicoLimpo = normalizarHistorico(historico);
  const arquivosLimpos = validarArquivos(arquivos);
  const imagemAnteriorLimpa = imagemAnterior
    ? validarArquivos([imagemAnterior])[0]
    : null;

  const previousResponseIdLimpo = textoSeguro(previousResponseId, 300);

  if (imagemAnteriorLimpa && !imagemAnteriorLimpa.ehImagem) {
    const erro = new Error('A memória visual anterior precisa ser uma imagem.');
    erro.statusCode = 400;
    throw erro;
  }

  if (!mensagemLimpa && arquivosLimpos.length === 0) {
    const erro = new Error('Envie uma mensagem ou pelo menos um arquivo.');
    erro.statusCode = 400;
    throw erro;
  }

  const decisao = await decidirAcaoJisa({
    mensagem: mensagemLimpa,
    historico: historicoLimpo,
    arquivos: arquivosLimpos,
    forcarImagem: forcarFluxoVisual,
    temImagemAnteriorDisponivel: Boolean(imagemAnteriorLimpa),
  });

  logInfo('jisa_decisao', {
    provedor: 'OpenAI',
    acao: decisao.acao,
    arquivos: arquivosLimpos.length,
    imagens: arquivosLimpos.filter((a) => a.ehImagem).length,
  });

  if (decisao.acao === 'fora_escopo') {
    return {
      ok: true,
      tipo: 'texto',
      acao: 'fora_escopo',
      resposta: RESPOSTA_FORA_ESCOPO,
    };
  }

  if (decisao.acao === 'texto') {
    const resposta = await responderTextoJisa({
      mensagem: mensagemLimpa,
      historico: historicoLimpo,
      arquivos: arquivosLimpos,
    });

    return {
      ok: true,
      tipo: 'texto',
      acao: 'texto',
      resposta: resposta.texto,
      responseId: resposta.responseId,
    };
  }

  if (decisao.acao === 'editar_imagem') {
    const imagensEnviadas = arquivosLimpos.filter((arquivo) => arquivo.ehImagem);
    const imagens = imagensEnviadas.length > 0
      ? imagensEnviadas
      : imagemAnteriorLimpa
        ? [imagemAnteriorLimpa]
        : [];

    // Se temos previous_response_id, a OpenAI pode continuar a imagem do turno
    // anterior mesmo sem bytes. Se não temos nenhum dos dois, não há referência.
    if (imagens.length === 0 && !previousResponseIdLimpo) {
      const erro = new Error(
        'Não encontrei a imagem anterior para continuar a edição.'
      );
      erro.statusCode = 400;
      throw erro;
    }

    const imagem = await gerarOuEditarImagemOpenAI({
      promptVisual:
        decisao.promptVisual ||
        mensagemLimpa ||
        'Edite a imagem conforme o contexto da conversa.',
      imagens,
      historico: historicoLimpo,
      previousResponseId: previousResponseIdLimpo,
    });

    return {
      ok: true,
      tipo: 'imagem',
      acao: 'editar_imagem',
      resposta: 'Imagem atualizada pela Jisa.',
      imagemBase64: imagem.imagemBase64,
      mimeType: imagem.mimeType,
      responseId: imagem.responseId,
      modeloImagem: imagem.modelo,
      qualidade: imagem.qualidade,
      tamanho: imagem.tamanho,
    };
  }

  const promptVisual =
    decisao.promptVisual ||
    limitarTextoPorCaracteres(mensagemLimpa, 3000);

  const imagem = await gerarOuEditarImagemOpenAI({
    promptVisual,
    imagens: [],
    historico: historicoLimpo,
    previousResponseId: '',
  });

  return {
    ok: true,
    tipo: 'imagem',
    acao: 'imagem',
    resposta: 'Imagem criada pela Jisa.',
    imagemBase64: imagem.imagemBase64,
    mimeType: imagem.mimeType,
    responseId: imagem.responseId,
    modeloImagem: imagem.modelo,
    qualidade: imagem.qualidade,
    tamanho: imagem.tamanho,
  };
}

// ----------------------------------------------------------------
// CORS / ROTAS
// ----------------------------------------------------------------

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization'
  );
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, OPTIONS'
  );

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

app.get('/', (_req, res) => {
  res.status(200).json({
    ok: true,
    servico: 'Ache Obra - Jisa IA',
    especialidade: 'Construção civil',
    status: 'online',
    provedorIA: 'OpenAI',
  });
});

app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    servico: 'acheobra-ai-backend',
    jisa: 'online',
    cerebro: 'OpenAI',
    geradorImagem: 'OpenAI',
    configuracao: {
      openai: Boolean(OPENAI_API_KEY),
      modeloPrincipal: OPENAI_MAIN_MODEL,
      modeloImagem: OPENAI_IMAGE_MODEL,
      qualidadeImagem: OPENAI_IMAGE_QUALITY,
      respostas: 'OpenAI Responses API',
    },
  });
});

// ----------------------------------------------------------------
// ENDPOINT UNIFICADO - RECOMENDADO
// ----------------------------------------------------------------

app.post('/ia/processar', async (req, res) => {
  const inicio = Date.now();

  try {
    const resultado = await processarPedido({
      mensagem: req.body?.mensagem,
      historico: req.body?.historico,
      arquivos: req.body?.arquivos,
      imagemAnterior: req.body?.imagemAnterior,
      previousResponseId:
        req.body?.previousResponseId || req.body?.responseIdAnterior,
      forcarFluxoVisual: false,
    });

    logInfo('ia_processar_ok', {
      provedor: 'OpenAI',
      acao: resultado.acao,
      duracaoMs: Date.now() - inicio,
    });

    return res.status(200).json(resultado);
  } catch (erro) {
    return responderErroHttp(res, erro, 'ia_processar', inicio);
  }
});

// ----------------------------------------------------------------
// COMPATIBILIDADE - ENDPOINT DE TEXTO EXISTENTE
// ----------------------------------------------------------------

app.post('/ia/perguntar', async (req, res) => {
  const inicio = Date.now();

  try {
    const resultado = await processarPedido({
      mensagem: req.body?.mensagem,
      historico: req.body?.historico,
      arquivos: req.body?.arquivos,
      imagemAnterior: req.body?.imagemAnterior,
      previousResponseId:
        req.body?.previousResponseId || req.body?.responseIdAnterior,
      forcarFluxoVisual: false,
    });

    logInfo('ia_perguntar_ok', {
      provedor: 'OpenAI',
      acao: resultado.acao,
      duracaoMs: Date.now() - inicio,
    });

    return res.status(200).json(resultado);
  } catch (erro) {
    return responderErroHttp(res, erro, 'ia_perguntar', inicio);
  }
});

// ----------------------------------------------------------------
// COMPATIBILIDADE - ENDPOINT VISUAL EXISTENTE
// ----------------------------------------------------------------

app.post('/ia/gerar-imagem', async (req, res) => {
  const inicio = Date.now();

  try {
    const mensagem =
      textoSeguro(req.body?.mensagemAtual, 12000) ||
      textoSeguro(req.body?.mensagem, 12000) ||
      textoSeguro(req.body?.prompt, 12000);

    const resultado = await processarPedido({
      mensagem,
      historico: req.body?.historico,
      arquivos: req.body?.arquivos,
      imagemAnterior: req.body?.imagemAnterior,
      previousResponseId:
        req.body?.previousResponseId || req.body?.responseIdAnterior,
      forcarFluxoVisual: true,
    });

    logInfo('ia_gerar_imagem_ok', {
      provedor: 'OpenAI',
      acao: resultado.acao,
      duracaoMs: Date.now() - inicio,
    });

    return res.status(200).json(resultado);
  } catch (erro) {
    return responderErroHttp(res, erro, 'ia_gerar_imagem', inicio);
  }
});

// ----------------------------------------------------------------
// ERROS
// ----------------------------------------------------------------

function responderErroHttp(res, erro, evento, inicio) {
  logErro(evento, erro, {
    duracaoMs: Date.now() - inicio,
  });

  if (erro?.name === 'AbortError') {
    return res.status(504).json({
      ok: false,
      erro:
        'O serviço demorou mais que o esperado para responder. Tente novamente.',
    });
  }

  const statusOriginal = Number(erro?.statusCode || 0);

  if (statusOriginal === 400 || statusOriginal === 413) {
    return res.status(statusOriginal).json({
      ok: false,
      erro: textoSeguro(erro.message, 700),
    });
  }

  if (statusOriginal === 429) {
    return res.status(429).json({
      ok: false,
      erro:
        'A Jisa está recebendo muitas solicitações neste momento. Aguarde um pouco e tente novamente.',
    });
  }

  if (statusOriginal === 401 || statusOriginal === 403) {
    return res.status(503).json({
      ok: false,
      erro:
        'Há um problema interno de autenticação do serviço de inteligência artificial.',
    });
  }

  return res.status(500).json({
    ok: false,
    erro:
      'Ocorreu um problema interno ao processar a solicitação da Jisa.',
  });
}

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    erro: 'Rota não encontrada.',
  });
});

app.use((erro, _req, res, _next) => {
  logErro('express_erro', erro);

  if (erro?.type === 'entity.too.large') {
    return res.status(413).json({
      ok: false,
      erro: 'A solicitação enviada é grande demais.',
    });
  }

  if (erro instanceof SyntaxError) {
    return res.status(400).json({
      ok: false,
      erro: 'O JSON enviado é inválido.',
    });
  }

  return res.status(500).json({
    ok: false,
    erro: 'Erro interno do servidor.',
  });
});

// ----------------------------------------------------------------
// INICIALIZAÇÃO
// ----------------------------------------------------------------

app.listen(PORT, '0.0.0.0', () => {
  logInfo('servidor_iniciado', {
    porta: PORT,
    especialidade: 'construcao_civil',
    provedor: 'OpenAI',
    cerebro: OPENAI_MAIN_MODEL,
    modeloImagem: OPENAI_IMAGE_MODEL,
    qualidadeImagem: OPENAI_IMAGE_QUALITY,
  });
});

export default app;
