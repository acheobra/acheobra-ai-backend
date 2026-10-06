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
import dns from 'node:dns';

// Render/Node pode resolver hosts por IPv6 primeiro. Em algumas instâncias
// isso causa `fetch failed` mesmo com a URL correta. Priorizamos IPv4,
// mantendo fallback normal do Node.
try {
  dns.setDefaultResultOrder('ipv4first');
} catch (_) {}

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ extended: true, limit: '30mb' }));

// ----------------------------------------------------------------
// CONFIGURAÇÃO
// ----------------------------------------------------------------

const PORT = Number(process.env.PORT || 10000);

const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || '').trim();

// Supabase é usado somente no backend para autenticar o usuário,
// descobrir o plano ativo e controlar a franquia mensal de imagens.
// Use SUPABASE_SECRET_KEY (recomendado) ou, durante a migração,
// SUPABASE_SERVICE_ROLE_KEY. Nunca exponha essa chave no Flutter.
// URL canônica do projeto Supabase do Ache Obra.
// A variável do Render continua sendo aceita, mas o backend corrige
// automaticamente o hostname legado incorreto que causava ENOTFOUND.
const SUPABASE_PROJECT_REF = 'nqmullubdvzzrueocxhd';
const SUPABASE_URL_CANONICA = `https://${SUPABASE_PROJECT_REF}.supabase.co`;

function normalizarSupabaseUrl(valor) {
  let url = String(valor || '').trim();

  // Remove caminhos que possam ter sido colados por engano no Render.
  url = url
    .replace(/\/+$/, '')
    .replace(/\/rest\/v1\/?$/i, '')
    .replace(/\/auth\/v1\/?$/i, '');

  if (!url) return SUPABASE_URL_CANONICA;

  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    // Host incorreto observado nos logs do Render.
    if (host === 'nqmllubdvzzrueocxhd.supabase.co') {
      return SUPABASE_URL_CANONICA;
    }

    return `${parsed.protocol}//${parsed.host}`.replace(/\/+$/, '');
  } catch (_) {
    return SUPABASE_URL_CANONICA;
  }
}

const SUPABASE_URL = normalizarSupabaseUrl(process.env.SUPABASE_URL);
const SUPABASE_SECRET_KEY = String(
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  ''
).trim();

// Controle de franquia de imagens.
// O controle de franquia é obrigatório para qualquer geração/edição de imagem.
// Se SUPABASE_URL + chave secreta não estiverem configuradas no Render,
// a geração visual é bloqueada. Isso impede bypass do limite do plano.
const CONTROLE_IMAGENS_CONFIGURADO = Boolean(
  SUPABASE_URL && SUPABASE_SECRET_KEY
);

const TABELA_USUARIOS = 'tab_usuarios';
const TABELA_PLANOS = 'tab_planos';
const TABELA_PLANOS_MANUAIS = 'tab_planos_manuais';
const RPC_RESERVAR_IMAGEM_IA = 'reservar_imagem_ia';
const RPC_ESTORNAR_IMAGEM_IA = 'estornar_imagem_ia';

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
- Em cálculos, escreva números, unidades e fórmulas em texto simples.
- NUNCA use LaTeX, MathJax ou delimitadores matemáticos como $, $$, \( \), \[ \].
- Exemplos corretos: "300 × 0,05 = 15 m³" e "aproximadamente 24 m³ de areia".
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
Você é a Jisa, assistente de inteligência artificial do Ache Obra.

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
- Se a ação for "texto", RESPONDA também ao usuário no campo "resposta". Assim a
  mesma chamada serve para decidir e responder, evitando uma segunda chamada à IA.
- A resposta deve ser em português do Brasil, simples, objetiva, clara e prática.
- Em cálculos, use somente texto simples. NUNCA use LaTeX, MathJax, $, $$, \\( \\)
  ou \\[ \\]. Preserve números e unidades literalmente. Exemplo: 300 × 0,05 = 15 m³.
- Se a ação for "fora_escopo", deixe "resposta" vazia.
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
  "motivoCurto": "",
  "resposta": ""
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
  let valor = String(texto || '').trim();

  // Remove apenas DELIMITADORES de LaTeX/MathJax, preservando o conteúdo.
  // Isso evita artefatos visuais no Flutter sem apagar números/unidades.
  valor = valor
    .replace(/\\\[([\s\S]*?)\\\]/g, '$1')
    .replace(/\\\(([\s\S]*?)\\\)/g, '$1')
    .replace(/\$\$([\s\S]*?)\$\$/g, '$1')
    .replace(/\\times\b/g, '×')
    .replace(/\\cdot\b/g, '·')
    .replace(/\\approx\b/g, '≈')
    .replace(/\\text\{([^{}]*)\}/g, '$1')
    .replace(/\\mathrm\{([^{}]*)\}/g, '$1')
    .replace(/\\,|\\;|\\!/g, ' ');

  // Compatibilidade com respostas antigas que eventualmente tragam "$1"
  // isolado no início de uma linha. Não altera valores monetários no meio do texto.
  valor = valor.replace(/(^|\n)(\s*(?:[-*•]|\d+[.)])?\s*)\$1(?=\s)/g, '$1$2');

  return valor.trim();
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

function urlSeguraParaLog(url) {
  try {
    const u = new URL(String(url || ''));
    return `${u.origin}${u.pathname}`;
  } catch (_) {
    return limitarTextoPorCaracteres(String(url || ''), 300);
  }
}

function detalhesErroFetch(erro) {
  const causa = erro?.cause || null;
  return {
    nome: textoSeguro(erro?.name, 100),
    mensagem: textoSeguro(erro?.message, 500),
    causaNome: textoSeguro(causa?.name, 100),
    causaMensagem: textoSeguro(causa?.message, 500),
    causaCodigo: textoSeguro(causa?.code, 100),
    causaErrno: textoSeguro(causa?.errno, 100),
    causaSyscall: textoSeguro(causa?.syscall, 100),
    causaHostname: textoSeguro(causa?.hostname, 300),
  };
}

async function fetchJson(url, opcoes = {}, timeoutMs = 60000) {
  const controle = withTimeout(timeoutMs);
  const metodo = String(opcoes?.method || 'GET').toUpperCase();
  const urlLog = urlSeguraParaLog(url);

  try {
    let resposta;

    try {
      resposta = await fetch(url, {
        ...opcoes,
        signal: controle.signal,
      });
    } catch (erroFetch) {
      // Mantém o AbortError intacto para o tratamento de timeout existente.
      if (erroFetch?.name === 'AbortError') throw erroFetch;

      const diagnostico = detalhesErroFetch(erroFetch);
      logErro('fetch_rede_falhou', erroFetch, {
        metodo,
        url: urlLog,
        ...diagnostico,
      });

      const erro = new Error(
        `Falha de rede ao acessar ${urlLog}: ` +
        `${diagnostico.causaCodigo || diagnostico.causaMensagem || diagnostico.mensagem || 'fetch failed'}`
      );
      erro.statusCode = 503;
      erro.codigo = 'FALHA_REDE_EXTERNA';
      erro.fetchDiagnostico = diagnostico;
      throw erro;
    }

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
            dados?.message ||
            dados?.msg ||
            dados?.errors?.[0]?.message ||
            JSON.stringify(dados || {});

      const erro = new Error(
        `HTTP ${resposta.status}: ${limitarTextoPorCaracteres(detalhe, 1400)}`
      );
      erro.statusCode = resposta.status;
      erro.responseData = dados;
      erro.urlExterna = urlLog;
      erro.metodoExterno = metodo;
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
// SUPABASE - AUTENTICAÇÃO / PLANO / FRANQUIA DE IMAGENS DA JISA
// ----------------------------------------------------------------

function configuracaoSupabaseOk() {
  return CONTROLE_IMAGENS_CONFIGURADO;
}

function headersSupabaseAdmin(extras = {}) {
  if (!configuracaoSupabaseOk()) {
    const erro = new Error(
      'SUPABASE_URL e SUPABASE_SECRET_KEY não estão configuradas no Render.'
    );
    erro.statusCode = 503;
    throw erro;
  }

  return {
    apikey: SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    'Content-Type': 'application/json',
    ...extras,
  };
}

function extrairBearer(req) {
  const authorization = String(req?.headers?.authorization || '').trim();
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

async function autenticarUsuarioSupabase(req) {
  const token = extrairBearer(req);

  if (!token) {
    const erro = new Error(
      'Sua sessão não foi identificada. Entre novamente no Ache Obra e tente de novo.'
    );
    erro.statusCode = 401;
    erro.codigo = 'SESSAO_NAO_IDENTIFICADA';
    throw erro;
  }

  if (!configuracaoSupabaseOk()) {
    const erro = new Error(
      'O controle de imagens da Jisa ainda não está configurado no servidor.'
    );
    erro.statusCode = 503;
    throw erro;
  }

  let data;

  try {
    const resposta = await fetchJson(
      `${SUPABASE_URL}/auth/v1/user`,
      {
        method: 'GET',
        headers: {
          apikey: SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${token}`,
        },
      },
      15000
    );
    data = resposta.data;
  } catch (erro) {
    logErro('supabase_auth_usuario_falhou', erro, {
      etapa: 'auth_v1_user',
      supabaseHost: urlSeguraParaLog(SUPABASE_URL),
      statusExterno: Number(erro?.statusCode || 0) || undefined,
      codigoExterno: textoSeguro(erro?.codigo, 100) || undefined,
      fetchDiagnostico: erro?.fetchDiagnostico || undefined,
    });
    throw erro;
  }

  const usuarioId = textoSeguro(data?.id, 100);

  if (!usuarioId) {
    const erro = new Error('Não foi possível identificar o usuário autenticado.');
    erro.statusCode = 401;
    erro.codigo = 'USUARIO_NAO_IDENTIFICADO';
    throw erro;
  }

  return {
    id: usuarioId,
    email: textoSeguro(data?.email, 300),
  };
}

async function supabaseSelecionarUm(tabela, filtros, select) {
  const params = new URLSearchParams();
  params.set('select', select);

  for (const [campo, valor] of Object.entries(filtros || {})) {
    params.set(campo, `eq.${valor}`);
  }

  params.set('limit', '1');

  let data;

  try {
    const resposta = await fetchJson(
      `${SUPABASE_URL}/rest/v1/${encodeURIComponent(tabela)}?${params.toString()}`,
      {
        method: 'GET',
        headers: headersSupabaseAdmin({
          Accept: 'application/json',
        }),
      },
      15000
    );
    data = resposta.data;
  } catch (erro) {
    logErro('supabase_select_falhou', erro, {
      etapa: 'rest_select',
      tabela: textoSeguro(tabela, 100),
      statusExterno: Number(erro?.statusCode || 0) || undefined,
      codigoExterno: textoSeguro(erro?.codigo, 100) || undefined,
      fetchDiagnostico: erro?.fetchDiagnostico || undefined,
    });
    throw erro;
  }

  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

async function buscarPlanoImagemUsuario(usuarioId) {
  const usuario = await supabaseSelecionarUm(
    TABELA_USUARIOS,
    { id: usuarioId },
    'id,id_plano_atual,plano_id,nome_plano_ativo'
  );

  if (!usuario) {
    const erro = new Error(
      'Não foi encontrado o cadastro do usuário para verificar o plano da Jisa.'
    );
    erro.statusCode = 403;
    erro.codigo = 'CADASTRO_USUARIO_NAO_ENCONTRADO';
    throw erro;
  }

  const planoId = usuario.id_plano_atual ?? usuario.plano_id;

  if (planoId === null || planoId === undefined || String(planoId).trim() === '') {
    const erro = new Error(
      'Não foi possível identificar o plano ativo deste usuário.'
    );
    erro.statusCode = 403;
    erro.codigo = 'PLANO_NAO_IDENTIFICADO';
    throw erro;
  }

  const nomePlanoAtivo = textoSeguro(usuario.nome_plano_ativo, 200);
  const nomeNormalizado = nomePlanoAtivo
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  const nomesPlanosManuais = new Set([
    'teste',
    'cortesia',
    'parceria',
    'especial',
  ]);

  const ehPlanoManual = nomesPlanosManuais.has(nomeNormalizado);

  let plano = null;
  let origemPlano = ehPlanoManual ? 'manual' : 'normal';

  if (ehPlanoManual) {
    plano = await supabaseSelecionarUm(
      TABELA_PLANOS_MANUAIS,
      { id: planoId },
      'id,nome,limite_imagens_ia'
    );

    if (!plano) {
      plano = await supabaseSelecionarUm(
        TABELA_PLANOS,
        { id: planoId },
        'id,nome_plano,limite_imagens_ia'
      );
      if (plano) origemPlano = 'normal';
    }
  } else {
    plano = await supabaseSelecionarUm(
      TABELA_PLANOS,
      { id: planoId },
      'id,nome_plano,limite_imagens_ia'
    );

    if (!plano) {
      plano = await supabaseSelecionarUm(
        TABELA_PLANOS_MANUAIS,
        { id: planoId },
        'id,nome,limite_imagens_ia'
      );
      if (plano) origemPlano = 'manual';
    }
  }

  if (!plano) {
    logInfo('plano_ia_nao_encontrado', {
      usuarioId,
      planoId: String(planoId),
      nomePlanoAtivo,
      origemEsperada: ehPlanoManual ? 'manual' : 'normal',
    });

    const erro = new Error('O plano ativo do usuário não foi encontrado.');
    erro.statusCode = 403;
    erro.codigo = 'PLANO_NAO_ENCONTRADO';
    throw erro;
  }

  const limite = Math.max(
    0,
    Number.parseInt(plano.limite_imagens_ia, 10) || 0
  );

  const nomePlanoBanco =
    origemPlano === 'manual'
      ? plano.nome
      : plano.nome_plano;

  logInfo('plano_ia_identificado', {
    usuarioId,
    planoId: plano.id,
    origemPlano,
    nomePlano: textoSeguro(nomePlanoBanco || nomePlanoAtivo || 'Plano', 200),
    limiteImagensIa: limite,
  });

  return {
    usuarioId,
    planoId: plano.id,
    nomePlano: textoSeguro(
      nomePlanoBanco || nomePlanoAtivo || 'Plano',
      200
    ),
    limite,
    origemPlano,
  };
}

async function chamarRpcSupabase(nomeFuncao, corpo) {
  try {
    const { data } = await fetchJson(
      `${SUPABASE_URL}/rest/v1/rpc/${encodeURIComponent(nomeFuncao)}`,
      {
        method: 'POST',
        headers: headersSupabaseAdmin({
          Accept: 'application/json',
        }),
        body: JSON.stringify(corpo || {}),
      },
      15000
    );

    return data;
  } catch (erro) {
    logErro('supabase_rpc_falhou', erro, {
      etapa: 'rest_rpc',
      rpc: textoSeguro(nomeFuncao, 120),
      statusExterno: Number(erro?.statusCode || 0) || undefined,
      codigoExterno: textoSeguro(erro?.codigo, 100) || undefined,
      fetchDiagnostico: erro?.fetchDiagnostico || undefined,
    });
    throw erro;
  }
}

function normalizarRetornoFranquia(data, planoFallback = null) {
  const bruto = Array.isArray(data) ? data[0] : data;
  const valor =
    bruto && typeof bruto === 'object'
      ? bruto
      : {};

  const limite = Math.max(
    0,
    Number.parseInt(valor.limite ?? planoFallback?.limite ?? 0, 10) || 0
  );
  const utilizado = Math.max(
    0,
    Number.parseInt(valor.utilizado ?? valor.usado ?? 0, 10) || 0
  );
  const restante = Math.max(
    0,
    Number.parseInt(valor.restante ?? (limite - utilizado), 10) || 0
  );

  return {
    permitido: valor.permitido !== false && utilizado <= limite,
    limite,
    utilizado,
    restante,
    nomePlano: textoSeguro(
      valor.nome_plano || planoFallback?.nomePlano || 'Plano',
      200
    ),
    periodo: textoSeguro(valor.periodo, 20),
  };
}

async function reservarUsoImagemIa(req) {
  // FAIL CLOSED: imagem só pode ser gerada/editada depois de reservar franquia.
  // Sem Supabase configurado, nunca liberamos geração sem contabilização.
  if (!configuracaoSupabaseOk()) {
    const erro = new Error(
      'O controle de imagens da Jisa está temporariamente indisponível. Tente novamente em instantes.'
    );
    erro.statusCode = 503;
    erro.codigo = 'CONTROLE_IMAGENS_INDISPONIVEL';
    throw erro;
  }

  const usuario = await autenticarUsuarioSupabase(req);
  const plano = await buscarPlanoImagemUsuario(usuario.id);

  if (plano.limite <= 0) {
    const erro = new Error(
      `Seu plano ${plano.nomePlano} não possui imagens da Jisa IA disponíveis neste mês.`
    );
    erro.statusCode = 403;
    erro.codigo = 'LIMITE_IMAGENS_IA_ATINGIDO';
    erro.franquiaImagem = {
      permitido: false,
      limite: plano.limite,
      utilizado: 0,
      restante: 0,
      nomePlano: plano.nomePlano,
    };
    throw erro;
  }

  let data;

  try {
    data = await chamarRpcSupabase(RPC_RESERVAR_IMAGEM_IA, {
      p_usuario_id: usuario.id,
    });
  } catch (erroRpc) {
    // Erro de configuração do banco não deve liberar geração sem controle.
    logErro('ia_reserva_imagem_rpc', erroRpc, {
      usuarioId: usuario.id,
      planoId: plano.planoId,
    });

    const erro = new Error(
      'Não foi possível verificar sua franquia de imagens neste momento.'
    );
    erro.statusCode = 503;
    erro.codigo = 'CONTROLE_IMAGENS_INDISPONIVEL';
    throw erro;
  }

  const franquia = normalizarRetornoFranquia(data, plano);

  if (!franquia.permitido) {
    const erro = new Error(
      `Você atingiu o limite de ${franquia.limite} imagem(ns) da Jisa neste mês no plano ${franquia.nomePlano}. Adquira um plano com mais imagens para continuar gerando.`
    );
    erro.statusCode = 403;
    erro.codigo = 'LIMITE_IMAGENS_IA_ATINGIDO';
    erro.franquiaImagem = franquia;
    throw erro;
  }

  logInfo('ia_imagem_reservada', {
    usuarioId: usuario.id,
    planoId: plano.planoId,
    limite: franquia.limite,
    utilizado: franquia.utilizado,
    restante: franquia.restante,
  });

  return {
    usuario,
    plano,
    franquia,
  };
}

async function estornarUsoImagemIa(reserva, motivo = '') {
  const usuarioId = textoSeguro(reserva?.usuario?.id, 100);
  if (!usuarioId) return;

  try {
    const data = await chamarRpcSupabase(RPC_ESTORNAR_IMAGEM_IA, {
      p_usuario_id: usuarioId,
    });

    const franquia = normalizarRetornoFranquia(data, reserva?.plano);

    logInfo('ia_imagem_estornada', {
      usuarioId,
      motivo: textoSeguro(motivo, 300),
      limite: franquia.limite,
      utilizado: franquia.utilizado,
      restante: franquia.restante,
    });
  } catch (erro) {
    // Não mascara o erro original da OpenAI, mas deixa o problema explícito
    // no Render para correção administrativa.
    logErro('ia_estorno_imagem_falhou', erro, {
      usuarioId,
      motivo: textoSeguro(motivo, 300),
    });
  }
}

function anexarFranquiaImagem(resultado, reserva) {
  if (!resultado || !reserva?.franquia) return resultado;

  return {
    ...resultado,
    franquiaImagem: {
      limite: reserva.franquia.limite,
      utilizado: reserva.franquia.utilizado,
      restante: reserva.franquia.restante,
      nomePlano: reserva.franquia.nomePlano,
      periodo: reserva.franquia.periodo,
    },
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

  const inicioOpenAI = Date.now();

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

  logInfo('openai_texto_concluido', {
    modelo: OPENAI_MAIN_MODEL,
    duracaoMs: Date.now() - inicioOpenAI,
    caracteresResposta: texto.length,
  });

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
    maxOutputTokens: 2200,
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
    resposta: limparArtefatosResposta(json.resposta || ''),
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
  req,
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
    // Fluxo rápido: a mesma chamada que classificou já respondeu ao usuário.
    // Só fazemos uma segunda chamada se, excepcionalmente, vier resposta vazia.
    if (decisao.resposta) {
      return {
        ok: true,
        tipo: 'texto',
        acao: 'texto',
        resposta: decisao.resposta,
      };
    }

    logInfo('jisa_fallback_segunda_chamada_texto', {
      motivo: 'orquestrador_retornou_resposta_vazia',
    });

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

    const reserva = await reservarUsoImagemIa(req);

    try {
      const imagem = await gerarOuEditarImagemOpenAI({
        promptVisual:
          decisao.promptVisual ||
          mensagemLimpa ||
          'Edite a imagem conforme o contexto da conversa.',
        imagens,
        historico: historicoLimpo,
        previousResponseId: previousResponseIdLimpo,
      });

      return anexarFranquiaImagem({
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
      }, reserva);
    } catch (erro) {
      await estornarUsoImagemIa(reserva, erro?.message || 'Falha ao editar imagem');
      throw erro;
    }
  }

  const promptVisual =
    decisao.promptVisual ||
    limitarTextoPorCaracteres(mensagemLimpa, 3000);

  const reserva = await reservarUsoImagemIa(req);

  try {
    const imagem = await gerarOuEditarImagemOpenAI({
      promptVisual,
      imagens: [],
      historico: historicoLimpo,
      previousResponseId: '',
    });

    return anexarFranquiaImagem({
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
    }, reserva);
  } catch (erro) {
    await estornarUsoImagemIa(reserva, erro?.message || 'Falha ao gerar imagem');
    throw erro;
  }
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
      supabase: configuracaoSupabaseOk(),
      supabaseHost: SUPABASE_URL ? urlSeguraParaLog(SUPABASE_URL) : '',
      controleImagensPorPlano: configuracaoSupabaseOk(),
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
      req,
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
      req,
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
      req,
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

  if (
    statusOriginal === 401 &&
    (
      erro?.codigo === 'SESSAO_NAO_IDENTIFICADA' ||
      erro?.codigo === 'USUARIO_NAO_IDENTIFICADO'
    )
  ) {
    return res.status(401).json({
      ok: false,
      codigo: erro.codigo,
      erro: textoSeguro(erro.message, 700),
    });
  }

  if (
    statusOriginal === 403 &&
    (
      erro?.codigo === 'LIMITE_IMAGENS_IA_ATINGIDO' ||
      erro?.codigo === 'CADASTRO_USUARIO_NAO_ENCONTRADO' ||
      erro?.codigo === 'PLANO_NAO_IDENTIFICADO' ||
      erro?.codigo === 'PLANO_NAO_ENCONTRADO'
    )
  ) {
    return res.status(403).json({
      ok: false,
      codigo: erro.codigo,
      erro: textoSeguro(erro.message, 700),
      franquiaImagem: erro?.franquiaImagem || undefined,
    });
  }

  if (
    statusOriginal === 503 &&
    erro?.codigo === 'CONTROLE_IMAGENS_INDISPONIVEL'
  ) {
    return res.status(503).json({
      ok: false,
      codigo: erro.codigo,
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
    controleImagensPorPlano: configuracaoSupabaseOk(),
    supabaseHost: SUPABASE_URL ? urlSeguraParaLog(SUPABASE_URL) : '',
  });
});

export default app;
