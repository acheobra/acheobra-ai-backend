/**
 * ================================================================
 * ACHE OBRA - JISA IA - BACKEND
 * server_ia.js
 * ================================================================
 *
 * Arquitetura:
 *   Flutter -> este servidor -> Gemini (cérebro/orquestrador)
 *                            -> Cloudflare FLUX (imagem nova)
 *                            -> Gemini Image (edição com referência)
 *
 * Variáveis de ambiente esperadas no Render:
 *   GEMINI_API_KEY
 *   GEMINI_FALLBACK_MODEL
 *
 * O servidor mantém compatibilidade com:
 *   POST /ia/perguntar
 *   POST /ia/gerar-imagem
 *
 * E oferece o endpoint unificado recomendado:
 *   POST /ia/processar
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

const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || '').trim();
const GEMINI_FALLBACK_MODEL = String(
  process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.8-flash'
).trim();

const GEMINI_MAIN_MODEL = String(
  process.env.GEMINI_MAIN_MODEL || 'gemini-3.5-flash-lite'
).trim();

const GEMINI_IMAGE_MODEL = String(
  process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image'
).trim();

const MAX_HISTORICO = 14;
const MAX_ARQUIVOS = 5;
const MAX_ARQUIVO_BYTES = 18 * 1024 * 1024;
const TIMEOUT_GEMINI_MS = 65000;
const TIMEOUT_IMAGEM_MS = 100000;

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

// ----------------------------------------------------------------
// UTILITÁRIOS GERAIS
// ----------------------------------------------------------------

function logInfo(evento, dados = {}) {
  try {
    console.log(
      JSON.stringify({
        nivel: 'INFO',
        evento,
        ...dados,
        horario: new Date().toISOString(),
      })
    );
  } catch (_) {
    console.log(`[INFO] ${evento}`);
  }
}

function logErro(evento, erro, dados = {}) {
  const mensagem =
    erro instanceof Error ? erro.message : String(erro || 'Erro desconhecido');

  try {
    console.error(
      JSON.stringify({
        nivel: 'ERRO',
        evento,
        mensagem,
        ...dados,
        horario: new Date().toISOString(),
      })
    );
  } catch (_) {
    console.error(`[ERRO] ${evento}: ${mensagem}`);
  }
}

function textoSeguro(valor, limite = 12000) {
  if (valor === null || valor === undefined) return '';
  const texto = String(valor).trim();
  if (texto.length <= limite) return texto;
  return texto.slice(0, limite);
}

function limitarTextoPorCaracteres(texto, limite) {
  const valor = String(texto || '').trim();
  if (valor.length <= limite) return valor;
  return valor.slice(0, limite).trim();
}

// Remove artefatos de formatação que eventualmente podem vir na resposta
// textual do modelo, como o marcador literal "$1" antes de itens de lista.
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

  const extensao = String(nome || '')
    .toLowerCase()
    .split('.')
    .pop();

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
    docx:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx:
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
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
          ? 'model'
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
      const papel = item.role === 'model' ? 'Jisa' : 'Usuário';
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
        `HTTP ${resposta.status}: ${limitarTextoPorCaracteres(detalhe, 1000)}`
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

// ----------------------------------------------------------------
// GEMINI - TEXTO / CÉREBRO
// ----------------------------------------------------------------

function urlGemini(modelo) {
  return (
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(modelo) +
    ':generateContent?key=' +
    encodeURIComponent(GEMINI_API_KEY)
  );
}

function montarConteudosGemini({
  mensagem,
  historico,
  arquivos = [],
  instrucaoExtra = '',
}) {
  const conteudos = [];

  for (const item of normalizarHistorico(historico)) {
    conteudos.push({
      role: item.role,
      parts: [{ text: item.content }],
    });
  }

  const partesAtuais = [];

  const textoAtual =
    textoSeguro(mensagem, 12000) ||
    (arquivos.length > 0 ? 'Analise os arquivos enviados.' : '');

  if (textoAtual) {
    partesAtuais.push({
      text: instrucaoExtra
        ? `${instrucaoExtra}\n\nPEDIDO ATUAL DO USUÁRIO:\n${textoAtual}`
        : textoAtual,
    });
  }

  for (const arquivo of arquivos) {
    partesAtuais.push({
      inlineData: {
        mimeType: arquivo.mimeType,
        data: arquivo.base64,
      },
    });
  }

  if (partesAtuais.length > 0) {
    conteudos.push({
      role: 'user',
      parts: partesAtuais,
    });
  }

  return conteudos;
}

function extrairTextoGemini(dados) {
  const candidatos = Array.isArray(dados?.candidates) ? dados.candidates : [];

  for (const candidato of candidatos) {
    const partes = candidato?.content?.parts;

    if (!Array.isArray(partes)) continue;

    const textos = partes
      .map((parte) => (typeof parte?.text === 'string' ? parte.text : ''))
      .filter(Boolean);

    if (textos.length > 0) {
      return textos.join('\n').trim();
    }
  }

  return '';
}

async function chamarGeminiComModelo({
  modelo,
  mensagem,
  historico = [],
  arquivos = [],
  systemInstruction = INSTRUCAO_SISTEMA,
  instrucaoExtra = '',
  temperature = 0.35,
  maxOutputTokens = 1800,
}) {
  if (!GEMINI_API_KEY) {
    const erro = new Error('GEMINI_API_KEY não está configurada no Render.');
    erro.statusCode = 503;
    throw erro;
  }

  const corpo = {
    systemInstruction: {
      parts: [{ text: systemInstruction }],
    },
    contents: montarConteudosGemini({
      mensagem,
      historico,
      arquivos,
      instrucaoExtra,
    }),
    generationConfig: {
      temperature,
      maxOutputTokens,
    },
  };

  const { data } = await fetchJson(
    urlGemini(modelo),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(corpo),
    },
    TIMEOUT_GEMINI_MS
  );

  const texto = extrairTextoGemini(data);

  if (!texto) {
    const motivo =
      data?.candidates?.[0]?.finishReason ||
      data?.promptFeedback?.blockReason ||
      'sem conteúdo';

    throw new Error(`O Gemini não retornou texto utilizável (${motivo}).`);
  }

  return texto;
}

async function chamarGeminiTexto(opcoes) {
  try {
    return await chamarGeminiComModelo({
      ...opcoes,
      modelo: GEMINI_MAIN_MODEL,
    });
  } catch (erroPrincipal) {
    logErro('gemini_modelo_principal_falhou', erroPrincipal, {
      modelo: GEMINI_MAIN_MODEL,
    });

    if (
      !GEMINI_FALLBACK_MODEL ||
      GEMINI_FALLBACK_MODEL === GEMINI_MAIN_MODEL
    ) {
      throw erroPrincipal;
    }

    return chamarGeminiComModelo({
      ...opcoes,
      modelo: GEMINI_FALLBACK_MODEL,
    });
  }
}

// ----------------------------------------------------------------
// GEMINI - ORQUESTRADOR
// ----------------------------------------------------------------

const INSTRUCAO_ORQUESTRADOR = `
Você é o cérebro/orquestrador da Jisa, assistente do Ache Obra.

A Jisa é especialista EXCLUSIVAMENTE em construção civil.
Interprete semanticamente o pedido e o contexto. Não use correspondência literal
de palavras como critério principal.

Saudações, agradecimentos, despedidas e conversa social curta são permitidos.

Classifique o pedido atual em UMA ação:
- "texto": pergunta, conversa, análise, cálculo, orientação ou análise de anexos.
- "imagem": criar/gerar uma NOVA imagem visual relacionada à construção civil.
- "editar_imagem": modificar a imagem enviada agora OU continuar/modificar a última imagem gerada pela Jisa quando ela estiver disponível como memória visual.
- "fora_escopo": pedido claramente fora de construção civil, exceto interação social.

REGRAS IMPORTANTES:
- "crie uma casa com um cachorro no quintal" é construção e pode ser "imagem".
- "crie um dragão" é "fora_escopo".
- Se o usuário enviou uma imagem apenas para analisar, a ação é "texto".
- Se enviou uma imagem e pediu para alterar visualmente, é "editar_imagem".
- Se existe última imagem gerada disponível e o pedido continua aquela imagem (ex.: "coloque uma garagem", "troque o telhado", "mais realista", "agora por dentro"), use "editar_imagem".
- Só use "imagem" com uma imagem anterior disponível quando o usuário estiver pedindo claramente uma criação nova e independente.
- Use o histórico para compreender "ela", "essa casa", "a anterior",
  "mais realista", "agora coloque garagem", "mostre por dentro" etc.
- Não invente intenção visual se o usuário só pediu explicação textual.
- Para "imagem", crie também um promptVisual compacto, completo e autocontido.
- Para "editar_imagem", crie um promptVisual objetivo dizendo o que preservar
  e o que modificar.
- O promptVisual deve estar em português, ter no máximo 1500 caracteres e
  preservar os requisitos relevantes já definidos.
- Se a ação for "texto" ou "fora_escopo", promptVisual deve ser "".

Responda SOMENTE JSON válido, sem Markdown:
{
  "acao": "texto|imagem|editar_imagem|fora_escopo",
  "promptVisual": "",
  "motivoCurto": ""
}
`.trim();

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
- existe indicação de imagem gerada anteriormente no histórico: ${
    temImagemAnterior ? 'sim' : 'não'
  }
- a última imagem gerada está disponível em bytes para edição: ${
    temImagemAnteriorDisponivel ? 'sim' : 'não'
  }

COMPATIBILIDADE:
- endpoint visual solicitado explicitamente pelo aplicativo: ${
    forcarImagem ? 'sim' : 'não'
  }

Mesmo quando o endpoint visual foi solicitado, respeite o escopo da construção civil.
`.trim();

  const resposta = await chamarGeminiTexto({
    mensagem: resumo,
    historico: [],
    arquivos: [],
    systemInstruction: INSTRUCAO_ORQUESTRADOR,
    temperature: 0.1,
    maxOutputTokens: 500,
  });

  const json = extrairJsonObjeto(resposta);

  if (!json) {
    throw new Error('O Gemini não retornou uma decisão de ação válida.');
  }

  const acoes = new Set([
    'texto',
    'imagem',
    'editar_imagem',
    'fora_escopo',
  ]);

  let acao = String(json.acao || '').trim().toLowerCase();

  if (!acoes.has(acao)) {
    throw new Error(`Ação inválida retornada pelo Gemini: ${acao || '(vazia)'}`);
  }

  if (acao === 'imagem' && documentos.length > 0 && imagens.length === 0) {
    // O orquestrador pode interpretar um documento como base para imagem, mas o
    // endpoint visual do FLUX não lê documentos. Mantemos o cérebro no Gemini:
    // o documento será analisado em texto e a Jisa poderá orientar o usuário.
    acao = 'texto';
  }

  return {
    acao,
    promptVisual: limitarTextoPorCaracteres(json.promptVisual || '', 1500),
    motivoCurto: limitarTextoPorCaracteres(json.motivoCurto || '', 300),
  };
}

// ----------------------------------------------------------------
// GEMINI IMAGE - GERAÇÃO E EDIÇÃO DE IMAGENS
// ----------------------------------------------------------------


function extrairImagemGemini(dados) {
  const candidatos = Array.isArray(dados?.candidates) ? dados.candidates : [];

  for (const candidato of candidatos) {
    const partes = candidato?.content?.parts;

    if (!Array.isArray(partes)) continue;

    for (const parte of partes) {
      const inline = parte?.inlineData || parte?.inline_data;

      if (inline?.data) {
        return {
          imagemBase64: inline.data,
          mimeType: inline.mimeType || inline.mime_type || 'image/png',
        };
      }
    }
  }

  return null;
}

async function gerarOuEditarImagemGemini({ promptVisual, imagens = [] }) {
  if (!GEMINI_API_KEY) {
    const erro = new Error('GEMINI_API_KEY não está configurada no Render.');
    erro.statusCode = 503;
    throw erro;
  }

  const referencias = Array.isArray(imagens) ? imagens.slice(0, 3) : [];
  const editando = referencias.length > 0;

  const partes = [
    {
      text: editando
        ? 'Edite a imagem de referência conforme o pedido abaixo. Preserve a identidade visual da construção, composição, materiais, proporções, fachada, telhado, aberturas e demais elementos que não foram solicitados para mudar. Faça somente as alterações pedidas, salvo quando uma adaptação for indispensável para coerência física. O resultado deve permanecer coerente com construção civil.\n\n' + limitarTextoPorCaracteres(promptVisual, 3000)
        : 'Crie uma imagem nova conforme o pedido abaixo. O resultado deve ser coerente com construção civil, com proporções plausíveis e respeitando todos os requisitos descritos. Quando o pedido exigir realismo, use aparência fotográfica arquitetônica realista, materiais reais, escala real e iluminação natural, sem aparência de maquete.\n\n' + limitarTextoPorCaracteres(promptVisual, 3000),
    },
  ];

  for (const imagem of referencias) {
    partes.push({
      inlineData: {
        mimeType: imagem.mimeType,
        data: imagem.base64,
      },
    });
  }

  const corpo = {
    contents: [{ role: 'user', parts: partes }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
    },
  };

  logInfo(editando ? 'gemini_editar_imagem' : 'gemini_gerar_imagem', {
    modelo: GEMINI_IMAGE_MODEL,
    referencias: referencias.length,
  });

  const { data } = await fetchJson(
    urlGemini(GEMINI_IMAGE_MODEL),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
    },
    TIMEOUT_IMAGEM_MS
  );

  const imagem = extrairImagemGemini(data);

  if (!imagem) {
    const motivo =
      data?.candidates?.[0]?.finishReason ||
      data?.promptFeedback?.blockReason ||
      'sem imagem';
    throw new Error(`O Gemini não retornou uma imagem (${motivo}).`);
  }

  return imagem;
}

// ----------------------------------------------------------------
// RESPOSTA TEXTUAL DA JISA
// ----------------------------------------------------------------

async function responderTextoJisa({
  mensagem,
  historico = [],
  arquivos = [],
}) {
  const resposta = await chamarGeminiTexto({
    mensagem:
      textoSeguro(mensagem, 12000) ||
      (arquivos.length ? 'Analise os arquivos enviados.' : 'Olá'),
    historico,
    arquivos,
    systemInstruction: INSTRUCAO_SISTEMA,
    temperature: 0.35,
    maxOutputTokens: 1800,
  });

  return limparArtefatosResposta(resposta);
}

// ----------------------------------------------------------------
// PROCESSAMENTO CENTRAL
// ----------------------------------------------------------------

async function processarPedido({
  mensagem,
  historico,
  arquivos,
  imagemAnterior,
  forcarFluxoVisual = false,
}) {
  const mensagemLimpa = textoSeguro(mensagem, 12000);
  const historicoLimpo = normalizarHistorico(historico);
  const arquivosLimpos = validarArquivos(arquivos);
  const imagemAnteriorLimpa = imagemAnterior
    ? validarArquivos([imagemAnterior])[0]
    : null;

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
      resposta,
    };
  }

  if (decisao.acao === 'editar_imagem') {
    const imagensEnviadas = arquivosLimpos.filter((arquivo) => arquivo.ehImagem);
    const imagens = imagensEnviadas.length > 0
      ? imagensEnviadas
      : imagemAnteriorLimpa
        ? [imagemAnteriorLimpa]
        : [];

    if (imagens.length === 0) {
      const erro = new Error('Não encontrei a imagem anterior para continuar a edição.');
      erro.statusCode = 400;
      throw erro;
    }

    const imagem = await gerarOuEditarImagemGemini({
      promptVisual:
        decisao.promptVisual ||
        mensagemLimpa ||
        'Edite a imagem conforme o contexto da conversa.',
      imagens,
    });

    return {
      ok: true,
      tipo: 'imagem',
      acao: 'editar_imagem',
      resposta: 'Imagem atualizada pela Jisa.',
      imagemBase64: imagem.imagemBase64,
      mimeType: imagem.mimeType,
    };
  }

  const promptVisual =
    decisao.promptVisual ||
    limitarTextoPorCaracteres(mensagemLimpa, 1500);

  const imagem = await gerarOuEditarImagemGemini({
    promptVisual,
    imagens: [],
  });

  return {
    ok: true,
    tipo: 'imagem',
    acao: 'imagem',
    resposta: 'Imagem criada pela Jisa.',
    imagemBase64: imagem.imagemBase64,
    mimeType: imagem.mimeType,
  };
}

// ----------------------------------------------------------------
// CORS / ROTAS BÁSICAS
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
  });
});

app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    servico: 'acheobra-ai-backend',
    jisa: 'online',
    cerebro: 'Gemini',
    geradorImagem: 'Gemini',
    configuracao: {
      gemini: Boolean(GEMINI_API_KEY),
      modeloPrincipal: GEMINI_MAIN_MODEL,
      modeloFallback: GEMINI_FALLBACK_MODEL,
      modeloImagem: GEMINI_IMAGE_MODEL,
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
      forcarFluxoVisual: false,
    });

    logInfo('ia_processar_ok', {
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
    const mensagem = req.body?.mensagem;
    const historico = req.body?.historico;
    const arquivos = req.body?.arquivos;

    // Mesmo no endpoint antigo, o Gemini continua sendo o cérebro.
    // Se identificar que o pedido é visual, devolvemos uma indicação clara
    // para o app novo usar /ia/processar. O ia_page atual ainda continuará
    // funcionando para pedidos textuais enquanto fazemos a migração.
    const arquivosLimpos = validarArquivos(arquivos);
    const decisao = await decidirAcaoJisa({
      mensagem: textoSeguro(mensagem, 12000),
      historico,
      arquivos: arquivosLimpos,
      forcarImagem: false,
      temImagemAnteriorDisponivel: Boolean(req.body?.imagemAnterior),
    });

    if (decisao.acao === 'fora_escopo') {
      return res.status(200).json({
        ok: true,
        resposta: RESPOSTA_FORA_ESCOPO,
        acao: 'fora_escopo',
      });
    }

    if (decisao.acao === 'imagem' || decisao.acao === 'editar_imagem') {
      // Para manter compatibilidade inclusive com versões antigas do Flutter,
      // executamos a imagem aqui e retornamos os campos adicionais.
      const resultado = await processarPedido({
        mensagem,
        historico,
        arquivos,
        imagemAnterior: req.body?.imagemAnterior,
        forcarFluxoVisual: true,
      });

      return res.status(200).json(resultado);
    }

    const resposta = await responderTextoJisa({
      mensagem: textoSeguro(mensagem, 12000),
      historico: normalizarHistorico(historico),
      arquivos: arquivosLimpos,
    });

    logInfo('ia_perguntar_ok', {
      duracaoMs: Date.now() - inicio,
    });

    return res.status(200).json({
      ok: true,
      tipo: 'texto',
      acao: 'texto',
      resposta,
    });
  } catch (erro) {
    return responderErroHttp(res, erro, 'ia_perguntar', inicio);
  }
});

// ----------------------------------------------------------------
// COMPATIBILIDADE - ENDPOINT DE IMAGEM EXISTENTE
// ----------------------------------------------------------------

app.post('/ia/gerar-imagem', async (req, res) => {
  const inicio = Date.now();

  try {
    const mensagem =
      textoSeguro(req.body?.mensagemAtual, 12000) ||
      textoSeguro(req.body?.prompt, 12000);

    const resultado = await processarPedido({
      mensagem,
      historico: req.body?.historico,
      arquivos: req.body?.arquivos,
      imagemAnterior: req.body?.imagemAnterior,
      forcarFluxoVisual: true,
    });

    logInfo('ia_gerar_imagem_ok', {
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
      erro: textoSeguro(erro.message, 600),
    });
  }

  if (statusOriginal === 429) {
    return res.status(429).json({
      ok: false,
      erro:
        'A Jisa está recebendo muitas solicitações neste momento. Aguarde um pouco e tente novamente.',
    });
  }

  if (
    statusOriginal === 401 ||
    statusOriginal === 403
  ) {
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
    cerebro: 'Gemini',
    modeloPrincipal: GEMINI_MAIN_MODEL,
    modeloFallback: GEMINI_FALLBACK_MODEL,
    modeloImagem: GEMINI_IMAGE_MODEL,
  });
});

export default app;
