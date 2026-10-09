import {
  lambdaProxyRequest,
  LambdaHTTPRequest,
} from "@mailbutler/lambda-http-proxy";
import type {
  BaseTransportOptions,
  Transport,
  TransportMakeRequestResponse,
  TransportRequest,
  TransportRequestExecutor,
} from "@sentry/types";
import { createTransport } from "@sentry/core";
import { promisify } from "util";
import { gzip } from "zlib";

export interface LambdaProxyTransportOptions extends BaseTransportOptions {
  /** Define AWS Lambda proxy function name. Can also be defined via environment variable `LAMBDA_FUNCTION_NAME` */
  lambdaFunctionName?: string;
  /** Define custom headers */
  headers?: Record<string, string>;
  /** Define request timeout */
  timeout?: number;
}

/**
 * `dataEncoding` is declared here as well, so this package also compiles against
 * @mailbutler/lambda-http-proxy < 1.2 (which passes it through unchanged).
 */
type LambdaProxyRequestConfig = LambdaHTTPRequest & { dataEncoding?: "base64" };

export function createLambdaProxyTransport(
  options: LambdaProxyTransportOptions,
): Transport {
  return createTransport(options, createLambdaProxyRequestExecutor(options));
}

// Estimated maximum size for reasonable standalone event (same as @sentry/node)
const GZIP_THRESHOLD = 1024 * 32;

const gzipAsync = promisify(gzip);

function createLambdaProxyRequestExecutor(
  options: LambdaProxyTransportOptions,
): TransportRequestExecutor {
  return async function makeRequest(
    request: TransportRequest,
  ): Promise<TransportMakeRequestResponse> {
    const headers: Record<string, string> = { ...options.headers };

    // Envelopes are strings, or Uint8Array when they contain binary items (attachments).
    let body: string | Buffer =
      typeof request.body === "string"
        ? request.body
        : Buffer.from(
            request.body.buffer,
            request.body.byteOffset,
            request.body.byteLength,
          );
    if (request.body.length > GZIP_THRESHOLD) {
      headers["content-encoding"] = "gzip";
      body = await gzipAsync(body);
    }

    // The Lambda invocation payload is JSON: binary bodies (gzip, attachments) are
    // sent base64 encoded and decoded to bytes by lambda-http-proxy-function (SEC-223).
    const requestConfig: LambdaProxyRequestConfig = {
      lambdaFunctionName: options.lambdaFunctionName,
      url: options.url,
      timeout: options.timeout,
      headers,
      method: "POST",
      responseType: "json",
      ...(typeof body === "string"
        ? { data: body }
        : { data: body.toString("base64"), dataEncoding: "base64" }),
    };

    const httpResponse = await lambdaProxyRequest(requestConfig);

    // "Key-value pairs of header names and values. Header names are lower-cased."
    // https://nodejs.org/api/http.html#http_message_headers
    const retryAfterHeader = httpResponse.headers["retry-after"] ?? null;
    const rateLimitsHeader =
      httpResponse.headers["x-sentry-rate-limits"] ?? null;

    return {
      statusCode: httpResponse.status,
      headers: {
        "retry-after": retryAfterHeader,
        "x-sentry-rate-limits": Array.isArray(rateLimitsHeader)
          ? rateLimitsHeader[0]
          : rateLimitsHeader,
      },
    };
  };
}
