/// <reference types="vite/client" />

declare module "*.po" {
  export const messages: { [key: string]: string };
}
