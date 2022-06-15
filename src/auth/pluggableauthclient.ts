// Copyright 2022 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {
  BaseExternalAccountClient,
  BaseExternalAccountClientOptions,
} from './baseexternalclient';
import {RefreshOptions} from './oauth2client';
import {ExecutableResponse} from './executableresponse';

/**
 * Defines the credential source portion of the configuration for PluggableAuthClient.
 *
 * <p>Command is the only required field. If timeout_millis is not specified, the library will
 * default to a 30-second timeout.
 *
 * <pre>
 * Sample credential source for Pluggable Auth Client:
 * {
 *   ...
 *   "credential_source": {
 *     "executable": {
 *       "command": "/path/to/get/credentials.sh --arg1=value1 --arg2=value2",
 *       "timeout_millis": 5000,
 *       "output_file": "/path/to/generated/cached/credentials"
 *     }
 *   }
 * }
 * </pre>
 */
export interface PluggableAuthClientOptions
  extends BaseExternalAccountClientOptions {
  credential_source: {
    /**
     * The command used to retrieve the 3rd party token.
     */
    command: string;
    /**
     * The timeout for executable to run in milliseconds. If none is provided it
     * will be set to the default timeout of 30 seconds.
     */
    timeout_millis?: number;
    /**
     * An optional output file location that will be checked for a cached response
     * from a previous run of the executable.
     */
    output_file?: string;
  };
}

/**
 * Error thrown from the executable run by PluggableAuthClient.
 */
export class ExecutableError extends Error {
  /**
   * The exit code returned by the executable.
   */
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'ExecutableError';
    this.code = code;
    Object.setPrototypeOf(this, ExecutableError.prototype);
  }
}

/**
 * The default executable timeout when none is provided, in milliseconds.
 */
const DEFAULT_EXECUTABLE_TIMEOUT_MILLIS = 30 * 1000;
/**
 * The minimum allowed executable timeout in milliseconds.
 */
const MINIMUM_EXECUTABLE_TIMEOUT_MILLIS = 5 * 1000;
/**
 * The maximum allowed executable timeout in milliseconds.
 */
const MAXIMUM_EXECUTABLE_TIMEOUT_MILLIS = 120 * 1000;

/**
 * The environment variable to check to see if executable can be run.
 * Value must be set to '1' for the executable to run.
 */
const GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES =
  'GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES';

/**
 * The maximum currently supported executable version.
 */
const MAXIMUM_EXECUTABLE_VERSION = 1;

/**
 * PluggableAuthClient enables the exchange of workload identity pool external credentials for
 * Google access tokens by retrieving 3rd party tokens through a user supplied executable. These
 * scripts/executables are completely independent of the Google Cloud Auth libraries. These
 * credentials plug into ADC and will call the specified executable to retrieve the 3rd party token
 * to be exchanged for a Google access token.
 *
 * <p>To use these credentials, the GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES environment variable
 * must be set to '1'. This is for security reasons.
 *
 * <p>Both OIDC and SAML are supported. The executable must adhere to a specific response format
 * defined below.
 *
 * <p>The executable should print out the 3rd party token to STDOUT in JSON format. This is not
 * required when an output_file is specified in the credential source, with the expectation being
 * that the output file will contain the JSON response instead.
 *
 * <pre>
 * OIDC response sample:
 * {
 *   "version": 1,
 *   "success": true,
 *   "token_type": "urn:ietf:params:oauth:token-type:id_token",
 *   "id_token": "HEADER.PAYLOAD.SIGNATURE",
 *   "expiration_time": 1620433341
 * }
 *
 * SAML2 response sample:
 * {
 *   "version": 1,
 *   "success": true,
 *   "token_type": "urn:ietf:params:oauth:token-type:saml2",
 *   "saml_response": "...",
 *   "expiration_time": 1620433341
 * }
 *
 * Error response sample:
 * {
 *   "version": 1,
 *   "success": false,
 *   "code": "401",
 *   "message": "Error message."
 * }
 *
 * The auth libraries will populate certain environment variables that will be accessible by the
 * executable, such as: GOOGLE_EXTERNAL_ACCOUNT_AUDIENCE, GOOGLE_EXTERNAL_ACCOUNT_TOKEN_TYPE,
 * GOOGLE_EXTERNAL_ACCOUNT_INTERACTIVE, GOOGLE_EXTERNAL_ACCOUNT_IMPERSONATED_EMAIL, and
 * GOOGLE_EXTERNAL_ACCOUNT_OUTPUT_FILE.
 *
 * <p>Please see this repositories README for a complete executable request/response specification.
 * </pre>
 */
export class PluggableAuthClient extends BaseExternalAccountClient {
  /**
   * The command used to retrieve the third party token.
   */
  private readonly command: string;
  /**
   * The timeout in milliseconds for running executable,
   * set to default if none provided.
   */
  private readonly timeoutMillis: number;
  /**
   * The path to file to check for cached executable response.
   */
  private readonly outputFile?: string;

  /**
   * Instantiates a PluggableAuthClient instance using the provided JSON
   * object loaded from an external account credentials file.
   * An error is thrown if the credential is not a valid pluggable auth credential.
   * @param options The external account options object typically loaded from
   *   the external account JSON credential file.
   * @param additionalOptions Optional additional behavior customization
   *   options. These currently customize expiration threshold time and
   *   whether to retry on 401/403 API request errors.
   */
  constructor(
    options: PluggableAuthClientOptions,
    additionalOptions?: RefreshOptions
  ) {
    super(options, additionalOptions);
    this.command = options.credential_source.command;
    if (!this.command) {
      throw new Error('No valid Pluggable Auth "credential_source" provided.');
    }
    // Check if the provided timeout exists and if it is valid.
    if (options.credential_source.timeout_millis === undefined) {
      this.timeoutMillis = DEFAULT_EXECUTABLE_TIMEOUT_MILLIS;
    } else {
      this.timeoutMillis = options.credential_source.timeout_millis;
      if (
        this.timeoutMillis < MINIMUM_EXECUTABLE_TIMEOUT_MILLIS ||
        this.timeoutMillis > MAXIMUM_EXECUTABLE_TIMEOUT_MILLIS
      ) {
        throw new Error(
          `Timeout must be between ${MINIMUM_EXECUTABLE_TIMEOUT_MILLIS} and ` +
            `${MAXIMUM_EXECUTABLE_TIMEOUT_MILLIS} milliseconds.`
        );
      }
    }

    this.outputFile = options.credential_source.output_file;
  }

  /**
   * Triggered when an external subject token is needed to be exchanged for a
   * GCP access token via GCP STS endpoint.
   * This uses the `options.credential_source` object to figure out how
   * to retrieve the token using the current environment. In this case,
   * this calls a user provided executable which returns the subject token.
   * The logic is summarized as:
   * 1. Validated that the executable is allowed to run. The
   *    GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES environment must be set to
   *    1 for security reasons.
   * 2. If an output file is specified by the user, check the file location
   *    for a response. If the file exists and contains a valid response,
   *    return the subject token from the file.
   * 3. Call the provided executable and return response.
   * @return A promise that resolves with the external subject token.
   */
  async retrieveSubjectToken(): Promise<string> {
    // Check if the executable is allowed to run.
    if (process.env[GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES] !== '1') {
      throw new Error(
        'Pluggable Auth executables need to be explicitly allowed to run by ' +
          'setting the GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES environment ' +
          'Variable to 1.'
      );
    }

    let executableResponse: ExecutableResponse | undefined;
    // Try to get cached executable response from output file.
    if (this.outputFile) {
      executableResponse = await this.retrieveCachedResponse();
    }

    // If no response from output file, call the executable.
    if (!executableResponse) {
      // Set up environment map with required values for the executable.
      const envMap = new Map();
      envMap.set('GOOGLE_EXTERNAL_ACCOUNT_AUDIENCE', this.audience);
      envMap.set('GOOGLE_EXTERNAL_ACCOUNT_TOKEN_TYPE', this.subjectTokenType);
      // Always set to 0 because interactive mode is not supported.
      envMap.set('GOOGLE_EXTERNAL_ACCOUNT_INTERACTIVE', '0');
      const serviceAccountEmail = this.getServiceAccountEmail();
      if (serviceAccountEmail) {
        envMap.set(
          'GOOGLE_EXTERNAL_ACCOUNT_IMPERSONATED_EMAIL',
          serviceAccountEmail
        );
      }
      executableResponse = await this.retrieveResponseFromExecutable(envMap);
    }

    if (executableResponse) {
      // Check that version of response is valid.
      if (executableResponse.version > MAXIMUM_EXECUTABLE_VERSION) {
        throw new Error(
          `Version of executable is not currently supported, maximum supported version is ${MAXIMUM_EXECUTABLE_VERSION}.`
        );
      }
      // Check that response was successful.
      if (!executableResponse.success) {
        throw new ExecutableError(
          executableResponse.errorMessage as string,
          executableResponse.errorCode as string
        );
      }
      // Check that response is not expired.
      if (executableResponse.isExpired()) {
        throw new Error('Executable response is expired.');
      }
      // Return subject token from response.
      return executableResponse.subjectToken as string;
    } else {
      throw new Error('No valid response returned from executable.');
    }
  }

  /**
   * Calls user provided executable to get a 3rd party subject token and
   * returns the response.
   * @param envMap a Map of additional Environment Variables required for
   *   the executable.
   * @return A promise that resolves with the executable response.
   */
  private retrieveResponseFromExecutable(
    envMap: Map<string, string>
  ): Promise<ExecutableResponse> {
    // TODO: Implement running executable and retrieving response.
    return new Promise(resolve => {
      const responseJson = {
        success: false,
        version: 1,
        code: '',
        message: '',
      };
      const response = new ExecutableResponse(responseJson);
      resolve(response);
    });
  }

  /**
   * Checks user provided output file for response from previous run of
   * executable and return the response if it exists and is valid.
   */
  private retrieveCachedResponse(): Promise<ExecutableResponse | undefined> {
    // TODO: Implement output file reading.
    return new Promise(resolve => {
      resolve(undefined);
    });
  }
}
