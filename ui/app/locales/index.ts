export default {
  // @ts-ignore
  "en-US": () => import("./en/messages.po"),

  // @ts-ignore
  "en-GB": () => import("./en/messages.po"),

  // @ts-ignore
  ja: () => import("./ja/messages.po"),
} as Record<string, () => Promise<{ messages: any }>>;
