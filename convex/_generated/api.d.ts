/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as config from "../config.js";
import type * as crons from "../crons.js";
import type * as execution_auth from "../execution/auth.js";
import type * as execution_egress from "../execution/egress.js";
import type * as execution_inbox from "../execution/inbox.js";
import type * as execution_ingest from "../execution/ingest.js";
import type * as lib_log from "../lib/log.js";
import type * as lifecycle_daytona from "../lifecycle/daytona.js";
import type * as lifecycle_pool from "../lifecycle/pool.js";
import type * as lifecycle_reconciler from "../lifecycle/reconciler.js";
import type * as lifecycle_stateMachine from "../lifecycle/stateMachine.js";
import type * as messages from "../messages.js";
import type * as observability from "../observability.js";
import type * as runs from "../runs.js";
import type * as threads from "../threads.js";
import type * as validators from "../validators.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  config: typeof config;
  crons: typeof crons;
  "execution/auth": typeof execution_auth;
  "execution/egress": typeof execution_egress;
  "execution/inbox": typeof execution_inbox;
  "execution/ingest": typeof execution_ingest;
  "lib/log": typeof lib_log;
  "lifecycle/daytona": typeof lifecycle_daytona;
  "lifecycle/pool": typeof lifecycle_pool;
  "lifecycle/reconciler": typeof lifecycle_reconciler;
  "lifecycle/stateMachine": typeof lifecycle_stateMachine;
  messages: typeof messages;
  observability: typeof observability;
  runs: typeof runs;
  threads: typeof threads;
  validators: typeof validators;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
