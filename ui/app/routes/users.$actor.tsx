import type { ActorIdentifier } from "@atcute/lexicons";
import { Plural, Trans } from "@lingui/react/macro";
import {
  Anchor,
  Box,
  Divider,
  Group,
  SimpleGrid,
  Text,
  Title,
} from "@mantine/core";
import { useParams } from "@remix-run/react";
import Avatar from "~/components/Avatar";
import { ConRow } from "~/components/ConsList";
import {
  useConsWithPosts,
  useProfile,
  useProfileLabels,
  useSelf,
} from "~/hooks";

export default function Index() {
  const { actor } = useParams();

  const self = useSelf();
  const profile = useProfile(actor as ActorIdentifier);
  const labels = useProfileLabels(profile != null ? profile.did : undefined)!;

  if (profile == null) {
    throw new Response(null, {
      status: 404,
    });
  }

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
    <Box p="sm">
      <Box mb="sm">
        <Group>
          <Avatar src={profile.avatar} size="xl" />
          <Box>
            <Title size="h4" fw={500}>
              {profile.displayName}{" "}
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
        </Group>
      </Box>

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
    </Box>
  );
}
