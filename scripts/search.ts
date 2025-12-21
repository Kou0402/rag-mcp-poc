import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
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

async function embedQuery(q: string, model: string): Promise<number[]> {
  const resp = await openai.embeddings.create({
    model,
    input: [q],
  });
  return resp.data[0].embedding as number[];
}

function sourceWeight(source: string): number {
  if (source === "docs/api.md") return 1.35;
  if (source === "docs/architecture.md") return 1.05;
  if (source === "docs/overview.md") return 1.05;
  if (source === "docs/faq.md") return 0.95;
  return 1.0;
}

function headingWeight(heading: string, query: string): number {
  const q = query;
  const h = heading;

  // リトライ系
  if (q.includes("リトライ")) {
    if (h.includes("リトライ")) return 1.35;
    if (h.includes("バックオフ")) return 1.25;
    if (h.includes("POST /v1/orders")) return 1.05; // 注文作成節も少しは関連
  }

  // 認証系（今回Q1はもうOKだが例）
  if (q.includes("認証")) {
    if (h.includes("OAuth") || h.includes("認証")) return 1.25;
  }

  return 1.0;
}

async function main() {
  const raw = await fs.readFile(INDEX_FILE, "utf-8");
  const index = JSON.parse(raw) as IndexFile;

  const rl = readline.createInterface({ input, output });

  console.log(`loaded: ${index.chunks.length} chunks`);
  console.log(`embedding model: ${index.model}`);
  console.log("Enter empty line to quit.");

  try {
    while (true) {
      const q = (await rl.question("\nquery> ")).trim();
      if (!q) break;

      const qEmb = await embedQuery(q, index.model);

      const scored = index.chunks
        .map((c) => {
          const score = cosineSim(qEmb, c.embedding);
          const weighted =
            score *
            sourceWeight(c.meta.source) *
            headingWeight(c.meta.heading, q);
          return { chunk: c, score, weighted };
        })
        .sort((a, b) => b.weighted - a.weighted)
        .slice(0, 5);

      for (let i = 0; i < scored.length; i++) {
        const { chunk, score, weighted } = scored[i]; // ←ここが重要
        const preview = chunk.text.replace(/\s+/g, " ").slice(0, 220);
        console.log(
          `\n[${i + 1}] weighted=${weighted.toFixed(4)} score=${score.toFixed(
            4
          )} source=${chunk.meta.source} heading=${chunk.meta.heading} part=${
            chunk.meta.part
          }`
        );
        console.log(preview + (chunk.text.length > 220 ? "..." : ""));
      }
    }
  } finally {
    // 例外が起きてもハンドルをきれいに閉じる（Windowsでの変なassertを避ける）
    await rl.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
