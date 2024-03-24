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
import { createTransport, addBreadcrumb } from "@sentry/core";
import { Readable } from "stream";
import { createGzip } from "zlib";

export interface LambdaProxyTransportOptions extends BaseTransportOptions {
  /** Define AWS Lambda proxy function name. Can also be defined via environment variable `LAMBDA_FUNCTION_NAME` */
  lambdaFunctionName?: string;
  /** Define custom headers */
  headers?: Record<string, string>;
  /** Define request timeout */
  timeout?: number;
}

export function createLambdaProxyTransport(
  options: LambdaProxyTransportOptions
): Transport {
  return createTransport(options, createLambdaProxyRequestExecutor(options));
}

// Estimated maximum size for reasonable standalone event
const GZIP_THRESHOLD = 1024 * 32;

function createLambdaProxyRequestExecutor(
  options: LambdaProxyTransportOptions
): TransportRequestExecutor {
  return async function makeRequest(
    request: TransportRequest
  ): Promise<TransportMakeRequestResponse> {
    try {
      const headers: Record<string, string> = { ...options.headers };

      let body = Readable.from(request.body);
      if (request.body.length > GZIP_THRESHOLD) {
        headers["content-encoding"] = "gzip";
        body = body.pipe(createGzip());
      }
      const data = await _streamToString(body);

      const requestConfig: LambdaHTTPRequest = {
        ...options,
        headers,
        data,
        method: "POST",
        responseType: "json",
      };

      const httpResponse = await lambdaProxyRequest(requestConfig);
      addBreadcrumb({
        type: "http",
        category: "http",
        data: { request: requestConfig, response: httpResponse },
      });

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
    } catch (error) {
      throw error;
    }
  };
}

function _streamToString(stream: Readable): Promise<string> {
  const chunks: Uint8Array[] = [];
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("error", (err) => reject(err));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}
