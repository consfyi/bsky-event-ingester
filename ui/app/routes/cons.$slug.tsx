import { Box } from "@mantine/core";
import { useEffect } from "react";
import { useParams } from "react-router";
import ConDetails from "~/components/ConDetails";
import { useConsWithPosts, useFollowedConAttendeesDLE } from "~/hooks";
import { Route } from "./+types/cons.$slug";

export default function Index() {
  const cons = useConsWithPosts();

  const { slug } = useParams<Route.LoaderArgs["params"]>();

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
    <Box p="sm">
      <ConDetails con={con} />
    </Box>
  );
}
