/**
 * Tests for webhook transport: signature verification, validation handler,
 * WebhookTransport dispatch.
 */
import { describe, it, expect, vi } from "vitest";
import {
  ed25519Sign,
  verifyWebhookSignature,
  signValidationResponse,
} from "../src/protocol/transport/webhook-verify.js";
import { WebhookTransport } from "../src/protocol/transport/webhook.js";
import type {
  EventTransportCallbacks,
  WebhookServerAdapter,
  WebhookRequest,
  WebhookRequestHandler,
  WebhookResponse,
} from "../src/protocol/transport/types.js";

const TEST_SECRET = "DG5g3B4j9X2KOErG";
const TEST_APP_ID = "11111111";

// ============ Ed25519 sign + verify ============

describe("ed25519Sign + verifyWebhookSignature", () => {
  it("sign then verify roundtrip", () => {
    const timestamp = "1725442341";
    const body = Buffer.from('{"op":0,"t":"C2C_MESSAGE_CREATE","d":{}}', "utf-8");
    const signature = ed25519Sign(TEST_SECRET, Buffer.concat([Buffer.from(timestamp), body]));

    expect(typeof signature).toBe("string");
    expect(signature.length).toBe(128); // Ed25519 signature = 64 bytes = 128 hex chars

    const valid = verifyWebhookSignature({
      body,
      timestamp,
      signature,
      botSecret: TEST_SECRET,
    });
    expect(valid).toBe(true);
  });

  it("rejects tampered body", () => {
    const timestamp = "1725442341";
    const body = Buffer.from('{"op":0}', "utf-8");
    const signature = ed25519Sign(TEST_SECRET, Buffer.concat([Buffer.from(timestamp), body]));

    const valid = verifyWebhookSignature({
      body: Buffer.from('{"op":1}', "utf-8"), // tampered
      timestamp,
      signature,
      botSecret: TEST_SECRET,
    });
    expect(valid).toBe(false);
  });

  it("rejects wrong secret", () => {
    const timestamp = "1725442341";
    const body = Buffer.from("hello", "utf-8");
    const signature = ed25519Sign(TEST_SECRET, Buffer.concat([Buffer.from(timestamp), body]));

    const valid = verifyWebhookSignature({
      body,
      timestamp,
      signature,
      botSecret: "wrong_secret_12345678",
    });
    expect(valid).toBe(false);
  });
});

// ============ signValidationResponse (op:13) ============

describe("signValidationResponse", () => {
  it("returns plain_token and hex signature", () => {
    const result = signValidationResponse({
      plainToken: "Arq0D5A61EgUu4OxUvOp",
      eventTs: "1725442341",
      botSecret: TEST_SECRET,
    });

    expect(result.plain_token).toBe("Arq0D5A61EgUu4OxUvOp");
    expect(typeof result.signature).toBe("string");
    expect(result.signature.length).toBe(128);
  });

  it("signature is deterministic", () => {
    const a = signValidationResponse({ plainToken: "abc", eventTs: "123", botSecret: TEST_SECRET });
    const b = signValidationResponse({ plainToken: "abc", eventTs: "123", botSecret: TEST_SECRET });
    expect(a.signature).toBe(b.signature);
  });

  it("different inputs produce different signatures", () => {
    const a = signValidationResponse({ plainToken: "abc", eventTs: "123", botSecret: TEST_SECRET });
    const b = signValidationResponse({ plainToken: "def", eventTs: "123", botSecret: TEST_SECRET });
    expect(a.signature).not.toBe(b.signature);
  });
});

// ============ WebhookTransport ============

/** Fake server adapter that captures the handler for direct invocation. */
class FakeServer implements WebhookServerAdapter {
  handler: WebhookRequestHandler | null = null;
  closed = false;

  async listen(_port: number, _path: string, handler: WebhookRequestHandler): Promise<void> {
    this.handler = handler;
  }

  close(): void {
    this.closed = true;
  }

  /** Simulate an incoming request. */
  async invoke(req: WebhookRequest): Promise<WebhookResponse> {
    if (!this.handler) throw new Error("not started");
    return this.handler(req);
  }
}

function makeSignedRequest(body: string, secret: string): WebhookRequest {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyBuf = Buffer.from(body, "utf-8");
  const signature = ed25519Sign(secret, Buffer.concat([Buffer.from(timestamp), bodyBuf]));
  return {
    body: bodyBuf,
    headers: {
      "x-signature-timestamp": timestamp,
      "x-signature-ed25519": signature,
      "content-type": "application/json",
    },
  };
}

describe("WebhookTransport", () => {
  it("handles callback URL validation (op:13)", async () => {
    const server = new FakeServer();
    const callbacks: EventTransportCallbacks = { onMessage: vi.fn() };

    const transport = new WebhookTransport(
      { appId: TEST_APP_ID, appSecret: TEST_SECRET, server },
      callbacks,
    );

    // Start without abort signal (won't block because FakeServer is sync)
    const startPromise = transport.start();

    const body = JSON.stringify({
      op: 13,
      d: { plain_token: "Arq0D5A61EgUu4OxUvOp", event_ts: "1725442341" },
    });
    const res = await server.invoke({
      body: Buffer.from(body),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.plain_token).toBe("Arq0D5A61EgUu4OxUvOp");
    expect(typeof parsed.signature).toBe("string");
    expect(parsed.signature.length).toBe(128);

    transport.stop();
    await startPromise;
  });

  it("rejects requests without signature headers", async () => {
    const server = new FakeServer();
    const callbacks: EventTransportCallbacks = { onMessage: vi.fn() };
    const transport = new WebhookTransport(
      { appId: TEST_APP_ID, appSecret: TEST_SECRET, server },
      callbacks,
    );

    const startPromise = transport.start();

    const body = JSON.stringify({ op: 0, t: "C2C_MESSAGE_CREATE", d: {} });
    const res = await server.invoke({
      body: Buffer.from(body),
      headers: {},
    });

    expect(res.status).toBe(401);

    transport.stop();
    await startPromise;
  });

  it("rejects invalid signature", async () => {
    const server = new FakeServer();
    const callbacks: EventTransportCallbacks = { onMessage: vi.fn() };
    const transport = new WebhookTransport(
      { appId: TEST_APP_ID, appSecret: TEST_SECRET, server },
      callbacks,
    );

    const startPromise = transport.start();

    const res = await server.invoke({
      body: Buffer.from(JSON.stringify({ op: 0, t: "TEST", d: {} })),
      headers: {
        "x-signature-timestamp": "12345",
        "x-signature-ed25519": "0".repeat(128), // invalid
      },
    });

    expect(res.status).toBe(401);

    transport.stop();
    await startPromise;
  });

  it("dispatches C2C_MESSAGE_CREATE and returns ACK (op:12)", async () => {
    const server = new FakeServer();
    const onMessage = vi.fn();
    const callbacks: EventTransportCallbacks = { onMessage };
    const transport = new WebhookTransport(
      { appId: TEST_APP_ID, appSecret: TEST_SECRET, server },
      callbacks,
    );

    const startPromise = transport.start();

    const eventPayload = {
      op: 0,
      t: "C2C_MESSAGE_CREATE",
      d: {
        id: "msg-1",
        content: "hello",
        timestamp: "2026-01-01T00:00:00+08:00",
        author: { user_openid: "user-1" },
      },
    };

    const req = makeSignedRequest(JSON.stringify(eventPayload), TEST_SECRET);
    const res = await server.invoke(req);

    expect(res.status).toBe(200);
    const ack = JSON.parse(res.body);
    expect(ack.op).toBe(12); // HTTP Callback ACK
    expect(ack.d).toBe(0);

    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage.mock.calls[0][0]).toMatchObject({
      kind: "c2c",
      senderId: "user-1",
      content: "hello",
    });

    transport.stop();
    await startPromise;
  });

  it("dispatches INTERACTION_CREATE", async () => {
    const server = new FakeServer();
    const onInteraction = vi.fn();
    const callbacks: EventTransportCallbacks = { onMessage: vi.fn(), onInteraction };
    const transport = new WebhookTransport(
      { appId: TEST_APP_ID, appSecret: TEST_SECRET, server },
      callbacks,
    );

    const startPromise = transport.start();

    const eventPayload = {
      op: 0,
      t: "INTERACTION_CREATE",
      d: { id: "int-1", type: 11, data: {} },
    };

    const req = makeSignedRequest(JSON.stringify(eventPayload), TEST_SECRET);
    const res = await server.invoke(req);

    expect(res.status).toBe(200);
    expect(onInteraction).toHaveBeenCalledOnce();

    transport.stop();
    await startPromise;
  });
});
