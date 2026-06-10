import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // v0.13.1: 项目大量使用动态 JSON 数据，明确允许 any 类型
  { rules: { "@typescript-eslint/no-explicit-any": "off" } },
  // 允许在 effect 中同步 setState（如清空 sessions 状态）
  { rules: {
    "react-hooks/set-state-in-effect": "off",
    "react-hooks/purity": "off",
  } },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated files:
    "src/generated/**",
    // Scripts (use CommonJS/require):
    "scripts/**",
  ]),
]);

export default eslintConfig;
