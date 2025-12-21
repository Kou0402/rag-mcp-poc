import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { OpenAI } from "openai";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

type ChunkMeta = { source: string; heading: string; part: number };
type IndexedChunk = {
  id: string;
  text: string;
  meta: ChunkMeta;
  embedding: number[];
};
type IndexFile = { model: string; chunks: IndexedChunk[] };

const INDEX_FILE = path.resolve("artifacts/index.json");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- similarity helpers ----
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
  // 一次情報を優先（必要なら調整）
  if (source === "docs/api.md") return 1.15;
  if (source === "docs/architecture.md") return 1.1;
  if (source === "docs/overview.md") return 1.05;
  if (source === "docs/faq.md") return 0.95;
  return 1.0;
}

async function loadIndex(): Promise<IndexFile> {
  const raw = await fs.readFile(INDEX_FILE, "utf-8");
  return JSON.parse(raw) as IndexFile;
}

async function embedQuery(q: string, model: string): Promise<number[]> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set.");
  }
  const resp = await openai.embeddings.create({ model, input: [q] });
  return resp.data[0].embedding as number[];
}

// ---- MCP server ----
const server = new McpServer({
  name: "rag-mcp-poc",
  version: "0.1.0",
});

let index: IndexFile;

server.registerTool(
  "rag_search",
  {
    description:
      "Search the shared knowledge base (artifacts/index.json) and return top matches with scores.",
    inputSchema: {
      query: z.string().min(1).describe("Natural language query"),
      topK: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Top K (default: 5)"),
    },
  },
  async ({ query, topK }) => {
    const k = topK ?? 5;

    const qEmb = await embedQuery(query, index.model);

    const scored = index.chunks
      .map((c) => {
        const score = cosineSim(qEmb, c.embedding);
        const weighted = score * sourceWeight(c.meta.source);
        const preview = c.text.replace(/\s+/g, " ").slice(0, 280);
        return {
          id: c.id,
          score,
          weighted,
          source: c.meta.source,
          heading: c.meta.heading,
          part: c.meta.part,
          preview,
        };
      })
      .sort((a, b) => b.weighted - a.weighted)
      .slice(0, k);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ model: index.model, hits: scored }, null, 2),
        },
      ],
    };
  }
);

server.registerTool(
  "rag_get_chunk",
  {
    description: "Get the full chunk text (and meta) by chunk id.",
    inputSchema: {
      id: z.string().min(1).describe("Chunk id (from rag_search result)"),
    },
  },
  async ({ id }) => {
    const hit = index.chunks.find((c) => c.id === id);
    if (!hit) {
      return {
        content: [{ type: "text", text: `NOT_FOUND: ${id}` }],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              id: hit.id,
              source: hit.meta.source,
              heading: hit.meta.heading,
              part: hit.meta.part,
              text: hit.text,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

async function main() {
  index = await loadIndex();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("rag-mcp-poc MCP server running on stdio");
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
