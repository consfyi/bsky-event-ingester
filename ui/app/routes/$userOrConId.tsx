import type { ActorIdentifier } from "@atcute/lexicons";
import { Container } from "@mantine/core";
import { useEffect } from "react";
import ConDetails from "~/components/ConDetails";
import UserDetails from "~/components/UserDetails";
import { useConsWithPosts, useProfile } from "~/hooks";
import type { Route } from "./+types/$userOrConId";

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

function ConPage({ id }: { id: string }) {
  const cons = useConsWithPosts();

  const con = cons != null ? cons.find((con) => con.id == id) : null;

  useEffect(() => {
    if (con == null) {
      return;
    }
    document.title = con != null ? con.name : "";
    if (id != con.id) {
      window.history.replaceState(null, "", `/${con.id}`);
    }
  }, [con, id]);

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

export default function Index({
  params: { userOrConId },
}: Route.ComponentProps) {
  return userOrConId[0] == "@" ? (
    <UserPage actor={userOrConId.substring(1)} />
  ) : (
    <ConPage id={userOrConId} />
  );
}
