import { Plural, Trans, useLingui } from "@lingui/react/macro";
import {
  Anchor,
  Box,
  Divider,
  Group,
  Indicator,
  Loader,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  Title as MantineTitle,
  Tooltip,
} from "@mantine/core";
import {
  IconBrandBluesky,
  IconCalendar,
  IconLink,
  IconMapPin,
} from "@tabler/icons-react";
import { differenceInDays, isAfter, subDays } from "date-fns";
import { comparing, map, Range, sorted, toArray } from "iter-fns";
import { Suspense, useMemo } from "react";
import { Link } from "react-router";
import Avatar from "~/components/Avatar";
import Flag from "~/components/Flag";
import LikeButton from "~/components/LikeButton";
import SimpleErrorBoundary from "~/components/SimpleErrorBoundary";
import { LABELER_DID } from "~/config";
import { reinterpretAsLocalDate } from "~/date";
import { Profile } from "~/endpoints";
import {
  Con,
  ConWithPost,
  useFollowedConAttendeesDLE,
  useLikes,
  useNow,
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
  return (
    <Anchor
      component={Link}
      to={`/users/${actor.handle}`}
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

    knownLikes = sorted(
      knownLikes,
      comparing((actor) => actor.handle)
    );
    unknownLikes = sorted(
      unknownLikes,
      comparing((actor) => actor.handle)
    );

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
            <Actor actor={actor} key={actor.did} />
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
            mb="sm"
          />
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 5 }} mb="sm">
            {unknownLikes.map((actor) => (
              <Actor actor={actor} key={actor.did} />
            ))}
          </SimpleGrid>
        </>
      ) : null}
    </>
  ) : (
    <Box mb="sm">
      <Text c="dimmed" size="sm" h={38} pt={4}>
        <Trans>Nobody known to be going yet.</Trans>
      </Text>
    </Box>
  );
}

export function Title({ con }: { con: ConWithPost }) {
  const { t } = useLingui();

  return (
    <Group gap={7} wrap="nowrap" align="top">
      {con.post.viewer != null ? (
        <Box mt={2} mb={-2}>
          <LikeButton size="sm" iconSize={24} post={con.post} />
        </Box>
      ) : null}
      <MantineTitle size="h4" fw={500}>
        <Flag country={con.country} size={14} me={6} /> {con.name}{" "}
        <Tooltip label={<Trans>View Bluesky Post</Trans>}>
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
      </MantineTitle>
    </Group>
  );
}

export function Body({ con }: { con: ConWithPost }) {
  const { i18n, t } = useLingui();

  const dateTimeFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.locale, {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
    [t]
  );

  const now = useNow();
  const active = isAfter(now, con.start) && !isAfter(now, con.end);

  const { data: followedConAttendees, loading: followedConAttendeesLoading } =
    useFollowedConAttendeesDLE();

  const self = useSelf();

  const isAttending = con.post.viewer?.like != null;

  const likeCount = con.post.likeCount ?? 0;

  const knownLikeCount =
    self != null
      ? (followedConAttendees != null &&
        followedConAttendees[con.identifier] != null
          ? followedConAttendees[con.identifier].length
          : 0) + (isAttending ? 1 : 0)
      : likeCount;

  const unknownLikeCount = likeCount - knownLikeCount;

  return (
    <>
      <Box mb="sm">
        <Box mt={4}>
          <Group wrap="nowrap" gap="xs" align="top">
            <Box>
              <Indicator
                position="top-start"
                color="green"
                processing
                size={12}
                withBorder
                disabled={!active}
                zIndex={2}
              >
                <IconCalendar title={t`Date`} size={16} stroke={1.5} />
              </Indicator>
            </Box>
            <Text size="sm" mb={5}>
              <Trans context="[start date]-[end date] ([duration] days long)">
                {dateTimeFormat.formatRange(
                  reinterpretAsLocalDate(con.start),
                  reinterpretAsLocalDate(subDays(con.end, 1))
                )}{" "}
                (
                <Plural
                  value={differenceInDays(con.end, con.start)}
                  one="# day long"
                  other="# days long"
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
                href={`https://www.google.com/maps?q=${encodeURIComponent(
                  con.address
                )}`}
                target="_blank"
                rel="noreferrer"
                c="var(--mantine-color-text)"
              >
                {con.address}
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

      <Box mb="calc(var(--mantine-spacing-sm) * -1)">
        <MantineTitle order={2} size="h5" fw={500} mb="sm">
          <Trans>Going</Trans>{" "}
          <Text size="sm" span>
            {isAttending ? (
              <Trans context="attendee count, including you">
                {[likeCount][0]} including you
              </Trans>
            ) : (
              <Trans context="attendee count">{[likeCount][0]}</Trans>
            )}{" "}
          </Text>
        </MantineTitle>
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
                    <SimpleGrid cols={{ base: 1, sm: 2, lg: 5 }} mb="sm">
                      {toArray(
                        map(
                          Range.to(knownLikeCount > 0 ? knownLikeCount : 1),
                          (i) => <ActorSkeleton key={i} />
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
                        {toArray(
                          map(Range.to(unknownLikeCount), (i) => (
                            <ActorSkeleton key={i} />
                          ))
                        )}
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
    </>
  );
}

export default function ConDetails({ con }: { con: ConWithPost }) {
  return (
    <>
      <Title con={con} />
      <Body con={con} />
    </>
  );
}
