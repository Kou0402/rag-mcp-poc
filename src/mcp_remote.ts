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

// 末尾 / 必須
const DOC_BASE_URL =
  process.env.DOC_BASE_URL ||
  "https://github.com/Kou0402/rag-mcp-poc/blob/develop/";

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
 * ChatGPT/Connectors 側は tools/call の arguments が「文字列」になったり
 * { query } / { input } / { arguments } といった形で来ることがある。
 * ここで必ず { query, topK } に正規化する。
 */
function normalizeSearchArgs(raw: unknown): { query: string; topK: number } {
  const DEFAULT_TOPK = 8;

  const unwrap = (v: any): any => {
    if (!v || typeof v !== "object") return v;
    // 一部クライアントは { arguments: ... } や { input: ... } を二重に包む
    if ("arguments" in v) return unwrap((v as any).arguments);
    if ("input" in v) return unwrap((v as any).input);
    return v;
  };

  const v = unwrap(raw);

  if (typeof v === "string") {
    return { query: v, topK: DEFAULT_TOPK };
  }

  if (v && typeof v === "object") {
    const o: any = v;
    const q =
      typeof o.query === "string"
        ? o.query
        : typeof o.q === "string"
        ? o.q
        : undefined;

    const topK =
      typeof o.topK === "number" && Number.isFinite(o.topK)
        ? Math.max(1, Math.min(20, Math.trunc(o.topK)))
        : DEFAULT_TOPK;

    if (typeof q === "string") return { query: q, topK };
  }

  // どうしても取れない場合は空にして後段でエラー扱い
  return { query: "", topK: DEFAULT_TOPK };
}

function normalizeFetchArgs(raw: unknown): string {
  const unwrap = (v: any): any => {
    if (!v || typeof v !== "object") return v;
    if ("arguments" in v) return unwrap((v as any).arguments);
    if ("input" in v) return unwrap((v as any).input);
    return v;
  };

  const v = unwrap(raw);

  if (typeof v === "string") return v;

  if (v && typeof v === "object") {
    const o: any = v;
    if (typeof o.id === "string") return o.id;
  }

  return "";
}

async function main() {
  const raw = await fs.readFile(INDEX_FILE, "utf-8");
  const index = JSON.parse(raw) as IndexFile;

  const server = new McpServer({ name: "rag-mcp-poc", version: "1.0.0" });

  /**
   * 重要：
   * - schema を厳格にしすぎると、クライアント側の引数形の揺れで落ちる
   * - ここでは z.any() で受け、サーバ側で正規化する（現実運用で強い）
   */
  server.tool(
    "search",
    "Search knowledge base (Markdown docs) and return result list for citation.",
    z.any(),
    async (args) => {
      try {
        const { query, topK } = normalizeSearchArgs(args);
        const q = query.trim();

        if (!q) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "invalid_query",
                  message:
                    "search arguments did not contain a valid query string",
                }),
              },
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
          .slice(0, topK);

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

  server.tool(
    "fetch",
    "Fetch full text of a search result item by id.",
    z.any(),
    async (args) => {
      try {
        const id = normalizeFetchArgs(args).trim();

        if (!id) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "invalid_id",
                  message: "fetch arguments did not contain a valid id string",
                }),
              },
            ],
          };
        }

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

        return {
          content: [{ type: "text", text: JSON.stringify(doc) }],
        };
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

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await server.connect(transport);

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));

  // JSON-RPC method / tool名 / status を出す
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

      // arguments の形を確認したいときだけ（個人情報を含み得るので全部は出さない）
      const argType = typeof body?.params?.arguments;
      if (argType) console.error(`[RPC] argsType=${argType}`);
      if (argType === "object" && body?.params?.arguments) {
        console.error(
          `[RPC] argsKeys=${Object.keys(body.params.arguments).join(",")}`
        );
      }
    }

    res.on("finish", () => {
      console.error(`[RES] ${req.method} ${req.url} -> ${res.statusCode}`);
    });
    next();
  });

  app.get("/healthz", (_req, res) => res.status(200).send("ok"));

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
