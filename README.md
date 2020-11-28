# Sentry Lamda HTTP Proxy Transport

> Drop-in replacement transport for Sentry to transmit events via [Lambda HTTP proxy](https://github.com/mailbutler/lambda-http-proxy)

[![NPM Version][npm-image]][npm-url]
[![Downloads Stats][npm-downloads]][npm-url]

If you run into the problem of not being able to perform HTTP requests to external resources from a resource **within a VPC**, e.g. a Lambda function, then performing the HTTP request through a simple Lambda HTTP proxy function could be a solution.

This module builds on top of [lambda-http-proxy](https://github.com/mailbutler/lambda-http-proxy) and allows to use Sentry error logging from inside a AWS VPC without requiring complex networking setup.

## Installation

```sh
npm install sentry-lambda-proxy-transport --save
```

## AWS Requirements

Please follow the instructions for [lambda-http-proxy](https://github.com/mailbutler/lambda-http-proxy) to configure your AWS environment correctly.

## Usage example

After having prepared your AWS environment, you can now import the module into your project, e.g. a Lambda function and initialize your Sentry instance to send events via the Lambda proxy function:

```js
import { LambdaProxyTransport } from "@mailbutler/sentry-lambda-proxy-transport";

Sentry.init({
  // regular configuration of your Sentry instance, including 'dsn'

  // use Lambda proxy transport instead of default HTTP transport
  transport: LambdaProxyTransport,
});
```

## Release History

- 1.0
  - Initial version

## Contributing

1. Fork it (<https://github.com/mailbutler/sentry-lambda-proxy-transport/fork>)
2. Create your feature branch (`git checkout -b feature/fooBar`)
3. Commit your changes (`git commit -am 'Add some fooBar'`)
4. Push to the branch (`git push origin feature/fooBar`)
5. Create a new Pull Request

<!-- Markdown link & img dfn's -->

[npm-image]: https://img.shields.io/npm/v/@mailbutler/sentry-lambda-proxy-transport.svg?style=flat-square
[npm-url]: https://npmjs.org/package/@mailbutler/sentry-lambda-proxy-transport
[npm-downloads]: https://img.shields.io/npm/dm/@mailbutler/sentry-lambda-proxy-transport.svg?style=flat-square
