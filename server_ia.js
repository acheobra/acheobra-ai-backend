import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

const PORT = process.env.PORT || 10000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Modelo principal configurável pelo Render.
const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.8-flash";

// Modelo alternativo.
// A documentação atual da Google recomenda o 3.5 Flash-Lite
// como uma das opções para novos projetos.
const GEMINI_FALLBACK_MODEL =
  process.env.GEMINI_FALLBACK_MODEL || "gemini-3.5-flash-lite";

// Quantidade máxima de tentativas por modelo.
const MAX_TENTATIVAS = 3;

// Timeout individual de cada chamada ao Gemini.
const TIMEOUT_GEMINI_MS = 30000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ======================================================
// CONFIGURAÇÃO DA IA DO ACHE OBRA
// ======================================================

const INSTRUCAO_SISTEMA = `
Você é a inteligência artificial do aplicativo Ache Obra.

O Ache Obra é uma plataforma voltada à construção civil que conecta
clientes, profissionais, arquitetos e engenheiros.

Sua função é ajudar os usuários com assuntos relacionados a:

- construção civil;
- reformas;
- manutenção;
- materiais de construção;
- planejamento de obras;
- descrição de serviços;
- elaboração e melhoria de pedidos de orçamento;
- organização de demandas;
- dúvidas gerais sobre serviços da construção civil;
- orientação para encontrar o tipo adequado de profissional;
- arquitetura;
- engenharia;
- serviços residenciais e comerciais.

Responda sempre em português do Brasil, a menos que o usuário peça
explicitamente outro idioma.

Seja claro, objetivo, educado e útil.

Quando valores, quantidades ou custos dependerem da região,
materiais, mão de obra ou condições específicas da obra,
deixe claro que são estimativas.

Não invente preços, normas técnicas, leis ou informações que não
tenha segurança para fornecer.

Quando uma questão exigir avaliação presencial de engenheiro,
arquiteto, eletricista, profissional habilitado ou outro especialista,
deixe isso claro ao usuário.

Você representa a IA integrada ao aplicativo Ache Obra.
`;

// ======================================================
// FUNÇÕES AUXILIARES
// ======================================================

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extrairTextoGemini(data) {
  const candidates = data?.candidates;

  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  const parts = candidates[0]?.content?.parts;

  if (!Array.isArray(parts)) {
    return null;
  }

  const textos = parts
    .filter((part) => typeof part?.text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean);

  if (textos.length === 0) {
    return null;
  }

  return textos.join("\n");
}

function criarBodyGemini(mensagem) {
  return {
    systemInstruction: {
      parts: [
        {
          text: INSTRUCAO_SISTEMA,
        },
      ],
    },

    contents: [
      {
        role: "user",
        parts: [
          {
            text: mensagem,
          },
        ],
      },
    ],

    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1500,
    },
  };
}

// ======================================================
// CHAMADA INDIVIDUAL AO GEMINI
// ======================================================

async function chamarGemini(modelo, mensagem) {
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(modelo)}:generateContent`;

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_GEMINI_MS);

  try {
    const respostaGoogle = await fetch(endpoint, {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY,
      },

      body: JSON.stringify(criarBodyGemini(mensagem)),

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

// ======================================================
// RETRY COM EXPONENTIAL BACKOFF
// ======================================================

async function chamarGeminiComRetry(modelo, mensagem) {
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    try {
      console.log(
        `[Gemini] Modelo ${modelo} - tentativa ${tentativa}/${MAX_TENTATIVAS}`
      );

      const resultado = await chamarGemini(modelo, mensagem);

      if (resultado.ok) {
        const resposta = extrairTextoGemini(resultado.dados);

        if (!resposta) {
          console.error(
            `[Gemini] Modelo ${modelo} retornou resposta sem texto:`,
            JSON.stringify(resultado.dados)
          );

          return {
            sucesso: false,
            tipo: "SEM_TEXTO",
            status: resultado.status,
            modelo,
          };
        }

        console.log(
          `[Gemini] Resposta obtida com sucesso usando ${modelo}.`
        );

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

      // --------------------------------------------------
      // 429 = limite/capacidade temporária
      // 503 = serviço/modelo temporariamente indisponível
      //
      // A documentação da Google recomenda retry com
      // exponential backoff nesses casos.
      // --------------------------------------------------

      if (
        resultado.status === 429 ||
        resultado.status === 503
      ) {
        if (tentativa < MAX_TENTATIVAS) {
          // 2s -> 4s
          const esperaMs = 2000 * Math.pow(2, tentativa - 1);

          console.log(
            `[Gemini] Erro temporário ${resultado.status}. ` +
            `Nova tentativa em ${esperaMs / 1000}s.`
          );

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

      // Erros como 400, 401, 403 e 404 não devem ficar
      // sendo repetidos automaticamente.
      return {
        sucesso: false,
        tipo: "ERRO_API",
        status: resultado.status,
        modelo,
        detalhes: resultado.dados,
      };
    } catch (error) {
      if (error?.name === "AbortError") {
        console.error(
          `[Gemini] Timeout no modelo ${modelo}, tentativa ${tentativa}.`
        );

        if (tentativa < MAX_TENTATIVAS) {
          const esperaMs = 2000 * Math.pow(2, tentativa - 1);

          console.log(
            `[Gemini] Nova tentativa após timeout em ` +
            `${esperaMs / 1000}s.`
          );

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

      console.error(
        `[Gemini] Erro inesperado no modelo ${modelo}:`,
        error
      );

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

// ======================================================
// ROTA PRINCIPAL
// ======================================================

app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    servico: "Ache Obra IA",
    status: "online",
  });
});

// ======================================================
// HEALTH CHECK
// ======================================================

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    servico: "Ache Obra IA",
    gemini_configurado: Boolean(GEMINI_API_KEY),
    modelo_principal: GEMINI_MODEL,
    modelo_fallback: GEMINI_FALLBACK_MODEL,
  });
});

// ======================================================
// ENDPOINT DA IA
// ======================================================

app.post("/ia/perguntar", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      console.error("GEMINI_API_KEY não configurada.");

      return res.status(500).json({
        ok: false,
        erro: "Serviço de IA não configurado.",
      });
    }

    const mensagem =
      typeof req.body?.mensagem === "string"
        ? req.body.mensagem.trim()
        : "";

    if (!mensagem) {
      return res.status(400).json({
        ok: false,
        erro: "Informe uma mensagem.",
      });
    }

    if (mensagem.length > 8000) {
      return res.status(400).json({
        ok: false,
        erro: "A mensagem é muito grande.",
      });
    }

    // ==================================================
    // 1. MODELO PRINCIPAL
    // ==================================================

    console.log(
      `[Ache Obra IA] Consultando modelo principal: ${GEMINI_MODEL}`
    );

    const resultadoPrincipal =
      await chamarGeminiComRetry(
        GEMINI_MODEL,
        mensagem
      );

    if (resultadoPrincipal.sucesso) {
      return res.status(200).json({
        ok: true,
        resposta: resultadoPrincipal.resposta,
        modelo: resultadoPrincipal.modelo,
        fallback: false,
      });
    }

    // ==================================================
    // DECIDE SE DEVEMOS USAR FALLBACK
    // ==================================================
    //
    // Só usamos fallback em situações temporárias:
    // 429, 503 ou timeout.
    //
    // Não usamos fallback para chave inválida, payload
    // incorreto, permissão etc.
    // ==================================================

    const podeUsarFallback = [
      "LIMITE_TEMPORARIO",
      "INDISPONIVEL",
      "TIMEOUT",
    ].includes(resultadoPrincipal.tipo);

    if (!podeUsarFallback) {
      console.error(
        "[Ache Obra IA] Erro não recuperável no modelo principal:",
        resultadoPrincipal
      );

      return res.status(502).json({
        ok: false,
        erro: "Não foi possível consultar a inteligência artificial.",
      });
    }

    // ==================================================
    // 2. MODELO FALLBACK
    // ==================================================

    if (GEMINI_FALLBACK_MODEL === GEMINI_MODEL) {
      console.error(
        "[Ache Obra IA] Modelo fallback é igual ao modelo principal."
      );

      return res.status(503).json({
        ok: false,
        erro:
          "A inteligência artificial está temporariamente indisponível. " +
          "Tente novamente em alguns instantes.",
      });
    }

    console.warn(
      `[Ache Obra IA] Modelo principal indisponível. ` +
      `Tentando fallback: ${GEMINI_FALLBACK_MODEL}`
    );

    const resultadoFallback =
      await chamarGeminiComRetry(
        GEMINI_FALLBACK_MODEL,
        mensagem
      );

    if (resultadoFallback.sucesso) {
      console.log(
        `[Ache Obra IA] Fallback utilizado com sucesso: ` +
        `${resultadoFallback.modelo}`
      );

      return res.status(200).json({
        ok: true,
        resposta: resultadoFallback.resposta,
        modelo: resultadoFallback.modelo,
        fallback: true,
      });
    }

    // ==================================================
    // NENHUM MODELO RESPONDEU
    // ==================================================

    console.error(
      "[Ache Obra IA] Modelo principal e fallback indisponíveis.",
      {
        principal: resultadoPrincipal,
        fallback: resultadoFallback,
      }
    );

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
    console.error(
      "Erro inesperado no endpoint /ia/perguntar:",
      error
    );

    return res.status(500).json({
      ok: false,
      erro: "Erro interno no serviço de inteligência artificial.",
    });
  }
});

// ======================================================
// ROTA NÃO ENCONTRADA
// ======================================================

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    erro: "Rota não encontrada.",
  });
});

// ======================================================
// INICIALIZAÇÃO
// ======================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log("==========================================");
  console.log("ACHE OBRA - BACKEND DE INTELIGÊNCIA ARTIFICIAL");
  console.log(`Servidor iniciado na porta ${PORT}`);
  console.log(`Modelo principal: ${GEMINI_MODEL}`);
  console.log(`Modelo fallback: ${GEMINI_FALLBACK_MODEL}`);
  console.log(
    `Gemini configurado: ${GEMINI_API_KEY ? "SIM" : "NÃO"}`
  );
  console.log("==========================================");
});
