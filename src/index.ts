import { Event, Response, Status } from "@sentry/types";
import { eventToSentryRequest } from "@sentry/core";
import { SentryError, parseRetryAfterHeader, logger } from "@sentry/utils";
import { Transports } from "@sentry/node";
import {
  lambdaProxyRequest,
  LambdaHTTPRequest,
} from "@mailbutler/lambda-http-proxy";
import * as urlTools from "url";

/** AWS Lambda module transport */
export class LambdaProxyTransport extends Transports.BaseTransport {
  /** Locks transport after receiving 429 response */
  private _disabledUntilLambda: Date = new Date(Date.now());

  /**
   * @inheritDoc
   */
  public sendEvent(event: Event): PromiseLike<Response> {
    logger.log("sending event ...");

    if (new Date(Date.now()) < this._disabledUntilLambda) {
      return Promise.reject(
        new SentryError(
          `Transport locked till ${this._disabledUntilLambda} due to too many requests.`
        )
      );
    }

    if (!this._buffer.isReady()) {
      return Promise.reject(
        new SentryError("Not adding Promise due to buffer limit reached.")
      );
    }

    const requestProcessor = async (): Promise<Response> => {
      logger.log("processing event ...");

      const sentryReq = eventToSentryRequest(event, this._api);
      const requestConfig = this._getLambdaHTTPRequest(
        sentryReq.url,
        sentryReq.body
      );

      logger.log("sending request via Lambda ...");
      const httpResponse = await lambdaProxyRequest(requestConfig);

      const statusCode = httpResponse.status || 500;
      const status = Status.fromHttpCode(statusCode);

      logger.log("processing response ...");

      if (status === Status.Success) {
        return { status };
      } else {
        if (status === Status.RateLimit) {
          const now = Date.now();
          let header = httpResponse.headers
            ? httpResponse.headers["Retry-After"]
            : "";
          header = Array.isArray(header) ? header[0] : header;
          this._disabledUntilLambda = new Date(
            now + parseRetryAfterHeader(now, header)
          );
          logger.warn(
            `Too many requests, backing off till: ${this._disabledUntilLambda}`
          );
        }

        let rejectionMessage = `HTTP Error (${statusCode})`;
        if (httpResponse.headers && httpResponse.headers["x-sentry-error"]) {
          rejectionMessage += `: ${httpResponse.headers["x-sentry-error"]}`;
        }

        throw new SentryError(rejectionMessage);
      }
    };

    return this._buffer.add(requestProcessor());
  }

  protected _getLambdaHTTPRequest(
    url: string,
    jsonBody: string
  ): LambdaHTTPRequest {
    const { headers } = super._getRequestOptions(new urlTools.URL(url));

    return {
      url,
      method: "POST",
      headers,
      data: JSON.parse(jsonBody),
      timeout: 2000,
      responseType: "json",
    };
  }
}
