import type { ActorIdentifier } from "@atcute/lexicons";
import { Container } from "@mantine/core";
import { useEffect } from "react";
import ConDetails from "~/components/ConDetails";
import UserDetails from "~/components/UserDetails";
import { useConsWithPosts, useProfile } from "~/hooks";
import type { Route } from "./+types/$slug";

function UserPage({ actor }: { actor: string }) {
  const profile = useProfile(actor as ActorIdentifier);

  useEffect(() => {
    document.title =
      profile != null
        ? profile.displayName != null
          ? `${profile.displayName} (@${profile.handle})`
          : `@${profile.handle}`
        : "";
  }, [profile]);

  if (profile == null) {
    throw new Response(null, {
      status: 404,
    });
  }

  return (
    <Container size="lg" p="sm">
      <UserDetails profile={profile} />
    </Container>
  );
}

function ConPage({ slug }: { slug: string }) {
  const cons = useConsWithPosts();

  const con = cons != null ? cons.find((con) => con.slug == slug) : null;

  useEffect(() => {
    if (con == null) {
      return;
    }
    document.title = con != null ? con.name : "";
    if (slug != con.slug) {
      window.history.replaceState(null, "", `/${con.slug}`);
    }
  }, [con, slug]);

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

export default function Index({ params: { slug } }: Route.ComponentProps) {
  return slug[0] == "@" ? (
    <UserPage actor={slug.substring(1)} />
  ) : (
    <ConPage slug={slug} />
  );
}
