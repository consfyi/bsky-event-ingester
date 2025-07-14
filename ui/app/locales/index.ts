export default {
  "en-US": () => import("./en/messages.po"),
  "en-GB": () => import("./en/messages.po"),
  ja: () => import("./ja/messages.po"),
} as Record<string, () => Promise<{ messages: { [key: string]: string } }>>;
