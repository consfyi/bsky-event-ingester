/// <reference types="vite/client" />

declare module "*.po" {
  const messages: { [key: string]: string };
  export { messages };
}
