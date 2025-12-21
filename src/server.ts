import Fastify from "fastify";
import { randomUUID, createHash } from "crypto";

type IdemRecord = {
  bodyHash: string;
  statusCode: number;
  responseBody: any;
  createdAt: string;
};

const IDEMPOTENCY_KEY_MAX = 64;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9-_.]+$/;

function hashBody(body: any) {
  const s = JSON.stringify(body ?? {}, Object.keys(body ?? {}).sort());
  return createHash("sha256").update(s).digest("hex");
}

export default function buildServer() {
  const fastify = Fastify();
  const idemStore = new Map<string, IdemRecord>();

  fastify.post("/v1/orders", async (request, reply) => {
    const raw = request.headers["idempotency-key"];
    const key = (Array.isArray(raw) ? raw[0] : raw ?? "").toString().trim();

    if (!key) {
      return reply
        .status(400)
        .send({ error: { message: "Idempotency-Key required" } });
    }
    if (key.length > IDEMPOTENCY_KEY_MAX || !IDEMPOTENCY_KEY_RE.test(key)) {
      return reply
        .status(400)
        .send({ error: { message: "Invalid Idempotency-Key format" } });
    }

    const body = request.body || {};
    const bodyHash = hashBody(body);

    const existing = idemStore.get(key);
    if (existing) {
      if (existing.bodyHash === bodyHash) {
        return reply.status(existing.statusCode).send(existing.responseBody);
      }
      return reply.status(409).send({
        error: {
          code: "IDEMPOTENCY_CONFLICT",
          message:
            "同じIdempotency-Keyが異なるリクエストボディで再利用されました。",
        },
      });
    }

    const orderId = "ord_" + randomUUID();
    const now = new Date().toISOString();
    const items = Array.isArray((body as any).items) ? (body as any).items : [];
    const totalAmount = items.reduce(
      (s: number, it: any) => s + (it.unitPrice || 0) * (it.quantity || 0),
      0
    );

    const resp = {
      orderId,
      status: "PENDING",
      totalAmount,
      currency: (body as any).currency || "JPY",
      createdAt: now,
    };

    idemStore.set(key, {
      bodyHash,
      statusCode: 201,
      responseBody: resp,
      createdAt: now,
    });
    return reply.status(201).send(resp);
  });

  return fastify;
}
