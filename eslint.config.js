// Lint = typescript-eslint recommended + the architecture's plane boundaries.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const restrict = (patterns) => ["error", { patterns }];

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "convex/_generated/**", ".convex/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },

  // --- Control plane -------------------------------------------------------
  {
    files: ["convex/**/*.ts"],
    rules: {
      "no-restricted-imports": restrict([
        { group: ["@daytona/sdk"], message: "Only convex/lifecycle/daytona.ts may talk to Daytona." },
        { group: ["**/runner/**", "@earendil-works/*"], message: "The control plane must not import the execution plane." },
      ]),
    },
  },
  { files: ["convex/lifecycle/daytona.ts"], rules: { "no-restricted-imports": "off" } },

  // --- Execution plane -----------------------------------------------------
  {
    files: ["runner/src/**/*.ts"],
    rules: {
      "no-restricted-imports": restrict([
        { group: ["convex", "convex/*"], message: "Only runner/src/controlPlane.ts may talk to Convex (use shared/protocol.ts)." },
        { group: ["../**/convex/**", "@daytona/sdk"], message: "The VM only knows shared/protocol.ts, not control-plane internals." },
      ]),
    },
  },
  { files: ["runner/src/controlPlane.ts", "runner/src/spikeConvex.ts"], rules: { "no-restricted-imports": "off" } },

  // --- UI ------------------------------------------------------------------
  {
    files: ["web/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": restrict([
        { group: ["**/runner/**", "@earendil-works/*", "@daytona/sdk"], message: "The UI talks to Convex only." },
        { group: ["**/convex/lifecycle/**", "**/convex/execution/**"], message: "Use the generated api, not server modules." },
      ]),
    },
  },
);
