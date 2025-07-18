import { Container } from "@mantine/core";
import { useEffect } from "react";
import ConDetails from "~/components/ConDetails";
import { useConsWithPosts } from "~/hooks";
import { Route } from "./+types/cons.$slug";

export default function Index({ params: { slug } }: Route.ComponentProps) {
  const cons = useConsWithPosts();

  const con =
    cons != null
      ? cons.find((con) => con.slug == slug || con.identifier == slug)
      : null;

  useEffect(() => {
    if (con == null) {
      return;
    }
    document.title = con != null ? con.name : "";
    if (slug != con.slug) {
      window.history.replaceState(null, "", `/cons/${con.slug}`);
    }
  }, [con]);

  if (con == null) {
    throw new Response(null, {
      status: 404,
    });
  }

  return (
    <Container size="lg" p="sm">
      <ConDetails con={con} />
    </Container>
  );
}
