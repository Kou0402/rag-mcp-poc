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

// Render は PORT を環境変数で渡す（ローカルは 8787 などでOK）
const PORT = Number(process.env.PORT || 8787);

// GitHub の “引用URL” を組み立てるためのベース（あなたのURLに差し替えてOK）
const DOC_BASE_URL =
  process.env.DOC_BASE_URL ||
  "https://github.com/<OWNER>/rag-mcp-poc/blob/main/";

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
  // 「一次情報を上げる」の例（必要なら調整）
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
  // “チャンク”単位の厳密なアンカーは作りにくいので、まずはファイルURLでOK（引用用）
  return `${DOC_BASE_URL}${meta.source}`;
}

async function main() {
  const raw = await fs.readFile(INDEX_FILE, "utf-8");
  const index = JSON.parse(raw) as IndexFile;

  // MCP Server
  const server = new McpServer({ name: "rag-mcp-poc", version: "1.0.0" });

  /**
   * ChatGPT Connectors / deep research 互換：
   * 必須ツール名が search / fetch で、返り値は content[0].type="text" に JSON 文字列を入れる :contentReference[oaicite:3]{index=3}
   */
  server.tool(
    "search",
    "Search knowledge base (Markdown docs) and return result list for citation.",
    {
      // OpenAI の説明は「単一の query string」だが、MCP 的には JSON で受けるので {query} にしておく :contentReference[oaicite:4]{index=4}
      query: z.string().min(1),
      topK: z.number().int().min(1).max(20).optional(),
    },
    async ({ query, topK }) => {
      const k = topK ?? 8;

      const qEmb = await embedQuery(query, index.model);

      const scored = index.chunks
        .map((c) => {
          const score = cosineSim(qEmb, c.embedding);
          const weighted = score * sourceWeight(c.meta.source);
          return { chunk: c, score, weighted };
        })
        .sort((a, b) => b.weighted - a.weighted)
        .slice(0, k);

      const results = scored.map(({ chunk }) => ({
        id: chunk.id, // fetch で再利用するユニークID
        title: `${chunk.meta.heading} (${chunk.meta.source})`,
        url: canonicalUrlFor(chunk.meta),
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ results }),
          },
        ],
      };
    }
  );

  server.tool(
    "fetch",
    "Fetch full text of a search result item by id.",
    {
      id: z.string().min(1),
    },
    async ({ id }) => {
      const hit = index.chunks.find((c) => c.id === id);
      if (!hit) {
        // fetch の仕様は「1つのオブジェクト」なので、not found は text にエラーを入れて返す
        return {
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

      return {
        content: [{ type: "text", text: JSON.stringify(doc) }],
      };
    }
  );

  // Streamable HTTP Transport（ステートレス）
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // ステートレス :contentReference[oaicite:5]{index=5}
  });

  await server.connect(transport);

  // HTTP server
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/healthz", (_req, res) => res.status(200).send("ok"));

  // MCP endpoint
  app.post("/mcp", async (req, res) => {
    try {
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // GET /mcp は SSE をやらないなら 405 でOK :contentReference[oaicite:6]{index=6}
  app.get("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  // ステートフルでなければ DELETE も 405 でOK :contentReference[oaicite:7]{index=7}
  app.delete("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.error(`MCP server listening: http://localhost:${PORT}/mcp`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
