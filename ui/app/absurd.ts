// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default function absurd<T>(x: never): T {
  throw new Error("absurd");
}
