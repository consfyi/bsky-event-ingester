import { defineConfig } from "@lingui/cli";

export default defineConfig({
  locales: ["en", "ja"],
  sourceLocale: "en",
  orderBy: "origin",
  catalogs: [
    {
      path: "<rootDir>/app/locales/{locale}/messages",
      include: ["app"],
    },
  ],
});
