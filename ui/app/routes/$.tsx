export default function Splat() {
  throw new Response(null, {
    status: 404,
  });
}
