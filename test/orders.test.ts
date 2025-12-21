import test from "node:test";
import assert from "node:assert/strict";
import buildServer from "../src/server.ts";

test("POST /v1/orders idempotency", async () => {
  const fastify = buildServer();
  await fastify.ready();

  const key = "key-123";
  const body = {
    customerId: "cus_1",
    currency: "JPY",
    items: [{ sku: "SKU-1", quantity: 1, unitPrice: 100 }],
  };

  // キーなし → 400
  {
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/orders",
      payload: { customerId: "c" },
    });
    assert.equal(res.statusCode, 400);
  }

  // 同一キー同一ボディを2回 → 同一結果
  let b1: any;
  {
    const r1 = await fastify.inject({
      method: "POST",
      url: "/v1/orders",
      headers: { "idempotency-key": key },
      payload: body,
    });
    assert.equal(r1.statusCode, 201);
    b1 = JSON.parse(r1.body);

    const r2 = await fastify.inject({
      method: "POST",
      url: "/v1/orders",
      headers: { "idempotency-key": key },
      payload: body,
    });
    assert.equal(r2.statusCode, 201);
    const b2 = JSON.parse(r2.body);

    assert.equal(b2.orderId, b1.orderId);
    assert.deepEqual(b2, b1);
  }

  // 同一キー異なるボディ → 409
  {
    const r = await fastify.inject({
      method: "POST",
      url: "/v1/orders",
      headers: { "idempotency-key": key },
      payload: { ...body, customerId: "cus_2" }, // ←確実に差分
    });

    assert.equal(r.statusCode, 409);
    const jb = JSON.parse(r.body);
    assert.equal(jb.error.code, "IDEMPOTENCY_CONFLICT");
  }

  // 長すぎキー → 400
  {
    const badKey = "x".repeat(65);
    const r = await fastify.inject({
      method: "POST",
      url: "/v1/orders",
      headers: { "idempotency-key": badKey },
      payload: body,
    });
    assert.equal(r.statusCode, 400);
  }

  await fastify.close();
});
