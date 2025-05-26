import { defineConfig } from "@lingui/cli";

export default defineConfig({
  locales: ["en"],
  sourceLocale: "en",
  orderBy: "origin",
  catalogs: [
    {
      path: "<rootDir>/app/locales/{locale}/messages",
      include: ["app"],
    },
  ],
});
