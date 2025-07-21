import type { ActorIdentifier } from "@atcute/lexicons";
import { Container } from "@mantine/core";
import { useEffect } from "react";
import UserDetails from "~/components/UserDetails";
import { useProfile } from "~/hooks";
import type { Route } from "./+types/users.$actor";

export default function Index({ params: { actor } }: Route.ComponentProps) {
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
