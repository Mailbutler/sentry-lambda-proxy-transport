import { Event, Response, Status } from "@sentry/types";
import { eventToSentryRequest } from "@sentry/core";
import { SentryError, parseRetryAfterHeader, logger } from "@sentry/utils";
import { Transports } from "@sentry/node";
import { LambdaHTTPRequest, LambdaHTTPResponse } from "./types";
import * as urlTools from "url";

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
        const requestConfig = this._getLambdaHTTPRequest(
          sentryReq.url,
          sentryReq.body
        );
        const lambdaParams = this._getLambdaParams(requestConfig);

        this.lambda.invoke(lambdaParams, (error, lambdaResponseData) => {
          if (error) {
            reject(error);
          } else {
            let httpResponse: LambdaHTTPResponse;
            try {
              if (!lambdaResponseData.Payload) {
                throw new SentryError("Lambda response payload is empty!");
              }

              httpResponse = JSON.parse(lambdaResponseData.Payload.toString());
            } catch (error) {
              reject(
                new SentryError(
                  `Failed to parse HTTP response '${lambdaResponseData.Payload}' from Lambda: ${error.message}`
                )
              );
              return;
            }

            const statusCode = httpResponse.status || 500;
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

  protected _getLambdaParams(payload: any) {
    if (!process.env.LAMBDA_FUNCTION_NAME) {
      throw new SentryError(
        "No lambda function specified via environment variable LAMBDA_FUNCTION_NAME"
      );
    }

    return {
      FunctionName: process.env.LAMBDA_FUNCTION_NAME,
      InvocationType: "RequestResponse",
      LogType: process.env.LAMBDA_LOG_TYPE || "Tail",
      Payload: JSON.stringify(payload),
    };
  }
}
