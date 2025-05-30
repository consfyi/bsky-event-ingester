import { lingui } from "@lingui/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import babel from "vite-plugin-babel";
import macrosPlugin from "vite-plugin-babel-macros";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    reactRouter(),
    macrosPlugin(),
    lingui(),
    tsconfigPaths(),
    babel({
      filter: /\.[jt]sx?$/,
      babelConfig: {
        presets: ["@babel/preset-typescript"],
        plugins: [["babel-plugin-react-compiler", { target: "18" }]],
      },
    }),
  ],
  resolve: {
    alias: {
      "@tabler/icons-react": "@tabler/icons-react/dist/esm/icons/index.mjs",
    },
  },
  server: { allowedHosts: true },
});
