import type { ActorIdentifier } from "@atcute/lexicons";
import { Plural, Trans } from "@lingui/react/macro";
import {
  Anchor,
  Box,
  Center,
  Divider,
  Flex,
  Group,
  Loader,
  SimpleGrid,
  Text,
  Title,
} from "@mantine/core";
import { useParams } from "@remix-run/react";
import { Suspense, useEffect } from "react";
import Avatar from "~/components/Avatar";
import { ConRow } from "~/components/ConsList";
import { Profile } from "~/endpoints";
import {
  useConsWithPosts,
  useProfile,
  useProfileLabels,
  useSelf,
} from "~/hooks";

function Attending({ profile }: { profile: Profile }) {
  const self = useSelf();
  const queriedLabels = useProfileLabels(
    self == null ? profile.did : undefined
  );

  const labels = queriedLabels ?? profile.labels!;

  const selfLabelsSet =
    self != null ? new Set(self.labels!.map((label) => label.val)) : null;
  const labelsSet = new Set(labels!.map((label) => label.val));

  const cons = useConsWithPosts();
  const filteredCons = cons.filter((con) => labelsSet.has(con.identifier));

  const knownCons =
    selfLabelsSet != null
      ? filteredCons.filter((con) => selfLabelsSet.has(con.identifier))
      : filteredCons;

  const unknownCons =
    selfLabelsSet != null
      ? filteredCons.filter((con) => !selfLabelsSet.has(con.identifier))
      : [];

  return (
    <Box>
      <Title order={2} size="h5" fw={500} mb="sm">
        <Trans>Attending</Trans>{" "}
        <Text size="sm" span>
          {filteredCons.length}
        </Text>
      </Title>

      <SimpleGrid cols={{ base: 1, lg: 3 }} mb="sm">
        {knownCons.map((con) => (
          <ConRow
            key={con.identifier}
            con={con}
            showMonthInIcon
            showEndDateOnly
            showLocation={false}
            showFollowed={false}
            showLikeButton={false}
          />
        ))}
      </SimpleGrid>
      {unknownCons.length > 0 ? (
        <>
          <Divider
            label={
              <Plural
                value={unknownCons.length}
                one="# con you aren’t attending"
                other="# cons you aren’t attending"
              />
            }
            labelPosition="left"
            mb="sm"
          />
          <SimpleGrid cols={{ base: 1, lg: 3 }} mb="sm">
            {unknownCons.map((con) => (
              <ConRow
                key={con.identifier}
                con={con}
                showMonthInIcon
                showEndDateOnly
                showLocation={false}
                showFollowed={false}
                showLikeButton={false}
              />
            ))}
          </SimpleGrid>
        </>
      ) : null}
    </Box>
  );
}

export default function Index() {
  const { actor } = useParams();

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
    <Box p="sm">
      <Box mb="sm">
        <Flex
          wrap="nowrap"
          align={{ base: "flex-start", md: "center" }}
          gap="md"
          direction={{ base: "column", md: "row" }}
        >
          <Avatar src={profile.avatar} size="xl" />
          <Box>
            <Title size="h4" fw={500}>
              {profile.displayName}
            </Title>
            <Text>
              <Anchor
                href={`https://bsky.app/profile/${profile.handle}`}
                target="_blank"
                rel="noreferrer"
                c="dimmed"
              >
                @{profile.handle}
              </Anchor>
            </Text>
          </Box>
        </Flex>
      </Box>

      <Suspense
        fallback={
          <Box>
            <Title order={2} size="h5" fw={500} mb="sm">
              <Trans>Attending</Trans>
            </Title>
            <Center p="lg">
              <Loader />
            </Center>
          </Box>
        }
      >
        <Attending profile={profile} />
      </Suspense>
    </Box>
  );
}
