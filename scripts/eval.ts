import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
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

// 置き場所が違う場合はここを修正
const QUESTIONS_FILE_CANDIDATES = [
  path.resolve("evaluation_questions.md"),
  path.resolve("docs/evaluation_questions.md"),
  path.resolve("artifacts/evaluation_questions.md"),
];

const OUT_DIR = path.resolve("artifacts");
const OUT_FILE = path.join(OUT_DIR, "eval_phase1.md");

const TOP_K = 5;

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

// 一次情報優先
function sourceWeight(source: string): number {
  if (source === "docs/api.md") return 1.35;
  if (source === "docs/architecture.md") return 1.05;
  if (source === "docs/overview.md") return 1.05;
  if (source === "docs/faq.md") return 0.95;
  return 1.0;
}

// 質問意図に合わせて見出しを優先
function headingWeight(heading: string, query: string): number {
  const h = heading;

  // リトライ系
  if (query.includes("リトライ")) {
    if (h.includes("リトライ")) return 1.35;
    if (h.includes("バックオフ")) return 1.25;
    if (h.includes("POST /v1/orders")) return 1.05;
  }

  // 認証系
  if (query.includes("認証")) {
    if (h.includes("OAuth") || h.includes("認証")) return 1.25;
  }

  // レート制限系
  if (query.includes("レート") || query.includes("制限")) {
    if (h.includes("レート")) return 1.25;
  }

  // ステータス遷移系
  if (query.includes("遷移") || query.includes("ステータス")) {
    if (h.includes("遷移")) return 1.25;
    if (h.includes("PATCH")) return 1.05;
  }

  // 監査・ログ系
  if (query.includes("監査") || query.includes("ログ")) {
    if (h.includes("監査")) return 1.25;
    if (h.includes("可観測") || h.includes("Observability")) return 1.1;
  }

  // イベント/Kafka系
  if (query.includes("イベント") || query.includes("Kafka")) {
    if (h.includes("イベント")) return 1.25;
    if (h.includes("Kafka")) return 1.2;
  }

  // DB系
  if (
    query.includes("DB") ||
    query.includes("データベース") ||
    query.includes("正")
  ) {
    if (
      h.includes("PostgreSQL") ||
      h.includes("データ設計") ||
      h.includes("Database")
    )
      return 1.2;
  }

  // 返金/キャンセル権限系
  if (
    query.includes("返金") ||
    query.includes("キャンセル") ||
    query.includes("ロール") ||
    query.includes("権限")
  ) {
    if (h.includes("ロール") || h.includes("権限") || h.includes("監査"))
      return 1.15;
    if (h.includes("FAQ") || h.startsWith("Q")) return 1.05; // FAQでも拾えるよう軽く
  }

  return 1.0;
}

async function findQuestionsFile(): Promise<string> {
  for (const f of QUESTIONS_FILE_CANDIDATES) {
    try {
      await fs.access(f);
      return f;
    } catch {
      // continue
    }
  }
  throw new Error(
    `evaluation_questions.md が見つかりません。候補: \n- ${QUESTIONS_FILE_CANDIDATES.join(
      "\n- "
    )}\n` +
      `ファイル位置に合わせて QUESTIONS_FILE_CANDIDATES を修正してください。`
  );
}

function parseQuestions(md: string): string[] {
  // 1) 先頭の "1. xxx" / "1) xxx" / "- xxx" みたいなのを拾う
  const lines = md.split(/\r?\n/).map((l) => l.trim());
  const qs: string[] = [];

  for (const line of lines) {
    if (!line) continue;

    const m1 = line.match(/^\d+[\.\)]\s*(.+)$/); // 1. / 1)
    if (m1?.[1]) {
      qs.push(m1[1].trim());
      continue;
    }

    const m2 = line.match(/^[-*]\s+(.+)$/); // - / *
    if (m2?.[1]) {
      qs.push(m2[1].trim());
      continue;
    }

    // "Q1: xxx" 形式も許容
    const m3 = line.match(/^Q\d+[:：]\s*(.+)$/i);
    if (m3?.[1]) {
      qs.push(m3[1].trim());
      continue;
    }
  }

  // 2) それでも取れない場合、本文中の "?" を含む行を拾う（保険）
  if (qs.length === 0) {
    for (const line of lines) {
      if (line.includes("?") || line.includes("？")) qs.push(line);
    }
  }

  return qs;
}

async function main() {
  if (!process.env.OPENAI_API_KEY)
    throw new Error("OPENAI_API_KEY が未設定です（.env を確認）");

  await fs.mkdir(OUT_DIR, { recursive: true });

  const indexRaw = await fs.readFile(INDEX_FILE, "utf-8");
  const index = JSON.parse(indexRaw) as IndexFile;

  const qFile = await findQuestionsFile();
  const qRaw = await fs.readFile(qFile, "utf-8");
  const questions = parseQuestions(qRaw);

  if (questions.length === 0)
    throw new Error(
      "質問が1件も抽出できませんでした。evaluation_questions.md の形式を確認してください。"
    );

  const header =
    `# フェーズ1 自動評価結果\n\n` +
    `- questions_file: ${path
      .relative(process.cwd(), qFile)
      .replace(/\\/g, "/")}\n` +
    `- index_file: ${path
      .relative(process.cwd(), INDEX_FILE)
      .replace(/\\/g, "/")}\n` +
    `- embedding_model: ${index.model}\n` +
    `- top_k: ${TOP_K}\n\n` +
    `> 判定（OK/NG）はこのファイル上で手作業で付ける想定（次フェーズで ground_truth_map による自動判定も可能）\n\n`;

  const sections: string[] = [header];

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi];

    console.log(`evaluating ${qi + 1}/${questions.length}: ${q}`);

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
      .slice(0, TOP_K);

    sections.push(`## Q${qi + 1}. ${q}\n`);
    sections.push(`- ✅判定: （OK / NG）\n`);
    sections.push(`- メモ:\n\n`);

    for (let i = 0; i < scored.length; i++) {
      const { chunk, score, weighted } = scored[i];
      const preview = chunk.text.replace(/\s+/g, " ").slice(0, 240);
      sections.push(
        `### Top ${i + 1}\n` +
          `- weighted: ${weighted.toFixed(4)}\n` +
          `- score: ${score.toFixed(4)}\n` +
          `- source: ${chunk.meta.source}\n` +
          `- heading: ${chunk.meta.heading}\n` +
          `- part: ${chunk.meta.part}\n` +
          `- preview: ${preview}${chunk.text.length > 240 ? "..." : ""}\n`
      );
    }

    sections.push("\n---\n");
  }

  await fs.writeFile(OUT_FILE, sections.join("\n"), "utf-8");
  console.log(
    `\nwritten: ${path.relative(process.cwd(), OUT_FILE).replace(/\\/g, "/")}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
