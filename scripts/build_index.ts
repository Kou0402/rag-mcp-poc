import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { OpenAI } from "openai";

type ChunkMeta = {
  source: string; // e.g. docs/api.md
  heading: string; // e.g. 認証（API）
  part: number;
};

type IndexedChunk = {
  id: string;
  text: string;
  meta: ChunkMeta;
  embedding: number[];
};

const DOCS_DIR = path.resolve("docs");
const OUT_DIR = path.resolve("artifacts");
const OUT_FILE = path.join(OUT_DIR, "index.json");

// Embedding modelは環境で変わる可能性があるので、ここだけ差し替えればOK
const EMBEDDING_MODEL = "text-embedding-3-large";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function listMarkdownFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listMarkdownFiles(full)));
    else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) out.push(full);
  }
  return out.sort();
}

function splitByHeadings(
  md: string
): Array<{ heading: string; content: string }> {
  const lines = md.split(/\r?\n/);
  const blocks: Array<{ heading: string; content: string }> = [];
  let currentHeading = "（先頭）";
  let buf: string[] = [];

  const headingRe = /^(#{1,6})\s+(.*)$/;

  const flush = () => {
    const content = buf.join("\n").trim();
    if (content) blocks.push({ heading: currentHeading, content });
    buf = [];
  };

  for (const line of lines) {
    const m = line.match(headingRe);
    if (m) {
      flush();
      currentHeading = m[2].trim();
    } else {
      buf.push(line);
    }
  }
  flush();
  return blocks;
}

function chunkText(text: string, maxChars = 1500, overlap = 150): string[] {
  const normalized = text.replace(/\n{3,}/g, "\n\n").trim();
  if (normalized.length <= maxChars) return [normalized];

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(normalized.length, start + maxChars);
    chunks.push(normalized.slice(start, end));
    if (end === normalized.length) break;
    start = Math.max(0, end - overlap);
  }
  return chunks;
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const resp = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });
  return resp.data.map((d) => d.embedding as number[]);
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY が未設定です（.env を確認してください）");
  }

  await fs.mkdir(OUT_DIR, { recursive: true });

  const files = await listMarkdownFiles(DOCS_DIR);
  if (files.length === 0) throw new Error("docs/ に .md が見つかりません");

  const chunks: Omit<IndexedChunk, "embedding">[] = [];

  for (const file of files) {
    const rel = path.relative(process.cwd(), file).replace(/\\/g, "/");
    const md = await fs.readFile(file, "utf-8");
    const blocks = splitByHeadings(md);

    for (const b of blocks) {
      const parts = chunkText(b.content);
      for (let i = 0; i < parts.length; i++) {
        const id = `${rel}::${b.heading}::${i}`;
        chunks.push({
          id,
          text: parts[i],
          meta: { source: rel, heading: b.heading, part: i },
        });
      }
    }
  }

  console.log(`chunks: ${chunks.length}`);

  const indexed: IndexedChunk[] = [];
  const batchSize = 64;

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const embeddings = await embedBatch(batch.map((c) => c.text));

    for (let j = 0; j < batch.length; j++) {
      indexed.push({ ...batch[j], embedding: embeddings[j] });
    }

    console.log(
      `embedded: ${Math.min(i + batchSize, chunks.length)}/${chunks.length}`
    );
  }

  await fs.writeFile(
    OUT_FILE,
    JSON.stringify({ model: EMBEDDING_MODEL, chunks: indexed }, null, 2),
    "utf-8"
  );
  console.log(`written: ${OUT_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
