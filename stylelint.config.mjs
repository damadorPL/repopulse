/** @type {import('stylelint').Config} */
export default {
  extends: ["stylelint-config-standard", "@dreamsicle.io/stylelint-config-tailwindcss"],
  ignoreFiles: ["**/node_modules/**", "**/dist/**", "**/.next/**", "**/.turbo/**", "**/coverage/**"],
  rules: {
    "custom-property-pattern": [
      "^_?[a-z][a-z0-9-]*$",
      { message: "Expected custom property name to be kebab-case (optional leading underscore)" },
    ],
    // Tailwind v4 `@plugin` is not yet in @dreamsicle.io/stylelint-config-tailwindcss ignoreAtRules.
    "at-rule-no-unknown": [
      true,
      {
        ignoreAtRules: [
          "tailwind",
          "apply",
          "layer",
          "config",
          "theme",
          "source",
          "utility",
          "variant",
          "custom-variant",
          "plugin",
          "reference",
        ],
      },
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
