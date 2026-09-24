import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

const PORT = process.env.PORT || 10000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Modelo pode ser alterado no Render sem modificar o código.
const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.8-flash";

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
    modelo: GEMINI_MODEL,
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

    // Evita requisições exageradamente grandes vindas do aplicativo.
    if (mensagem.length > 8000) {
      return res.status(400).json({
        ok: false,
        erro: "A mensagem é muito grande.",
      });
    }

    const endpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${encodeURIComponent(GEMINI_MODEL)}:generateContent`;

    const body = {
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

    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, 30000);

    let respostaGoogle;

    try {
      respostaGoogle = await fetch(endpoint, {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY,
        },

        body: JSON.stringify(body),

        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    const textoResposta = await respostaGoogle.text();

    let dados;

    try {
      dados = JSON.parse(textoResposta);
    } catch {
      dados = null;
    }

    if (!respostaGoogle.ok) {
      console.error(
        "Erro Gemini:",
        respostaGoogle.status,
        textoResposta
      );

      if (respostaGoogle.status === 429) {
        return res.status(429).json({
          ok: false,
          erro:
            "O limite temporário da inteligência artificial foi atingido. " +
            "Tente novamente em alguns instantes.",
        });
      }

      return res.status(502).json({
        ok: false,
        erro: "Não foi possível consultar a inteligência artificial.",
      });
    }

    const resposta = extrairTextoGemini(dados);

    if (!resposta) {
      console.error(
        "Gemini retornou resposta sem texto:",
        JSON.stringify(dados)
      );

      return res.status(502).json({
        ok: false,
        erro: "A inteligência artificial não retornou uma resposta.",
      });
    }

    return res.status(200).json({
      ok: true,
      resposta,
      modelo: GEMINI_MODEL,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      console.error("Timeout na comunicação com Gemini.");

      return res.status(504).json({
        ok: false,
        erro: "A inteligência artificial demorou demais para responder.",
      });
    }

    console.error("Erro no endpoint /ia/perguntar:", error);

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
  console.log(`Modelo configurado: ${GEMINI_MODEL}`);
  console.log(
    `Gemini configurado: ${GEMINI_API_KEY ? "SIM" : "NÃO"}`
  );
  console.log("==========================================");
});
