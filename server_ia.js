import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

const PORT = process.env.PORT || 10000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

const GEMINI_FALLBACK_MODEL =
  process.env.GEMINI_FALLBACK_MODEL || "gemini-3.8-flash";

// Modelo oficial separado para criação/edição de imagens.
const GEMINI_IMAGE_MODEL =
  process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";

// Cloudflare Workers AI - principal para conversa e geração de imagens.
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

const CLOUDFLARE_TEXT_MODEL =
  process.env.CLOUDFLARE_TEXT_MODEL || "@cf/meta/llama-3.1-8b-instruct";

const CLOUDFLARE_IMAGE_MODEL =
  process.env.CLOUDFLARE_IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell";

const TIMEOUT_CLOUDFLARE_MS = 60000;

const MAX_TENTATIVAS = 2;
const TIMEOUT_GEMINI_MS = 20000;
const TIMEOUT_IMAGEM_MS = 90000;

// Como arquivos são enviados em Base64, o JSON fica maior que o arquivo binário.
app.use(cors());
app.use(express.json({ limit: "28mb" }));

const INSTRUCAO_SISTEMA = `
Você é a Jisa IA, a inteligência artificial do aplicativo Ache Obra, especializada em construção civil, reformas, arquitetura, engenharia, manutenção, materiais e planejamento de obras.

OBJETIVO PRINCIPAL
Entenda primeiro o que o usuário realmente quer e responda ao objetivo dele, não apenas às palavras isoladas. Seja precisa, prática, clara e útil. Responda sempre em português do Brasil, salvo pedido explícito em outro idioma.

REGRAS DE QUALIDADE
- Não invente fatos, medidas, preços, normas, leis, especificações, conteúdos de arquivos ou características que não foram fornecidas ou que você não possa sustentar.
- Preserve exatamente quantidades, dimensões, ambientes, materiais, restrições e preferências informadas pelo usuário.
- Quando houver várias exigências, confira mentalmente se todas foram atendidas antes de responder.
- Não troque, omita ou acrescente requisitos importantes sem avisar.
- Se houver ambiguidade pequena, adote a interpretação mais provável e diga a suposição de forma breve quando ela importar.
- REGRA EXECUTAR PRIMEIRO: quando houver informação suficiente para produzir uma resposta, proposta, estimativa ou imagem útil, execute usando suposições razoáveis para detalhes secundários.
- Faça pergunta somente quando faltar uma informação realmente essencial que impeça a execução. Nunca reinicie um levantamento de requisitos se o histórico já contiver as respostas.
- Correções curtas como "mais realista", "de verdade", "igual à anterior", "mude só o telhado", "agora faça a imagem" e "conforme pedi" são continuação do trabalho anterior; preserve tudo que não foi explicitamente alterado.
- HIERARQUIA DE CONTEXTO: a mensagem atual do usuário tem prioridade máxima. Depois vêm as correções mais recentes e, por último, o histórico antigo. O histórico serve para completar o pedido atual, nunca para trocar seu assunto principal.
- Se o usuário fizer um pedido executável, execute. Não responda com apresentação genérica, lista de capacidades ou perguntas desnecessárias.
- Aprenda dentro da conversa: quando o usuário corrigir um resultado, considere essa correção uma preferência/requisito vigente nas próximas mensagens relacionadas, até que ele diga o contrário.
- Quando o usuário pedir uma estimativa, deixe claro o que é estimado e quais fatores podem alterar o resultado.
- Em cálculos, organize os dados, confira unidades e mostre o resultado de maneira compreensível.
- Se o usuário corrigir algo, priorize a correção mais recente.
- Em pedidos de continuação como "ela", "isso", "essa casa", "o projeto", use o contexto fornecido na mensagem/histórico e não reinvente o objeto.

CONSTRUÇÃO E ARQUITETURA
- Diferencie ideia conceitual, estudo preliminar, orçamento estimado e projeto técnico/executivo.
- Para distribuição de ambientes, respeite o número de cômodos e as dimensões fornecidas.
- Para plantas, layouts e fachadas, descreva circulação, acessos e relações entre ambientes quando isso ajudar.
- Não apresente imagem gerada por IA como planta executiva, projeto estrutural ou documento técnico pronto para execução.
- Questões estruturais, elétricas, gás, incêndio, fundações e outras situações de segurança devem receber cautela proporcional ao risco e, quando necessário, recomendação de avaliação presencial por profissional habilitado.

IMAGENS E ARQUIVOS
Você pode analisar imagens e arquivos enviados. Baseie-se somente no conteúdo realmente disponível e diferencie claramente o que é visível do que é hipótese.
Ao analisar fotografias de obras, não afirme com certeza a causa de trincas, infiltrações, falhas estruturais, elétricas, hidráulicas ou defeitos ocultos sem evidência suficiente.

FORMA DA RESPOSTA
- Comece pela resposta que resolve o pedido.
- Evite introduções longas, repetições e texto genérico.
- Use tópicos quando melhorarem a leitura, mas não transforme toda resposta em lista.
- Para pedidos complexos, organize requisitos antes de concluir.
- Se não souber ou não houver dados suficientes, diga exatamente o que falta em vez de inventar.
`;

const MIME_PERMITIDOS = new Set([
  // Imagens
  "image/jpeg",
  "image/png",
  "image/webp",

  // PDF e texto
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "text/xml",
  "application/xml",
  "application/json",

  // Microsoft / OpenDocument
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",

  // Código / arquivos úteis
  "application/sql",
  "application/javascript",
  "text/javascript",
  "text/css",
  "application/rtf",
  "text/rtf",
]);

const MAX_ARQUIVO_BYTES = 18 * 1024 * 1024;
const MAX_ARQUIVOS = 5;

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extrairTextoGemini(data) {
  const candidates = data?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const parts = candidates[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;

  const textos = parts
    .filter((part) => typeof part?.text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean);

  return textos.length ? textos.join("\n") : null;
}

function limparBase64(valor) {
  if (typeof valor !== "string") return "";

  let base64 = valor.trim();
  const match = base64.match(/^data:([^;,]+);base64,(.+)$/s);

  if (match) {
    base64 = match[2].trim();
  }

  return base64.replace(/\s/g, "");
}

function calcularBytesBase64(base64) {
  const padding = (base64.match(/=+$/) || [""])[0].length;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function normalizarUmArquivo(raw, indice = 0) {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Arquivo ${indice + 1} inválido.`);
  }

  let data = raw.base64 ?? raw.data ?? "";
  let mimeType = String(
    raw.mimeType ?? raw.mime_type ?? raw.type ?? ""
  ).trim().toLowerCase();

  const nome = String(
    raw.nome ?? raw.name ?? raw.fileName ?? `arquivo_${indice + 1}`
  ).trim();

  if (typeof data === "string") {
    const match = data.trim().match(/^data:([^;,]+);base64,(.+)$/s);
    if (match) {
      if (!mimeType) mimeType = match[1].trim().toLowerCase();
      data = match[2];
    }
  }

  const base64 = limparBase64(data);

  if (!base64) {
    throw new Error(`O arquivo "${nome}" está vazio.`);
  }

  if (!mimeType) {
    throw new Error(`Não foi possível identificar o tipo do arquivo "${nome}".`);
  }

  if (!MIME_PERMITIDOS.has(mimeType)) {
    throw new Error(
      `O tipo de arquivo "${mimeType}" não é aceito pela Jisa neste momento.`
    );
  }

  if (
    !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) ||
    base64.length % 4 === 1
  ) {
    throw new Error(`Os dados do arquivo "${nome}" são inválidos.`);
  }

  const tamanhoBytes = calcularBytesBase64(base64);

  if (tamanhoBytes <= 0) {
    throw new Error(`O arquivo "${nome}" está vazio.`);
  }

  if (tamanhoBytes > MAX_ARQUIVO_BYTES) {
    throw new Error(
      `O arquivo "${nome}" ultrapassa o limite de 18 MB do aplicativo.`
    );
  }

  return {
    nome,
    mimeType,
    base64,
    tamanhoBytes,
  };
}

function normalizarArquivos(body) {
  let raws = [];

  if (Array.isArray(body?.arquivos)) {
    raws = body.arquivos;
  } else if (body?.arquivo) {
    raws = [body.arquivo];
  } else if (body?.imagem) {
    // Compatibilidade com a versão anterior do ia_page.dart.
    if (typeof body.imagem === "string") {
      raws = [{
        data: body.imagem,
        mimeType: body.mimeType ?? body.mime_type ?? "image/jpeg",
        nome: "imagem",
      }];
    } else {
      raws = [body.imagem];
    }
  }

  if (raws.length > MAX_ARQUIVOS) {
    throw new Error(`Envie no máximo ${MAX_ARQUIVOS} arquivos por mensagem.`);
  }

  return raws.map((raw, i) => normalizarUmArquivo(raw, i));
}

const MAX_HISTORICO_MENSAGENS = 14;
const MAX_HISTORICO_CARACTERES = 12000;

function normalizarHistorico(raw) {
  if (!Array.isArray(raw)) return [];

  const saida = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;

    const papelBruto = String(item.role ?? item.papel ?? item.tipo ?? "").toLowerCase();
    const role = ["assistant", "assistente", "jisa", "ia"].includes(papelBruto)
      ? "assistant"
      : ["user", "usuario", "usuário", "cliente"].includes(papelBruto)
        ? "user"
        : null;

    const content = String(
      item.content ?? item.texto ?? item.mensagem ?? item.text ?? ""
    ).trim();

    if (!role || !content) continue;
    saida.push({ role, content: content.slice(0, 4000) });
  }

  const recentes = saida.slice(-MAX_HISTORICO_MENSAGENS);
  let total = 0;
  const selecionadas = [];

  for (let i = recentes.length - 1; i >= 0; i--) {
    const item = recentes[i];
    if (total + item.content.length > MAX_HISTORICO_CARACTERES && selecionadas.length) break;
    selecionadas.push(item);
    total += item.content.length;
  }

  return selecionadas.reverse();
}

function historicoComoTexto(historico = []) {
  if (!historico.length) return "";
  return historico
    .map((item) => `${item.role === "assistant" ? "Jisa" : "Usuário"}: ${item.content}`)
    .join("\n");
}

function montarMensagemComContexto(mensagem, historico = []) {
  const atual = String(mensagem || "").trim();
  if (!historico.length) return atual;

  return [
    "CONTEXTO RECENTE DA CONVERSA (use para resolver referências e preservar requisitos já informados):",
    historicoComoTexto(historico),
    "",
    "MENSAGEM ATUAL DO USUÁRIO:",
    atual,
    "",
    "INSTRUÇÃO: trate a mensagem atual como continuação quando fizer sentido. Não peça novamente informações já presentes no contexto. Preserve tudo que o usuário não pediu para mudar."
  ].join("\n");
}

function detectarCorrecaoVisual(prompt) {
  const t = normalizarTextoBusca(prompt);
  return /\b(de verdade|realista|mais realista|fotorealista|foto real|pareca real|parecer real|igual a anterior|igual ao anterior|como antes|conforme pedi|como pedi|refaca|refazer|mude|troque|altere|adicione|retire|remova|agora)\b/.test(t);
}

function montarPromptImagemComContexto(prompt, historico = []) {
  const atual = String(prompt || "").trim();
  if (!historico.length) return atual;

  const contexto = historicoComoTexto(historico);
  const correcao = detectarCorrecaoVisual(atual);

  return [
    "CONTEXTO DO PEDIDO VISUAL:",
    contexto,
    "",
    "PEDIDO VISUAL ATUAL:",
    atual,
    "",
    correcao
      ? "Este pedido é uma correção/continuação. Preserve os requisitos anteriores e altere somente o que a mensagem atual pede."
      : "Use o contexto anterior somente quando ele for relevante ao pedido visual atual.",
    "Não faça perguntas: produza a melhor representação possível com os dados disponíveis."
  ].join("\n");
}

function criarBodyGemini(mensagem, arquivos = [], historico = []) {
  const parts = [];

  for (const arquivo of arquivos) {
    parts.push({
      inlineData: {
        mimeType: arquivo.mimeType,
        data: arquivo.base64,
      },
    });
  }

  const mensagemBase =
    mensagem ||
    (arquivos.length
      ? "Analise o conteúdo enviado e explique os pontos mais importantes."
      : "");

  const texto = montarMensagemComContexto(mensagemBase, historico);

  if (texto) {
    parts.push({ text: texto });
  }

  return {
    systemInstruction: {
      parts: [{ text: INSTRUCAO_SISTEMA }],
    },
    contents: [
      {
        role: "user",
        parts,
      },
    ],
    generationConfig: {
      temperature: 0.35,
      maxOutputTokens: 2600,
    },
  };
}

async function chamarGemini(modelo, mensagem, arquivos = [], historico = []) {
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(modelo)}:generateContent`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_GEMINI_MS);

  try {
    const respostaGoogle = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY,
      },
      body: JSON.stringify(criarBodyGemini(mensagem, arquivos, historico)),
      signal: controller.signal,
    });

    const textoResposta = await respostaGoogle.text();

    let dados = null;
    try {
      dados = JSON.parse(textoResposta);
    } catch {
      dados = null;
    }

    return {
      ok: respostaGoogle.ok,
      status: respostaGoogle.status,
      dados,
      textoResposta,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function chamarGeminiComRetry(modelo, mensagem, arquivos = [], historico = []) {
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    try {
      console.log(
        `[Gemini] ${modelo} - tentativa ${tentativa}/${MAX_TENTATIVAS}`
      );

      const resultado = await chamarGemini(modelo, mensagem, arquivos, historico);

      if (resultado.ok) {
        const resposta = extrairTextoGemini(resultado.dados);

        if (!resposta) {
          return {
            sucesso: false,
            tipo: "SEM_TEXTO",
            status: resultado.status,
            modelo,
          };
        }

        return {
          sucesso: true,
          resposta,
          modelo,
        };
      }

      console.error(
        `[Gemini] Erro no modelo ${modelo}:`,
        resultado.status,
        resultado.textoResposta
      );

      if (resultado.status === 429 || resultado.status === 503) {
        if (tentativa < MAX_TENTATIVAS) {
          const esperaMs = 700 * Math.pow(2, tentativa - 1);
          await esperar(esperaMs);
          continue;
        }

        return {
          sucesso: false,
          tipo:
            resultado.status === 429
              ? "LIMITE_TEMPORARIO"
              : "INDISPONIVEL",
          status: resultado.status,
          modelo,
        };
      }

      return {
        sucesso: false,
        tipo: "ERRO_API",
        status: resultado.status,
        modelo,
        detalhes: resultado.dados,
      };
    } catch (error) {
      if (error?.name === "AbortError") {
        if (tentativa < MAX_TENTATIVAS) {
          const esperaMs = 700 * Math.pow(2, tentativa - 1);
          await esperar(esperaMs);
          continue;
        }

        return {
          sucesso: false,
          tipo: "TIMEOUT",
          status: 504,
          modelo,
        };
      }

      console.error(`[Gemini] Erro inesperado em ${modelo}:`, error);

      return {
        sucesso: false,
        tipo: "ERRO_INTERNO",
        status: 500,
        modelo,
      };
    }
  }

  return {
    sucesso: false,
    tipo: "INDISPONIVEL",
    status: 503,
    modelo,
  };
}

function normalizarAspectRatio(valor) {
  const permitidos = new Set([
    "1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4",
    "9:16", "16:9", "21:9", "1:4", "4:1", "1:8", "8:1",
  ]);

  return permitidos.has(valor) ? valor : "1:1";
}

function normalizarImageSize(valor) {
  const permitidos = new Set(["0.5K", "1K", "2K", "4K"]);
  return permitidos.has(valor) ? valor : "1K";
}

function extrairImagemGenerateContent(data) {
  const candidates = data?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const parts = candidates[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;

  for (const part of parts) {
    const inlineData = part?.inlineData ?? part?.inline_data;

    if (inlineData?.data) {
      return {
        data: inlineData.data,
        mimeType:
          inlineData.mimeType ??
          inlineData.mime_type ??
          "image/png",
      };
    }
  }

  return null;
}

function extrairTextoImagemGenerateContent(data) {
  const candidates = data?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const parts = candidates[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;

  const textos = parts
    .filter((part) => typeof part?.text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean);

  return textos.length ? textos.join("\n") : null;
}

async function gerarImagemGemini({
  prompt,
  referencias = [],
  aspectRatio = "1:1",
  imageSize = "1K",
}) {
  // A geração/edição usa generateContent, que retorna a imagem em
  // candidates[0].content.parts[].inlineData.
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(GEMINI_IMAGE_MODEL)}:generateContent`;

  const parts = [];

  // Imagens de referência para edição/transformação.
  for (const arquivo of referencias) {
    if (!arquivo.mimeType.startsWith("image/")) continue;

    parts.push({
      inlineData: {
        mimeType: arquivo.mimeType,
        data: arquivo.base64,
      },
    });
  }

  parts.push({
    text: prompt,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_IMAGEM_MS);

  try {
    const respostaGoogle = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts,
          },
        ],
        generationConfig: {
          // O Gemini usa os padrões de imagem quando tamanho/proporção
          // não são enviados. Isso evita o INVALID_ARGUMENT observado
          // no responseFormat.image.aspectRatio / imageSize.
          responseModalities: ["TEXT", "IMAGE"],
        },
      }),
      signal: controller.signal,
    });

    const textoResposta = await respostaGoogle.text();

    let dados = null;
    try {
      dados = JSON.parse(textoResposta);
    } catch {
      dados = null;
    }

    if (!respostaGoogle.ok) {
      return {
        sucesso: false,
        status: respostaGoogle.status,
        detalhes: dados ?? textoResposta,
      };
    }

    const imagem = extrairImagemGenerateContent(dados);

    if (!imagem?.data) {
      return {
        sucesso: false,
        status: 502,
        detalhes: dados,
      };
    }

    return {
      sucesso: true,
      imagemBase64: imagem.data,
      mimeType: imagem.mimeType,
      texto: extrairTextoImagemGenerateContent(dados),
      modelo: GEMINI_IMAGE_MODEL,
    };
  } finally {
    clearTimeout(timeout);
  }
}


// ======================================================
// CLOUDFLARE WORKERS AI - TESTES
// ======================================================

function cloudflareConfigurado() {
  return Boolean(CLOUDFLARE_ACCOUNT_ID && CLOUDFLARE_API_TOKEN);
}

function endpointCloudflare(modelo) {
  return (
    `https://api.cloudflare.com/client/v4/accounts/` +
    `${encodeURIComponent(CLOUDFLARE_ACCOUNT_ID)}/ai/run/` +
    `${modelo}`
  );
}

async function chamarCloudflare(modelo, body, timeoutMs = TIMEOUT_CLOUDFLARE_MS) {
  if (!cloudflareConfigurado()) {
    return {
      sucesso: false,
      status: 500,
      erro: "Cloudflare Workers AI não configurado no Render.",
      dados: null,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resposta = await fetch(endpointCloudflare(modelo), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const textoBruto = await resposta.text();
    let dados = null;

    try {
      dados = JSON.parse(textoBruto);
    } catch {
      dados = null;
    }

    if (!resposta.ok || dados?.success === false) {
      return {
        sucesso: false,
        status: resposta.status,
        erro:
          dados?.errors?.[0]?.message ||
          dados?.messages?.[0]?.message ||
          textoBruto ||
          `Cloudflare respondeu HTTP ${resposta.status}.`,
        dados,
      };
    }

    return {
      sucesso: true,
      status: resposta.status,
      dados,
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      return {
        sucesso: false,
        status: 504,
        erro: "A chamada ao Cloudflare Workers AI excedeu o tempo limite.",
        dados: null,
      };
    }

    return {
      sucesso: false,
      status: 500,
      erro: error?.message || "Erro inesperado ao chamar o Cloudflare Workers AI.",
      dados: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function extrairTextoCloudflare(dados) {
  const result = dados?.result;

  if (typeof result?.response === "string" && result.response.trim()) {
    return result.response.trim();
  }

  if (typeof result === "string" && result.trim()) {
    return result.trim();
  }

  return null;
}

async function conversarCloudflare(mensagem, historico = []) {
  const texto =
    mensagem ||
    "Olá. Apresente-se brevemente como Jisa IA, assistente do Ache Obra.";

  const resultado = await chamarCloudflare(CLOUDFLARE_TEXT_MODEL, {
    messages: [
      {
        role: "system",
        content: INSTRUCAO_SISTEMA,
      },
      ...historico.map((item) => ({
        role: item.role,
        content: item.content,
      })),
      {
        role: "user",
        content: texto,
      },
    ],
    max_tokens: 2600,
    temperature: 0.35,
  });

  if (!resultado.sucesso) {
    return {
      sucesso: false,
      status: resultado.status,
      erro: resultado.erro,
      detalhes: resultado.dados,
      modelo: CLOUDFLARE_TEXT_MODEL,
    };
  }

  const resposta = extrairTextoCloudflare(resultado.dados);

  if (!resposta) {
    return {
      sucesso: false,
      status: 502,
      erro: "Cloudflare respondeu sem texto.",
      detalhes: resultado.dados,
      modelo: CLOUDFLARE_TEXT_MODEL,
    };
  }

  return {
    sucesso: true,
    resposta,
    modelo: CLOUDFLARE_TEXT_MODEL,
  };
}

function normalizarTextoBusca(valor) {
  return String(valor || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function detectarTipoImagem(prompt) {
  const t = normalizarTextoBusca(prompt);

  // A intenção explícita da mensagem atual sempre vence o histórico.
  if (/\b(planta baixa|floor plan|planta da casa|planta do imovel|planta do imóvel|layout da casa|distribuicao dos comodos|distribuição dos cômodos)\b/.test(t)) {
    return "planta_baixa";
  }
  if (/\b(fachada|frente da casa|frente do imovel|exterior da casa|vista externa|elevacao frontal)\b/.test(t)) {
    return "fachada";
  }
  if (/\b(telhado|cobertura)\b/.test(t) && !/\b(casa|residencia|imovel|sobrado|cabana|chale)\b/.test(t)) {
    return "cobertura";
  }
  if (/\b(jardim|paisag|area externa|quintal)\b/.test(t) && !/\b(casa|residencia|imovel|sobrado|cabana|chale)\b/.test(t)) {
    return "area_externa";
  }

  // Se o pedido fala da edificação como objeto principal, não deixe nomes de
  // cômodos no contexto transformarem a geração em uma imagem de interior.
  if (/\b(casa|residencia|imovel|sobrado|cabana|chale|edificacao|construcao)\b/.test(t)) {
    return "edificacao_externa";
  }

  if (/\b(interior|ambiente interno|por dentro|dentro da casa|cozinha|quarto|banheiro|sala|lavanderia|escritorio)\b/.test(t)) {
    return "interior";
  }

  return "geral";
}

function extrairRequisitosVisuais(prompt) {
  const texto = String(prompt || "").trim();
  const t = normalizarTextoBusca(texto);
  const requisitos = [];

  const dimensoes = t.match(/\b\d+(?:[.,]\d+)?\s*(?:m|metro|metros)?\s*[x×]\s*\d+(?:[.,]\d+)?\s*(?:m|metro|metros)?\b/i);
  if (dimensoes) requisitos.push(`Dimensões mencionadas pelo usuário: ${dimensoes[0]}.`);

  const materiais = ["madeira", "alvenaria", "tijolo", "concreto", "vidro", "pedra", "metal"];
  for (const material of materiais) {
    if (t.includes(material)) requisitos.push(`Material explicitamente citado: ${material}.`);
  }

  const termos = [
    "quarto", "suite", "banheiro", "lavabo", "sala", "cozinha", "lavanderia",
    "garagem", "escritorio", "closet", "despensa", "varanda", "corredor",
    "area gourmet", "churrasqueira", "jardim", "piscina", "porta", "janela"
  ];
  for (const termo of termos) {
    if (t.includes(termo)) requisitos.push(`Preservar o requisito citado: ${termo}.`);
  }

  return requisitos;
}

function pedidoEhContinuacaoVisual(prompt) {
  const t = normalizarTextoBusca(prompt);
  return /\b(ela|ele|essa|esse|esta|este|isso|anterior|antes|mesma|mesmo|de verdade|mais realista|realista|conforme pedi|como pedi|igual a anterior|refaca|refazer|mude|troque|altere|adicione|adicione|coloque|retire|remova|agora)\b/.test(t);
}

function historicoVisualRelevante(historico = [], limite = 8) {
  return historico
    .filter((item) => item && ["user", "assistant"].includes(item.role) && item.content)
    .slice(-limite)
    .map((item) => `${item.role === "user" ? "Usuário" : "Jisa"}: ${item.content}`)
    .join("\n");
}

function montarPromptImagemInteligente(promptAtual, historico = []) {
  const atual = String(promptAtual || "").trim();
  const tipoAtual = detectarTipoImagem(atual);
  const continuacao = pedidoEhContinuacaoVisual(atual);
  const contexto = historicoVisualRelevante(historico);
  const requisitos = extrairRequisitosVisuais(atual);
  const t = normalizarTextoBusca(atual);

  const base = [
    "TAREFA: gerar UMA imagem que represente fielmente o pedido atual do usuário.",
    "REGRA DE PRIORIDADE: 1) pedido atual; 2) correções recentes; 3) histórico antigo.",
    "O histórico NUNCA pode mudar o assunto principal explicitamente pedido na mensagem atual.",
    "Não responda com texto, não faça perguntas e não transforme o pedido em outro tipo de cena.",
    "PEDIDO ATUAL (FONTE PRINCIPAL):",
    atual,
  ];

  if (continuacao && contexto) {
    base.push(
      "CONTEXTO ANTERIOR RELEVANTE (usar apenas para preservar o que não foi alterado):",
      contexto,
      "A mensagem atual é uma continuação/correção. Preserve requisitos anteriores compatíveis e altere somente o solicitado."
    );
  } else if (contexto) {
    base.push(
      "CONTEXTO ANTERIOR SECUNDÁRIO:",
      contexto,
      "Use este contexto somente se for compatível com o pedido atual. Ignore qualquer trecho que conflite com o assunto atual."
    );
  }

  base.push(
    "QUALIDADE VISUAL: composição coerente, objeto principal claramente visível, proporções plausíveis e sem elementos aleatórios que contradigam o pedido."
  );

  if (tipoAtual === "edificacao_externa") {
    base.push(
      "TIPO VISUAL OBRIGATÓRIO: vista EXTERNA da edificação completa.",
      "Mostrar a casa/residência inteira no enquadramento, incluindo fachada, paredes externas, cobertura e aberturas visíveis.",
      "NÃO gerar sala, cozinha, quarto, banheiro ou outro ambiente interno como assunto principal.",
      "NÃO gerar somente um detalhe isolado da construção.",
      "Usar perspectiva arquitetônica externa natural, com escala residencial real."
    );
  } else if (tipoAtual === "planta_baixa") {
    base.push(
      "TIPO VISUAL OBRIGATÓRIO: planta baixa residencial completa, vista superior ortográfica 2D (top-down).",
      "Mostrar o imóvel inteiro, perímetro externo, paredes internas, divisórias, portas, janelas e circulação.",
      "Mostrar todos os ambientes solicitados simultaneamente; não mostrar apenas um cômodo.",
      "Evitar perspectiva ao nível dos olhos, fotografia de interior e fachada."
    );
  } else if (tipoAtual === "fachada") {
    base.push(
      "TIPO VISUAL OBRIGATÓRIO: fachada/exterior da edificação, enquadramento amplo mostrando a construção completa.",
      "Não gerar interior. Preservar materiais, aberturas, pavimentos e características solicitadas."
    );
  } else if (tipoAtual === "interior") {
    base.push(
      "TIPO VISUAL OBRIGATÓRIO: ambiente interno solicitado, com enquadramento amplo e organização compreensível.",
      "Não trocar o cômodo solicitado por outro ambiente."
    );
  } else if (tipoAtual === "cobertura") {
    base.push("TIPO VISUAL OBRIGATÓRIO: cobertura/telhado como assunto principal e geometria claramente visível.");
  } else if (tipoAtual === "area_externa") {
    base.push("TIPO VISUAL OBRIGATÓRIO: área externa solicitada, mantendo relação coerente com a edificação.");
  }

  if (/\b(de verdade|realista|fotorealista|foto real|pareca real|parecer real|casa real|construcao real)\b/.test(t) || tipoAtual === "edificacao_externa") {
    base.push(
      "ESTILO: fotografia arquitetônica realista, construção em escala real, materiais fisicamente plausíveis, iluminação natural e proporções críveis.",
      "EVITAR: maquete, miniatura, diorama, dollhouse, brinquedo, modelinho, aparência toy-like ou construção em escala reduzida."
    );
  }

  if (requisitos.length) {
    base.push("REQUISITOS EXPLÍCITOS DA MENSAGEM ATUAL:", ...requisitos);
  }

  base.push("Antes de gerar, confira internamente: o assunto principal da imagem corresponde exatamente ao pedido atual?");
  return { tipo: tipoAtual, prompt: base.join("\n") };
}

async function gerarImagemCloudflare(prompt) {
  let resultado = null;

  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    resultado = await chamarCloudflare(
      CLOUDFLARE_IMAGE_MODEL,
      { prompt, steps: 4 },
      90000
    );

    if (resultado.sucesso) break;

    const transitorio = [429, 500, 502, 503, 504].includes(resultado.status);
    if (!transitorio || tentativa === 2) break;

    console.warn(`[Cloudflare] Imagem falhou na tentativa ${tentativa}; tentando novamente. HTTP ${resultado.status}`);
    await esperar(900);
  }

  if (!resultado.sucesso) {
    return {
      sucesso: false,
      status: resultado.status,
      erro: resultado.erro,
      detalhes: resultado.dados,
      modelo: CLOUDFLARE_IMAGE_MODEL,
    };
  }

  const imagemBase64 = extrairImagemCloudflare(resultado.dados);

  if (!imagemBase64) {
    return {
      sucesso: false,
      status: 502,
      erro: "Cloudflare respondeu sem imagem.",
      detalhes: resultado.dados,
      modelo: CLOUDFLARE_IMAGE_MODEL,
    };
  }

  return {
    sucesso: true,
    imagemBase64,
    mimeType: "image/jpeg",
    texto: null,
    modelo: CLOUDFLARE_IMAGE_MODEL,
  };
}

function extrairImagemCloudflare(dados) {
  const result = dados?.result;

  if (typeof result?.image === "string" && result.image.trim()) {
    return result.image.trim();
  }

  return null;
}

// ======================================================
// ROTAS
// ======================================================

app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    servico: "Jisa IA",
    status: "online",
    recursos: [
      "texto",
      "imagens",
      "pdf",
      "documentos",
      "planilhas",
      "apresentacoes",
      "arquivos_de_texto",
      "geracao_de_imagens",
      "edicao_de_imagens",
      "download_de_imagens_no_app",
    ],
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    servico: "Jisa IA",
    gemini_configurado: Boolean(GEMINI_API_KEY),
    modelo_principal: GEMINI_MODEL,
    modelo_fallback: GEMINI_FALLBACK_MODEL,
    modelo_imagem: GEMINI_IMAGE_MODEL,
    cloudflare_configurado: cloudflareConfigurado(),
    cloudflare_modelo_texto: CLOUDFLARE_TEXT_MODEL,
    cloudflare_modelo_imagem: CLOUDFLARE_IMAGE_MODEL,
    conversa_principal: cloudflareConfigurado() ? "cloudflare" : "gemini",
    geracao_imagem_principal: cloudflareConfigurado() ? "cloudflare" : "indisponivel",
    analise_arquivos: GEMINI_API_KEY ? "gemini" : "indisponivel",
  });
});

// Teste temporário de autenticação e geração de texto no Cloudflare.
// Não substitui ainda a rota principal da Jisa.
app.get("/cloudflare/teste", async (req, res) => {
  try {
    if (!cloudflareConfigurado()) {
      return res.status(500).json({
        ok: false,
        cloudflare: false,
        erro:
          "CLOUDFLARE_ACCOUNT_ID ou CLOUDFLARE_API_TOKEN não configurado no Render.",
      });
    }

    const resultado = await chamarCloudflare(CLOUDFLARE_TEXT_MODEL, {
      messages: [
        {
          role: "system",
          content:
            "Você é a Jisa IA, assistente de construção do Ache Obra. " +
            "Responda sempre em português do Brasil.",
        },
        {
          role: "user",
          content:
            "Responda somente: Cloudflare Workers AI conectado com sucesso.",
        },
      ],
      max_tokens: 80,
      temperature: 0.2,
    });

    if (!resultado.sucesso) {
      console.error(
        "[Cloudflare] Falha no teste de texto:",
        resultado.status,
        resultado.erro,
        resultado.dados
      );

      return res.status(resultado.status || 502).json({
        ok: false,
        cloudflare: false,
        status: resultado.status,
        erro: resultado.erro,
      });
    }

    const resposta = extrairTextoCloudflare(resultado.dados);

    if (!resposta) {
      return res.status(502).json({
        ok: false,
        cloudflare: true,
        autenticado: true,
        erro: "Cloudflare respondeu, mas não retornou texto.",
      });
    }

    return res.status(200).json({
      ok: true,
      cloudflare: true,
      autenticado: true,
      modelo: CLOUDFLARE_TEXT_MODEL,
      resposta,
    });
  } catch (error) {
    console.error("Erro em /cloudflare/teste:", error);

    return res.status(500).json({
      ok: false,
      cloudflare: false,
      erro: "Erro interno ao testar o Cloudflare Workers AI.",
    });
  }
});

// Teste de geração de imagem pelo FLUX.
// Também não altera ainda a rota de geração de imagens da Jisa.
app.get("/cloudflare/teste-imagem", async (req, res) => {
  try {
    if (!cloudflareConfigurado()) {
      return res.status(500).json({
        ok: false,
        cloudflare: false,
        erro:
          "CLOUDFLARE_ACCOUNT_ID ou CLOUDFLARE_API_TOKEN não configurado no Render.",
      });
    }

    const resultado = await chamarCloudflare(
      CLOUDFLARE_IMAGE_MODEL,
      {
        prompt:
          "Um quarto moderno de 3 por 3 metros com cama de casal, " +
          "interior residencial realista, iluminação natural, sem pessoas.",
        steps: 4,
      },
      90000
    );

    if (!resultado.sucesso) {
      console.error(
        "[Cloudflare] Falha no teste de imagem:",
        resultado.status,
        resultado.erro,
        resultado.dados
      );

      return res.status(resultado.status || 502).json({
        ok: false,
        cloudflare: false,
        status: resultado.status,
        erro: resultado.erro,
      });
    }

    const imagemBase64 = extrairImagemCloudflare(resultado.dados);

    if (!imagemBase64) {
      return res.status(502).json({
        ok: false,
        cloudflare: true,
        autenticado: true,
        erro: "Cloudflare respondeu, mas não retornou a imagem esperada.",
      });
    }

    return res.status(200).json({
      ok: true,
      cloudflare: true,
      autenticado: true,
      tipo: "imagem",
      modelo: CLOUDFLARE_IMAGE_MODEL,
      mimeType: "image/jpeg",
      nomeArquivo: `jisa_cloudflare_teste_${Date.now()}.jpg`,
      podeBaixar: true,
      imagemBase64,
    });
  } catch (error) {
    console.error("Erro em /cloudflare/teste-imagem:", error);

    return res.status(500).json({
      ok: false,
      cloudflare: false,
      erro: "Erro interno ao testar geração de imagem no Cloudflare.",
    });
  }
});

// Texto + arquivos
// Texto puro: Cloudflare é o provedor principal e Gemini é fallback.
// Arquivos/imagens/documentos: Gemini continua responsável pela análise multimodal.
app.post("/ia/perguntar", async (req, res) => {
  try {
    const mensagem =
      typeof req.body?.mensagem === "string"
        ? req.body.mensagem.trim()
        : "";

    const historico = normalizarHistorico(req.body?.historico);

    if (mensagem.length > 8000) {
      return res.status(400).json({
        ok: false,
        erro: "A mensagem é muito grande.",
      });
    }

    let arquivos = [];

    try {
      arquivos = normalizarArquivos(req.body);
    } catch (error) {
      return res.status(400).json({
        ok: false,
        erro: error?.message || "Arquivo inválido.",
      });
    }

    if (!mensagem && arquivos.length === 0) {
      return res.status(400).json({
        ok: false,
        erro: "Informe uma mensagem ou envie um arquivo.",
      });
    }

    console.log(
      `[Jisa IA] texto=${mensagem ? "SIM" : "NÃO"} arquivos=${arquivos.length}`
    );

    // Conversa comum: Cloudflare primeiro.
    if (arquivos.length === 0 && cloudflareConfigurado()) {
      console.log(`[Cloudflare] Conversa usando ${CLOUDFLARE_TEXT_MODEL}`);

      const resultadoCloudflare = await conversarCloudflare(mensagem, historico);

      if (resultadoCloudflare.sucesso) {
        return res.status(200).json({
          ok: true,
          resposta: resultadoCloudflare.resposta,
          modelo: resultadoCloudflare.modelo,
          provedor: "cloudflare",
          fallback: false,
        });
      }

      console.error(
        "[Cloudflare] Falha na conversa; tentando Gemini:",
        resultadoCloudflare.status,
        resultadoCloudflare.erro
      );
    }

    // Arquivos ou fallback de texto: Gemini.
    if (!GEMINI_API_KEY) {
      return res.status(503).json({
        ok: false,
        erro:
          arquivos.length > 0
            ? "A análise de arquivos está temporariamente indisponível."
            : "A Jisa está temporariamente indisponível.",
      });
    }

    const resultadoPrincipal = await chamarGeminiComRetry(
      GEMINI_MODEL,
      mensagem,
      arquivos,
      historico
    );

    if (resultadoPrincipal.sucesso) {
      return res.status(200).json({
        ok: true,
        resposta: resultadoPrincipal.resposta,
        modelo: resultadoPrincipal.modelo,
        provedor: "gemini",
        fallback: arquivos.length === 0 && cloudflareConfigurado(),
      });
    }

    const podeUsarFallback = [
      "LIMITE_TEMPORARIO",
      "INDISPONIVEL",
      "TIMEOUT",
    ].includes(resultadoPrincipal.tipo);

    if (!podeUsarFallback) {
      return res.status(502).json({
        ok: false,
        erro:
          "Não foi possível processar a solicitação. " +
          "Verifique se o modelo aceita o tipo de arquivo enviado.",
      });
    }

    if (GEMINI_FALLBACK_MODEL === GEMINI_MODEL) {
      return res.status(503).json({
        ok: false,
        erro: "A Jisa está temporariamente indisponível.",
      });
    }

    const resultadoFallback = await chamarGeminiComRetry(
      GEMINI_FALLBACK_MODEL,
      mensagem,
      arquivos,
      historico
    );

    if (resultadoFallback.sucesso) {
      return res.status(200).json({
        ok: true,
        resposta: resultadoFallback.resposta,
        modelo: resultadoFallback.modelo,
        provedor: "gemini",
        fallback: true,
      });
    }

    if (
      resultadoPrincipal.tipo === "LIMITE_TEMPORARIO" &&
      resultadoFallback.tipo === "LIMITE_TEMPORARIO"
    ) {
      return res.status(429).json({
        ok: false,
        erro:
          "O limite temporário da inteligência artificial foi atingido. " +
          "Tente novamente em alguns instantes.",
      });
    }

    return res.status(503).json({
      ok: false,
      erro:
        "A inteligência artificial está temporariamente indisponível. " +
        "Tente novamente em alguns instantes.",
    });
  } catch (error) {
    console.error("Erro em /ia/perguntar:", error);

    return res.status(500).json({
      ok: false,
      erro: "Erro interno no serviço de inteligência artificial.",
    });
  }
});

// Geração e edição de imagem.
// Geração do zero: Cloudflare FLUX é o provedor principal.
// Edição com imagem de referência: mantém Gemini, pois o modelo FLUX usado aqui
// foi validado para geração por prompt, não para edição de referência.
app.post("/ia/gerar-imagem", async (req, res) => {
  try {
    const prompt =
      typeof req.body?.prompt === "string"
        ? req.body.prompt.trim()
        : typeof req.body?.mensagem === "string"
          ? req.body.mensagem.trim()
          : "";

    const historico = normalizarHistorico(req.body?.historico);

    if (!prompt) {
      return res.status(400).json({
        ok: false,
        erro: "Informe o que a Jisa deve criar na imagem.",
      });
    }

    if (prompt.length > 8000) {
      return res.status(400).json({
        ok: false,
        erro: "A descrição da imagem é muito grande.",
      });
    }

    let arquivos = [];

    try {
      arquivos = normalizarArquivos(req.body);
    } catch (error) {
      return res.status(400).json({
        ok: false,
        erro: error?.message || "Arquivo de referência inválido.",
      });
    }

    const referencias = arquivos.filter((a) =>
      a.mimeType.startsWith("image/")
    );

    if (arquivos.length !== referencias.length) {
      return res.status(400).json({
        ok: false,
        erro:
          "Na geração/edição de imagens, os arquivos de referência " +
          "precisam ser imagens.",
      });
    }

    // Sem referência: usa Cloudflare FLUX, já validado no ambiente.
    if (referencias.length === 0 && cloudflareConfigurado()) {
      const promptOtimizado = montarPromptImagemInteligente(prompt, historico);

      console.log(
        `[Cloudflare] Gerando imagem com ${CLOUDFLARE_IMAGE_MODEL} | tipo=${promptOtimizado.tipo}`
      );

      const resultadoCloudflare = await gerarImagemCloudflare(promptOtimizado.prompt);

      if (resultadoCloudflare.sucesso) {
        return res.status(200).json({
          ok: true,
          tipo: "imagem",
          imagemBase64: resultadoCloudflare.imagemBase64,
          mimeType: resultadoCloudflare.mimeType,
          nomeArquivo: `jisa_${Date.now()}.jpg`,
          podeBaixar: true,
          resposta: resultadoCloudflare.texto,
          modelo: resultadoCloudflare.modelo,
          provedor: "cloudflare",
          fallback: false,
        });
      }

      console.error(
        "[Cloudflare] Falha na geração de imagem:",
        resultadoCloudflare.status,
        resultadoCloudflare.erro,
        resultadoCloudflare.detalhes
      );

      // Não envia automaticamente para o Gemini de imagem quando o Cloudflare
      // falha, evitando consumo/cobrança inesperada e o erro de quota 0 já visto.
      if (resultadoCloudflare.status === 429) {
        return res.status(429).json({
          ok: false,
          erro:
            "O limite temporário de geração de imagens foi atingido. " +
            "Tente novamente em alguns instantes.",
        });
      }

      return res.status(502).json({
        ok: false,
        erro: "Não foi possível gerar a imagem neste momento.",
      });
    }

    // Edição com imagem de referência: Gemini.
    if (referencias.length > 0) {
      if (!GEMINI_API_KEY) {
        return res.status(503).json({
          ok: false,
          erro: "A edição de imagens está temporariamente indisponível.",
        });
      }

      const promptContextual = montarPromptImagemComContexto(prompt, historico);
      const resultado = await gerarImagemGemini({
        prompt: promptContextual,
        referencias,
        aspectRatio:
          typeof req.body?.aspectRatio === "string"
            ? req.body.aspectRatio
            : "1:1",
        imageSize:
          typeof req.body?.imageSize === "string"
            ? req.body.imageSize
            : "1K",
      });

      if (!resultado.sucesso) {
        console.error(
          "[Jisa IA] Falha na edição de imagem pelo Gemini:",
          resultado.status,
          resultado.detalhes
        );

        if (resultado.status === 429) {
          return res.status(429).json({
            ok: false,
            erro:
              "A edição de imagens atingiu o limite disponível neste momento.",
          });
        }

        return res.status(502).json({
          ok: false,
          erro: "Não foi possível editar a imagem neste momento.",
        });
      }

      return res.status(200).json({
        ok: true,
        tipo: "imagem",
        imagemBase64: resultado.imagemBase64,
        mimeType: resultado.mimeType,
        nomeArquivo: `jisa_${Date.now()}.${resultado.mimeType === "image/jpeg" ? "jpg" : "png"}`,
        podeBaixar: true,
        resposta: resultado.texto,
        modelo: resultado.modelo,
        provedor: "gemini",
        fallback: false,
      });
    }

    return res.status(503).json({
      ok: false,
      erro: "O serviço de geração de imagens não está configurado.",
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      return res.status(504).json({
        ok: false,
        erro: "A geração da imagem demorou demais. Tente novamente.",
      });
    }

    console.error("Erro em /ia/gerar-imagem:", error);

    return res.status(500).json({
      ok: false,
      erro: "Erro interno ao gerar a imagem.",
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    erro: "Rota não encontrada.",
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("==========================================");
  console.log("ACHE OBRA - BACKEND JISA IA");
  console.log(`Servidor iniciado na porta ${PORT}`);
  console.log(`Modelo principal: ${GEMINI_MODEL}`);
  console.log(`Modelo fallback: ${GEMINI_FALLBACK_MODEL}`);
  console.log(`Modelo de imagem: ${GEMINI_IMAGE_MODEL}`);
  console.log(`Gemini configurado: ${GEMINI_API_KEY ? "SIM" : "NÃO"}`);
  console.log(`Cloudflare configurado: ${cloudflareConfigurado() ? "SIM" : "NÃO"}`);
  console.log(`Cloudflare texto: ${CLOUDFLARE_TEXT_MODEL}`);
  console.log(`Cloudflare imagem: ${CLOUDFLARE_IMAGE_MODEL}`);
  console.log("==========================================");
});
