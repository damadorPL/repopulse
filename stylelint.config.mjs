import tailwindConfig from "@dreamsicle.io/stylelint-config-tailwindcss";

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} config
 * @returns {NonNullable<NonNullable<import('stylelint').Config['languageOptions']>['syntax']>}
 */
function readTailwindSyntax(config) {
  if (!isRecord(config) || !isRecord(config.languageOptions) || !isRecord(config.languageOptions.syntax)) {
    return {};
  }
  const { syntax } = config.languageOptions;
  /** @type {NonNullable<NonNullable<import('stylelint').Config['languageOptions']>['syntax']>} */
  const out = {};
  if (isRecord(syntax.types)) {
    out.types = Object.fromEntries(Object.entries(syntax.types).filter((entry) => typeof entry[1] === "string"));
  }
  if (isRecord(syntax.properties)) {
    out.properties = Object.fromEntries(
      Object.entries(syntax.properties).filter((entry) => typeof entry[1] === "string"),
    );
  }
  if (isRecord(syntax.atRules)) {
    out.atRules = syntax.atRules;
  }
  return out;
}

const tailwindSyntax = readTailwindSyntax(tailwindConfig);

/** @type {import('stylelint').Config} */
export default {
  extends: ["stylelint-config-standard", "@dreamsicle.io/stylelint-config-tailwindcss"],
  ignoreFiles: ["**/node_modules/**", "**/dist/**", "**/.next/**", "**/.turbo/**", "**/coverage/**"],
  languageOptions: {
    syntax: {
      ...tailwindSyntax,
      atRules: {
        ...tailwindSyntax.atRules,
        plugin: {
          prelude: "<string>",
        },
        slot: {},
      },
    },
  },
  rules: {
    "custom-property-pattern": [
      "^_?[a-z][a-z0-9-]*$",
      { message: "Expected custom property name to be kebab-case (optional leading underscore)" },
    ],
    // Highlight.js emits `.hljs-built_in` and `.hljs-title.function_`.
    "selector-class-pattern": [
      "^([a-z][a-z0-9-]*|hljs-built_in|function_)$",
      { message: "Expected class selector to be kebab-case" },
    ],
    "no-descending-specificity": null,
    "custom-property-empty-line-before": null,
    // Preserve shadcn/ui canonical oklch() notation (e.g. `oklch(0.141 0.005 285.823)`).
    "lightness-notation": null,
    "hue-degree-notation": null,
  },
};
