import { lambdaProxyRequest } from "@mailbutler/lambda-http-proxy";
import type { Envelope } from "@sentry/types";
import {
  createAttachmentEnvelopeItem,
  createEnvelope,
  serializeEnvelope,
} from "@sentry/utils";
import { gunzipSync } from "zlib";

import { createLambdaProxyTransport } from "../src";

jest.mock("@mailbutler/lambda-http-proxy", () => ({
  lambdaProxyRequest: jest.fn(),
}));

const mockedRequest = lambdaProxyRequest as jest.MockedFunction<
  typeof lambdaProxyRequest
>;

const url =
  "https://o1.ingest.sentry.io/api/2/envelope/?sentry_key=abc&sentry_version=7";

function eventEnvelope(message: string): Envelope {
  return createEnvelope<Envelope>(
    { event_id: "aa3ff046696b4bc6b609ce6d28fde9e2" },
    [
      [
        { type: "event" },
        { event_id: "aa3ff046696b4bc6b609ce6d28fde9e2", message },
      ],
    ] as any,
  );
}

function transport(options: Record<string, unknown> = {}) {
  return createLambdaProxyTransport({
    url,
    recordDroppedEvent: jest.fn(),
    lambdaFunctionName: "lambda-http-proxy",
    ...options,
  } as any);
}

function sentRequest(): any {
  expect(mockedRequest).toHaveBeenCalledTimes(1);
  return mockedRequest.mock.calls[0][0];
}

beforeEach(() => {
  mockedRequest.mockReset();
  mockedRequest.mockResolvedValue({
    status: 200,
    statusText: "OK",
    data: {},
    headers: {},
    config: {},
  });
});

test("small event: envelope is sent as string, uncompressed", async () => {
  const envelope = eventEnvelope("hello äöü €");

  await transport().send(envelope);

  const request = sentRequest();
  expect(request.data).toBe(serializeEnvelope(envelope));
  expect(request.dataEncoding).toBeUndefined();
  expect(request.headers["content-encoding"]).toBeUndefined();
  expect(request).toMatchObject({
    url,
    method: "POST",
    lambdaFunctionName: "lambda-http-proxy",
  });
});

test("large event (> 32 KB): gzipped bytes survive as base64", async () => {
  const envelope = eventEnvelope("x".repeat(40 * 1024) + " äöü €");

  await transport().send(envelope);

  const request = sentRequest();
  expect(request.headers["content-encoding"]).toBe("gzip");
  expect(request.dataEncoding).toBe("base64");
  expect(typeof request.data).toBe("string");
  const body = gunzipSync(Buffer.from(request.data, "base64")).toString("utf8");
  expect(body).toBe(serializeEnvelope(envelope));
});

test("binary envelope (attachment): bytes survive as base64", async () => {
  const attachment = new Uint8Array([0, 255, 128, 10, 0xc3, 0x28]);
  const envelope = createEnvelope<Envelope>({ event_id: "abc" }, [
    createAttachmentEnvelopeItem({ data: attachment, filename: "a.bin" }),
  ]);
  const serialized = serializeEnvelope(envelope) as Uint8Array;
  expect(serialized).toBeInstanceOf(Uint8Array);

  await transport().send(envelope);

  const request = sentRequest();
  expect(request.dataEncoding).toBe("base64");
  expect(request.headers["content-encoding"]).toBeUndefined();
  expect(
    Buffer.from(request.data, "base64").equals(Buffer.from(serialized)),
  ).toBe(true);
});

test("custom headers and timeout are forwarded, SDK options are not", async () => {
  await transport({
    headers: { a: "b" },
    timeout: 1234,
    proxy: "http://localhost:3128",
    caCerts: "cert",
  }).send(eventEnvelope("hello"));

  const request = sentRequest();
  expect(request.headers).toEqual(expect.objectContaining({ a: "b" }));
  expect(request.timeout).toBe(1234);
  expect(request).not.toHaveProperty("proxy");
  expect(request).not.toHaveProperty("caCerts");
  expect(request).not.toHaveProperty("recordDroppedEvent");
});

test("passes status and rate limit headers back to the SDK", async () => {
  mockedRequest.mockResolvedValue({
    status: 429,
    statusText: "Too Many Requests",
    data: {},
    headers: { "retry-after": "60", "x-sentry-rate-limits": "60:error:key" },
    config: {},
  });
  const t = transport();

  const response = await t.send(eventEnvelope("first"));
  await t.send(eventEnvelope("second"));

  expect(response).toEqual({
    statusCode: 429,
    headers: { "retry-after": "60", "x-sentry-rate-limits": "60:error:key" },
  });
  // second event is dropped by the SDK's rate limiting
  expect(mockedRequest).toHaveBeenCalledTimes(1);
});
