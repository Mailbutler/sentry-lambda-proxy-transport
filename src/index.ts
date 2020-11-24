import { Event, Response, Status } from "@sentry/types";
import { eventToSentryRequest } from "@sentry/core";
import { SentryError, parseRetryAfterHeader, logger } from "@sentry/utils";
import { Transports } from "@sentry/node";
import * as url from "url";

import * as AWS from "aws-sdk";

// load AWS parameters
AWS.config.region = process.env.AWS_REGION || "eu-central-1";

/** AWS Lambda module transport */
export class LambdaProxyTransport extends Transports.BaseTransport {
  lambda = new AWS.Lambda();

  /** Locks transport after receiving 429 response */
  private _disabledUntilLambda: Date = new Date(Date.now());

  /**
   * @inheritDoc
   */
  public sendEvent(event: Event): PromiseLike<Response> {
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
    return this._buffer.add(
      new Promise<Response>((resolve, reject) => {
        const sentryReq = eventToSentryRequest(event, this._api);
        const options = this._getRequestOptions(new url.URL(sentryReq.url));

        var params = {
          FunctionName: "Lambda_B", // the lambda function we are going to invoke
          InvocationType: "RequestResponse",
          LogType: "Tail",
          Payload: '{ "name" : "Alex" }',
        };

        this.lambda.invoke(params, (error, lambdaResponseData) => {
          if (error) {
            reject(error);
          } else {
            const httpResponse = JSON.parse(
              lambdaResponseData.Payload.toString() || "{}"
            ); // TODO: add type (Axios response)

            const statusCode = httpResponse.statusCode || 500;
            const status = Status.fromHttpCode(statusCode);

            if (status === Status.Success) {
              resolve({ status });
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
              if (
                httpResponse.headers &&
                httpResponse.headers["x-sentry-error"]
              ) {
                rejectionMessage += `: ${httpResponse.headers["x-sentry-error"]}`;
              }

              reject(new SentryError(rejectionMessage));
            }
          }
        });
      })
    );
  }
}
