import "dotenv/config";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { OpenAI } from "openai";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

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
const PORT = Number(process.env.PORT || 8787);

// GitHub “引用URL” のベース（末尾 / 必須）
const DOC_BASE_URL =
  process.env.DOC_BASE_URL ||
  "https://github.com/Kou0402/rag-mcp-poc/blob/develop/";

// OpenAI
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
  if (source === "docs/api.md") return 1.15;
  if (source === "docs/architecture.md") return 1.1;
  if (source === "docs/overview.md") return 1.05;
  if (source === "docs/faq.md") return 0.95;
  return 1.0;
}

async function embedQuery(q: string, model: string): Promise<number[]> {
  const resp = await openai.embeddings.create({
    model,
    input: [q],
  });
  return resp.data[0].embedding as number[];
}

function canonicalUrlFor(meta: ChunkMeta): string {
  return `${DOC_BASE_URL}${meta.source}`;
}

/**
 * ChatGPT 側が渡してくる入力形式が揺れるのに備え、
 * string / {query} / {input} / {q} / {input:{query}} / {input:{q}} を全部受けて最終的に string に正規化する
 */
const SearchInput = z
  .union([
    z.string().min(1),
    z.object({
      query: z.string().min(1),
      topK: z.number().int().min(1).max(20).optional(),
    }),
    z.object({
      q: z.string().min(1),
      topK: z.number().int().min(1).max(20).optional(),
    }),
    z.object({ input: z.string().min(1) }),
    z.object({ input: z.object({ query: z.string().min(1) }) }),
    z.object({ input: z.object({ q: z.string().min(1) }) }),
  ])
  .transform((v) => {
    if (typeof v === "string") return { query: v, topK: 8 };
    if ("query" in v) return { query: v.query, topK: v.topK ?? 8 };
    if ("q" in v) return { query: v.q, topK: v.topK ?? 8 };
    if ("input" in v) {
      const inp: any = (v as any).input;
      if (typeof inp === "string") return { query: inp, topK: 8 };
      if (inp && typeof inp === "object") {
        if (typeof inp.query === "string") return { query: inp.query, topK: 8 };
        if (typeof inp.q === "string") return { query: inp.q, topK: 8 };
      }
    }
    // ここには来ない想定（念のため）
    return { query: String(v), topK: 8 };
  });

const FetchInput = z
  .union([
    z.string().min(1),
    z.object({ id: z.string().min(1) }),
    z.object({ input: z.string().min(1) }),
    z.object({ input: z.object({ id: z.string().min(1) }) }),
  ])
  .transform((v) => {
    if (typeof v === "string") return v;
    if ("id" in v) return v.id;
    if ("input" in v) {
      const inp: any = (v as any).input;
      if (typeof inp === "string") return inp;
      if (inp && typeof inp === "object" && typeof inp.id === "string")
        return inp.id;
    }
    return String(v);
  });

async function main() {
  // index 読み込み
  const raw = await fs.readFile(INDEX_FILE, "utf-8");
  const index = JSON.parse(raw) as IndexFile;

  // MCP Server
  const server = new McpServer({ name: "rag-mcp-poc", version: "1.0.0" });

  // search（ChatGPT 互換: tool名 search / 結果は content[0].type="text" に JSON文字列）
  server.tool(
    "search",
    "Search knowledge base (Markdown docs) and return result list for citation.",
    SearchInput,
    async ({ query, topK }) => {
      try {
        const k = topK ?? 8;

        // 念のため trim
        const q = query.trim();
        if (!q) {
          return {
            isError: true,
            content: [
              { type: "text", text: JSON.stringify({ error: "empty_query" }) },
            ],
          };
        }

        const qEmb = await embedQuery(q, index.model);

        const scored = index.chunks
          .map((c) => {
            const score = cosineSim(qEmb, c.embedding);
            const weighted = score * sourceWeight(c.meta.source);
            return { chunk: c, score, weighted };
          })
          .sort((a, b) => b.weighted - a.weighted)
          .slice(0, k);

        const results = scored.map(({ chunk }) => ({
          id: chunk.id,
          title: `${chunk.meta.heading} (${chunk.meta.source})`,
          url: canonicalUrlFor(chunk.meta),
        }));

        return {
          content: [{ type: "text", text: JSON.stringify({ results }) }],
        };
      } catch (e: any) {
        console.error("[TOOL_ERR][search]", e);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "search_failed",
                message: e?.message ?? String(e),
              }),
            },
          ],
        };
      }
    }
  );

  // fetch（ChatGPT 互換: tool名 fetch）
  server.tool(
    "fetch",
    "Fetch full text of a search result item by id.",
    FetchInput,
    async (id) => {
      try {
        const hit = index.chunks.find((c) => c.id === id);
        if (!hit) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  id,
                  title: "NOT_FOUND",
                  text: "",
                  url: DOC_BASE_URL,
                  metadata: { error: "not_found" },
                }),
              },
            ],
          };
        }

        const doc = {
          id: hit.id,
          title: `${hit.meta.heading} (${hit.meta.source})`,
          text: hit.text,
          url: canonicalUrlFor(hit.meta),
          metadata: hit.meta,
        };

        return { content: [{ type: "text", text: JSON.stringify(doc) }] };
      } catch (e: any) {
        console.error("[TOOL_ERR][fetch]", e);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "fetch_failed",
                message: e?.message ?? String(e),
              }),
            },
          ],
        };
      }
    }
  );

  // Streamable HTTP Transport（ステートレス）
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await server.connect(transport);

  // HTTP server
  const app = express();
  app.disable("x-powered-by");

  // JSON body
  app.use(express.json({ limit: "2mb" }));

  // Request logging（JSON-RPC method / tool名 / status まで出す）
  app.use((req, res, next) => {
    console.error(`[REQ] ${req.method} ${req.url}`);
    console.error(
      `[HDR] ct=${req.headers["content-type"]} len=${req.headers["content-length"]}`
    );

    const body: any = (req as any).body;
    if (body && typeof body === "object") {
      console.error(`[RPC] method=${body.method} id=${body.id ?? "null"}`);
      const toolName = body?.params?.name;
      if (toolName) console.error(`[RPC] tool=${toolName}`);
    }

    res.on("finish", () => {
      console.error(`[RES] ${req.method} ${req.url} -> ${res.statusCode}`);
    });
    next();
  });

  app.get("/healthz", (_req, res) => res.status(200).send("ok"));

  // MCP endpoint
  app.all("/mcp", async (req, res) => {
    try {
      await transport.handleRequest(req, res, (req as any).body);
    } catch (e) {
      console.error("[MCP_ERR]", e);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.error(`MCP server listening: http://localhost:${PORT}/mcp`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
