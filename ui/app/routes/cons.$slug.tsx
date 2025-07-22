import { Navigate } from "react-router";
import { useConsWithPosts } from "~/hooks";
import type { Route } from "./+types/cons.$slug";

export default function Index({ params: { slug } }: Route.ComponentProps) {
  const cons = useConsWithPosts();
  const con =
    cons != null
      ? cons.find((con) => con.slug == slug || con.identifier == slug)
      : null;
  if (con == null) {
    throw new Response(null, {
      status: 404,
    });
  }

  return <Navigate replace to={`/${con.slug}`} />;
}
