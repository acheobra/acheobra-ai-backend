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

const MAX_TENTATIVAS = 2;
const TIMEOUT_GEMINI_MS = 20000;
const TIMEOUT_IMAGEM_MS = 90000;

// Como arquivos são enviados em Base64, o JSON fica maior que o arquivo binário.
app.use(cors());
app.use(express.json({ limit: "28mb" }));

const INSTRUCAO_SISTEMA = `
Você é a Jisa IA, a inteligência artificial do aplicativo Ache Obra.

O Ache Obra é uma plataforma voltada à construção civil que conecta
clientes, profissionais, arquitetos e engenheiros.

Ajude com construção civil, reformas, manutenção, materiais de construção,
planejamento de obras, descrição de serviços, pedidos de orçamento,
organização de demandas, arquitetura, engenharia e serviços residenciais
e comerciais.

Responda sempre em português do Brasil, salvo pedido explícito em outro idioma.
Seja clara, objetiva, educada e útil.

Você pode analisar imagens e arquivos enviados pelo usuário. Ao responder sobre
um arquivo, baseie-se no conteúdo realmente disponível nele e não invente
informações ausentes.

Ao analisar fotografias de obras:
- descreva somente o que a imagem sustenta;
- não afirme com certeza a causa de trincas, infiltrações, falhas estruturais,
  elétricas, hidráulicas ou defeitos ocultos sem inspeção adequada;
- quando houver possível risco estrutural, elétrico, gás, incêndio ou segurança,
  recomende avaliação presencial por profissional habilitado;
- não invente medidas, materiais, marcas ou condições invisíveis.

Quando valores, quantidades ou custos dependerem da região, materiais,
mão de obra ou condições da obra, deixe claro que são estimativas.

Não invente preços, normas técnicas, leis ou informações que não tenha
segurança para fornecer.

Quando uma questão exigir avaliação presencial de engenheiro, arquiteto,
eletricista ou outro profissional habilitado, deixe isso claro.
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

function criarBodyGemini(mensagem, arquivos = []) {
  const parts = [];

  for (const arquivo of arquivos) {
    parts.push({
      inlineData: {
        mimeType: arquivo.mimeType,
        data: arquivo.base64,
      },
    });
  }

  const texto =
    mensagem ||
    (arquivos.length
      ? "Analise o conteúdo enviado e explique os pontos mais importantes."
      : "");

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
      temperature: 0.7,
      maxOutputTokens: 2000,
    },
  };
}

async function chamarGemini(modelo, mensagem, arquivos = []) {
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
      body: JSON.stringify(criarBodyGemini(mensagem, arquivos)),
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

async function chamarGeminiComRetry(modelo, mensagem, arquivos = []) {
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    try {
      console.log(
        `[Gemini] ${modelo} - tentativa ${tentativa}/${MAX_TENTATIVAS}`
      );

      const resultado = await chamarGemini(modelo, mensagem, arquivos);

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

function extrairImagemInteraction(data) {
  if (data?.output_image?.data) {
    return {
      data: data.output_image.data,
      mimeType:
        data.output_image.mime_type ??
        data.output_image.mimeType ??
        "image/png",
    };
  }

  const steps = Array.isArray(data?.steps) ? data.steps : [];

  for (const step of steps) {
    if (step?.type !== "model_output" || !Array.isArray(step?.content)) {
      continue;
    }

    for (const bloco of step.content) {
      if (bloco?.type === "image" && bloco?.data) {
        return {
          data: bloco.data,
          mimeType:
            bloco.mime_type ??
            bloco.mimeType ??
            "image/png",
        };
      }
    }
  }

  return null;
}

function extrairTextoInteraction(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const textos = [];
  const steps = Array.isArray(data?.steps) ? data.steps : [];

  for (const step of steps) {
    if (step?.type !== "model_output" || !Array.isArray(step?.content)) {
      continue;
    }

    for (const bloco of step.content) {
      if (bloco?.type === "text" && typeof bloco?.text === "string") {
        textos.push(bloco.text.trim());
      }
    }
  }

  return textos.filter(Boolean).join("\n") || null;
}

async function gerarImagemGemini({
  prompt,
  referencias = [],
  aspectRatio = "1:1",
  imageSize = "1K",
}) {
  const endpoint =
    "https://generativelanguage.googleapis.com/v1beta/interactions";

  const input = [
    ...referencias
      .filter((a) => a.mimeType.startsWith("image/"))
      .map((a) => ({
        type: "image",
        mime_type: a.mimeType,
        data: a.base64,
      })),
    {
      type: "text",
      text: prompt,
    },
  ];

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
        model: GEMINI_IMAGE_MODEL,
        input,
        response_format: [
          { type: "text" },
          {
            type: "image",
            mime_type: "image/png",
            aspect_ratio: normalizarAspectRatio(aspectRatio),
            image_size: normalizarImageSize(imageSize),
          },
        ],
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

    const imagem = extrairImagemInteraction(dados);

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
      texto: extrairTextoInteraction(dados),
      modelo: GEMINI_IMAGE_MODEL,
    };
  } finally {
    clearTimeout(timeout);
  }
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
  });
});

// Texto + arquivos
app.post("/ia/perguntar", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({
        ok: false,
        erro: "Serviço de IA não configurado.",
      });
    }

    const mensagem =
      typeof req.body?.mensagem === "string"
        ? req.body.mensagem.trim()
        : "";

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

    const resultadoPrincipal = await chamarGeminiComRetry(
      GEMINI_MODEL,
      mensagem,
      arquivos
    );

    if (resultadoPrincipal.sucesso) {
      return res.status(200).json({
        ok: true,
        resposta: resultadoPrincipal.resposta,
        modelo: resultadoPrincipal.modelo,
        fallback: false,
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
      arquivos
    );

    if (resultadoFallback.sucesso) {
      return res.status(200).json({
        ok: true,
        resposta: resultadoFallback.resposta,
        modelo: resultadoFallback.modelo,
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
// Para edição, envie imagens de referência no mesmo formato de "arquivos".
app.post("/ia/gerar-imagem", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({
        ok: false,
        erro: "Serviço de IA não configurado.",
      });
    }

    const prompt =
      typeof req.body?.prompt === "string"
        ? req.body.prompt.trim()
        : typeof req.body?.mensagem === "string"
          ? req.body.mensagem.trim()
          : "";

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

    const resultado = await gerarImagemGemini({
      prompt,
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
        "[Jisa IA] Falha na geração de imagem:",
        resultado.status,
        resultado.detalhes
      );

      if (resultado.status === 429) {
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

    return res.status(200).json({
      ok: true,
      tipo: "imagem",
      imagemBase64: resultado.imagemBase64,
      mimeType: resultado.mimeType,
      resposta: resultado.texto,
      modelo: resultado.modelo,
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
  console.log("==========================================");
});
