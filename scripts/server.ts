import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import { z } from "zod";
import { OpenAI } from "openai";

type ChunkMeta = { source: string; heading: string; part: number };

type IndexedChunk = {
  id: string;
  text: string;
  meta: ChunkMeta;
  embedding: number[];
};

type IndexFile = {
  model: string;
  chunks: IndexedChunk[];
};

const INDEX_FILE = path.resolve("artifacts/index.json");
const PORT = Number(process.env.PORT ?? "8787");

// 生成モデル（必要なら変更）
const GEN_MODEL = process.env.GEN_MODEL ?? "gpt-5-mini";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function dot(a: number[], b: number[]) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
function norm(a: number[]) {
  return Math.sqrt(dot(a, a));
}
function cosineSim(a: number[], b: number[]) {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

function sourceWeight(source: string): number {
  if (source === "docs/api.md") return 1.35;
  if (source === "docs/architecture.md") return 1.05;
  if (source === "docs/overview.md") return 1.05;
  if (source === "docs/faq.md") return 0.95;
  return 1.0;
}

// フェーズ1で作ったものを流用（必要最低限。精密化は後でOK）
function headingWeight(heading: string, query: string): number {
  const h = heading;

  if (query.includes("リトライ")) {
    if (h.includes("リトライ")) return 1.35;
    if (h.includes("バックオフ")) return 1.25;
    if (h.includes("POST /v1/orders")) return 1.05;
  }
  if (query.includes("認証")) {
    if (h.includes("OAuth") || h.includes("認証")) return 1.25;
  }
  return 1.0;
}

async function embedQuery(q: string, model: string): Promise<number[]> {
  const resp = await openai.embeddings.create({ model, input: [q] });
  return resp.data[0].embedding as number[];
}

function formatCitations(chunks: IndexedChunk[]) {
  // 出典はシンプルに source + heading で十分（後で行番号など拡張）
  return chunks.map((c) => ({
    source: c.meta.source,
    heading: c.meta.heading,
    part: c.meta.part,
    id: c.id,
  }));
}

async function main() {
  if (!process.env.OPENAI_API_KEY)
    throw new Error("OPENAI_API_KEY が未設定です");

  const raw = await fs.readFile(INDEX_FILE, "utf-8");
  const index = JSON.parse(raw) as IndexFile;

  const app = Fastify({ logger: true });

  // --- /search ---
  app.post("/search", async (req, reply) => {
    const Body = z.object({
      query: z.string().min(1),
      topK: z.number().int().min(1).max(20).default(5),
    });
    const { query, topK } = Body.parse(req.body);

    const qEmb = await embedQuery(query, index.model);

    const hits = index.chunks
      .map((c) => {
        const score = cosineSim(qEmb, c.embedding);
        const weighted =
          score *
          sourceWeight(c.meta.source) *
          headingWeight(c.meta.heading, query);
        return { chunk: c, score, weighted };
      })
      .sort((a, b) => b.weighted - a.weighted)
      .slice(0, topK)
      .map(({ chunk, score, weighted }) => ({
        id: chunk.id,
        score,
        weighted,
        source: chunk.meta.source,
        heading: chunk.meta.heading,
        part: chunk.meta.part,
        preview: chunk.text.replace(/\s+/g, " ").slice(0, 240),
      }));

    return reply.send({ model: index.model, hits });
  });

  // --- /fetch ---
  app.get("/fetch", async (req, reply) => {
    const Query = z.object({ id: z.string().min(1) });
    const { id } = Query.parse(req.query);

    const found = index.chunks.find((c) => c.id === id);
    if (!found) return reply.code(404).send({ error: "not_found" });

    return reply.send({
      id: found.id,
      text: found.text,
      source: found.meta.source,
      heading: found.meta.heading,
      part: found.meta.part,
    });
  });

  // --- /answer (RAG) ---
  app.post("/answer", async (req, reply) => {
    const Body = z.object({
      question: z.string().min(1),
      topK: z.number().int().min(1).max(20).default(8),
    });
    const { question, topK } = Body.parse(req.body);

    // 1) retrieve
    const qEmb = await embedQuery(question, index.model);

    const top = index.chunks
      .map((c) => {
        const score = cosineSim(qEmb, c.embedding);
        const weighted =
          score *
          sourceWeight(c.meta.source) *
          headingWeight(c.meta.heading, question);
        return { chunk: c, weighted };
      })
      .sort((a, b) => b.weighted - a.weighted)
      .slice(0, topK)
      .map((x) => x.chunk);

    // 2) build context
    const context = top
      .map((c, i) => {
        return `【${i + 1}】source=${c.meta.source} heading=${
          c.meta.heading
        }\n${c.text}`;
      })
      .join("\n\n");

    // 3) generate (Responses API)
    const instructions =
      "あなたは注文管理システム(OrderHub)の仕様書アシスタントです。与えられた根拠だけを使って回答してください。根拠に無いことは推測せず「不明」と言ってください。最後に参照した根拠番号（【1】など）を列挙してください。";

    const resp = await openai.responses.create({
      model: GEN_MODEL,
      instructions,
      input: `質問: ${question}\n\n根拠:\n${context}\n\n回答:`,
    });

    const answerText = resp.output_text ?? "(no output_text)";

    return reply.send({
      question,
      answer: answerText,
      citations: formatCitations(top),
      used_context_count: top.length,
    });
  });

  await app.listen({ port: PORT, host: "0.0.0.0" });
  app.log.info(`server listening on http://localhost:${PORT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
