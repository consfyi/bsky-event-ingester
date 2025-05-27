import { Plural, Trans, useLingui } from "@lingui/react/macro";
import {
  Anchor,
  Box,
  Divider,
  Group,
  Loader,
  Popover,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useParams } from "@remix-run/react";
import {
  IconBrandBluesky,
  IconCalendar,
  IconLink,
  IconMapPin,
} from "@tabler/icons-react";
import { differenceInDays } from "date-fns";
import { range, sortBy } from "lodash-es";
import { Suspense, useEffect, useMemo } from "react";
import Avatar from "~/components/Avatar";
import Flag from "~/components/Flag";
import LikeButton from "~/components/LikeButton";
import SimpleErrorBoundary from "~/components/SimpleErrorBoundary";
import { LABELER_DID } from "~/config";
import { Profile } from "~/endpoints";
import {
  Con,
  useCons,
  useFollowedConAttendeesDLE,
  useLikes,
  useSelf,
  useSelfFollowsDLE,
} from "~/hooks";

function ActorSkeleton() {
  return (
    <Group wrap="nowrap" gap="sm">
      <Skeleton circle height={38} />

      <Stack gap={8} miw={0} flex="1 0">
        <Skeleton height={14} width="80%" />
        <Skeleton height={12} width="70%" />
      </Stack>
    </Group>
  );
}

function Actor({ actor }: { actor: Profile }) {
  const [opened, { close, open }] = useDisclosure(false);

  return (
    <Popover
      position="top-start"
      shadow="md"
      offset={{ mainAxis: -51, crossAxis: -17 }}
      opened={opened}
    >
      <Popover.Target>
        <Anchor
          onMouseEnter={open}
          onMouseLeave={close}
          href={`https://bsky.app/profile/${actor.handle}`}
          target="_blank"
          rel="noreferrer"
          c="var(--mantine-color-text)"
          style={{
            textDecoration: "unset",
          }}
        >
          <Group wrap="nowrap" gap="sm">
            <Avatar src={actor.avatar} alt={`@${actor.handle}`} />
            <Stack gap={0} miw={0}>
              <Text size="sm" fw={500} truncate>
                {actor.displayName ? actor.displayName : actor.handle}{" "}
              </Text>
              <Text size="xs" truncate>
                @{actor.handle}
              </Text>
            </Stack>
          </Group>
        </Anchor>
      </Popover.Target>
      <Popover.Dropdown style={{ pointerEvents: "none" }}>
        <Group wrap="nowrap" gap="sm">
          <Avatar src={actor.avatar} alt={`@${actor.handle}`} />
          <Stack gap={0} miw={0}>
            <Text size="sm" fw={500}>
              {actor.displayName ? actor.displayName : actor.handle}
            </Text>
            <Text size="xs">@{actor.handle}</Text>
          </Stack>
        </Group>
      </Popover.Dropdown>
    </Popover>
  );
}

function Header({ con }: { con: Con }) {
  const { i18n, t } = useLingui();

  const dateTimeFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.locale, {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
    [i18n.locale]
  );

  return (
    <Box mb="sm">
      <Group gap={7} wrap="nowrap" align="top">
        {con.post.viewer != null ? (
          <Box mt={2} mb={-2}>
            <LikeButton size="sm" iconSize={24} post={con.post} />
          </Box>
        ) : null}
        <Title size="h4" fw={500}>
          {con.geocoded != null ? (
            <Flag
              country={con.geocoded.country}
              display="inline"
              h={13}
              w={26}
              me={6}
              fit="contain"
            />
          ) : null}{" "}
          {con.name}{" "}
          <Tooltip label={<Trans>View Bluesky Post</Trans>} position="bottom">
            <Anchor
              href={`https://bsky.app/profile/${LABELER_DID}/post/${con.postRkey}`}
              target="_blank"
              rel="noreferrer"
            >
              <IconBrandBluesky
                title={t`View Bluesky Post`}
                size={16}
                stroke={1.5}
              />
            </Anchor>
          </Tooltip>
        </Title>
      </Group>
      <Box mt={4}>
        <Group wrap="nowrap" gap="xs" align="top">
          <Box>
            <IconCalendar title={t`Date`} size={16} stroke={1.5} />
          </Box>
          <Text size="sm" mb={5}>
            <Trans context="[start date]-[end date] ([duration] days)">
              {dateTimeFormat.formatRange(con.start, con.end)} (
              <Plural
                value={differenceInDays(con.end, con.start) + 1}
                one="# day"
                other="# days"
              />
              )
            </Trans>
          </Text>
        </Group>

        <Group wrap="nowrap" gap="xs" align="top">
          <Box>
            <IconMapPin title={t`Location`} size={16} stroke={1.5} />
          </Box>
          <Text size="sm" mb={5}>
            <Anchor
              href={`https://www.google.com/maps?q=${con.location}`}
              target="_blank"
              rel="noreferrer"
              c="var(--mantine-color-text)"
            >
              {con.location}
            </Anchor>{" "}
          </Text>
        </Group>

        <Group wrap="nowrap" gap="xs" align="top">
          <Box>
            <IconLink title={t`Link`} size={16} stroke={1.5} />
          </Box>
          <Text size="sm" mb={5}>
            <Anchor
              href={con.url}
              target="_blank"
              rel="noreferrer"
              style={{ wordBreak: "break-all" }}
            >
              {con.url.replace(/https?:\/\//, "")}
            </Anchor>
          </Text>
        </Group>
      </Box>
    </Box>
  );
}

function AttendeesList({
  isSelfAttending,
  con,
}: {
  isSelfAttending: boolean;
  con: Con;
}) {
  const self = useSelf();
  const { data: selfFollows } = useSelfFollowsDLE();

  const likes = useLikes(
    `at://${LABELER_DID}/app.bsky.feed.post/${con.postRkey}`
  );

  const [knownLikes, unknownLikes] = useMemo(() => {
    let knownLikes: Profile[] = [];
    let unknownLikes: Profile[] = [];

    for (const like of likes) {
      if (self != null && like.actor!.did == self.did) {
        continue;
      }
      const out =
        selfFollows == null || selfFollows.has(like.actor!.did!)
          ? knownLikes
          : unknownLikes;
      out.push(like.actor!);
    }

    knownLikes = sortBy(knownLikes, (actor) => actor.handle);
    unknownLikes = sortBy(unknownLikes, (actor) => actor.handle);

    if (isSelfAttending && self != null) {
      knownLikes.unshift(self);
    }

    return [knownLikes, unknownLikes];
  }, [isSelfAttending, self, selfFollows, likes]);

  return likes!.length > 0 ? (
    <>
      {knownLikes.length > 0 ? (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 5 }} mb="sm">
          {knownLikes.map((actor) => (
            <div key={actor.did}>
              <Actor actor={actor} />
            </div>
          ))}
        </SimpleGrid>
      ) : null}
      {unknownLikes.length > 0 ? (
        <>
          <Divider
            label={
              <Plural
                value={unknownLikes.length}
                one="# person you don’t follow"
                other="# people you don’t follow"
              />
            }
            labelPosition="left"
            mb="xs"
          />
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 5 }} mb="sm">
            {unknownLikes.map((actor) => (
              <div key={actor.did}>
                <Actor actor={actor} />
              </div>
            ))}
          </SimpleGrid>
        </>
      ) : null}
    </>
  ) : (
    <Box>
      <Text c="dimmed" size="sm" h={38} pt={4}>
        <Trans>No known attendees yet.</Trans>
      </Text>
    </Box>
  );
}

export default function Index() {
  const cons = useCons();

  const { identifier } = useParams();

  const con =
    cons != null ? cons.find((con) => con.identifier == identifier) : null;

  const { data: followedConAttendees, loading: followedConAttendeesLoading } =
    useFollowedConAttendeesDLE();

  useEffect(() => {
    document.title = con != null ? con.name : "";
  }, [con]);

  if (con == null) {
    throw new Response(null, {
      status: 404,
    });
  }

  const isAttending = con.post.viewer?.like != null;

  const likeCount = con.post.likeCount ?? 0;

  const knownLikeCount =
    (followedConAttendees != null &&
    followedConAttendees[con.identifier] != null
      ? followedConAttendees[con.identifier].length
      : 0) + (isAttending ? 1 : 0);

  const unknownLikeCount = likeCount - knownLikeCount;

  return (
    <Box p="sm">
      <Header con={con} />

      <Box>
        <Title order={2} size="h5" fw={500} mb="sm">
          <Trans>Attendees</Trans>{" "}
          <Text size="sm" span>
            {isAttending ? (
              <Trans context="attendee count, including you">
                {[likeCount][0]} including you
              </Trans>
            ) : (
              <Trans context="attendee count">{[likeCount][0]}</Trans>
            )}{" "}
          </Text>
        </Title>
        <Box>
          <SimpleErrorBoundary>
            {followedConAttendeesLoading ? (
              <Group wrap="nowrap" gap={7} mb="sm">
                <Loader size={8} color="dimmed" type="bars" />
                <Text c="dimmed" size="xs" lh="md">
                  <Trans>Loading people you follow</Trans>
                </Text>
              </Group>
            ) : null}
            <Suspense
              fallback={
                <>
                  {knownLikeCount > 0 || unknownLikeCount == 0 ? (
                    <SimpleGrid cols={{ base: 1, sm: 2, lg: 5 }}>
                      {range(knownLikeCount > 0 ? knownLikeCount : 1).map(
                        (i) => (
                          <ActorSkeleton key={i} />
                        )
                      )}
                    </SimpleGrid>
                  ) : null}
                  {unknownLikeCount > 0 ? (
                    <>
                      <Divider
                        label={
                          <Plural
                            value={[unknownLikeCount][0]}
                            one="# person you don’t follow"
                            other="# people you don’t follow"
                          />
                        }
                        labelPosition="left"
                        mb="sm"
                      />
                      <SimpleGrid cols={{ base: 1, sm: 2, lg: 5 }} mb="sm">
                        {range(unknownLikeCount).map((i) => (
                          <ActorSkeleton key={i} />
                        ))}
                      </SimpleGrid>
                    </>
                  ) : null}
                </>
              }
            >
              <AttendeesList con={con} isSelfAttending={isAttending} />
            </Suspense>
          </SimpleErrorBoundary>
        </Box>
      </Box>
    </Box>
  );
}
