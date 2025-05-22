import { Plural, Trans, useLingui } from "@lingui/react/macro";
import {
  Anchor,
  Avatar,
  Box,
  Divider,
  Group,
  Loader,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
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
import LikeButton from "~/components/LikeButton";
import SimpleErrorBoundary from "~/components/SimpleErrorBoundary";
import { LABELER_DID } from "~/config";
import { Post, Profile } from "~/endpoints";
import {
  Con,
  useConPosts,
  useCons,
  useLikes as useLikes,
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
      href={`https://bsky.app/profile/${actor.handle}`}
      target="_blank"
      rel="noreferrer"
      style={{
        color: "unset",
        textDecoration: "unset",
      }}
    >
      <Group wrap="nowrap" gap="sm">
        <Tooltip
          position="right"
          label={
            <Stack gap={0} miw={0}>
              <Text size="sm" fw={500} truncate>
                {actor.displayName ? actor.displayName : actor.handle}
              </Text>

              <Text size="xs" truncate>
                @{actor.handle}
              </Text>
            </Stack>
          }
        >
          <Avatar src={actor.avatar} alt={`@${actor.handle}`} />
        </Tooltip>
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

function Header({ con, post }: { con: Con; post: Post }) {
  const { i18n, t } = useLingui();

  const dateTimeFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.locale, {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
    [i18n]
  );

  return (
    <Box>
      <Group gap={7} wrap="nowrap" align="top">
        {post.viewer != null ? (
          <Box mt={2} mb={-2}>
            <LikeButton size="sm" iconSize={24} post={post} />
          </Box>
        ) : null}
        <Text size="lg" fw={500}>
          {con.name}{" "}
          <Tooltip label={<Trans>View Bluesky Post</Trans>} position="bottom">
            <Anchor
              href={`https://bsky.app/profile/${LABELER_DID}/post/${con.rkey}`}
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
        </Text>
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
              style={{
                color: "unset",
              }}
            >
              {con.location}
            </Anchor>
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

  const likes = useLikes(`at://${LABELER_DID}/app.bsky.feed.post/${con.rkey}`);

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
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 5 }} mt="xs">
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
            label={<Trans>People you don’t follow</Trans>}
            labelPosition="left"
            mt="xs"
          />
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 5 }} mt="xs">
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
      <Text c="dimmed" size="sm" h={38}>
        <Trans>No known attendees yet.</Trans>
      </Text>
    </Box>
  );
}

export default function Index() {
  const cons = useCons();
  const conPosts = useConPosts();

  const { identifier } = useParams();

  const con =
    cons != null ? cons.find((con) => con.identifier == identifier) : null;

  const { loading: selfFollowsIsLoading } = useSelfFollowsDLE();

  useEffect(() => {
    document.title = con != null ? con.name : "";
  }, [con]);

  if (con == null) {
    throw new Response(null, {
      status: 404,
    });
  }

  const post = conPosts![con.rkey]!;

  const isAttending = post.viewer?.like != null;

  const likeCountWithoutSelf = (post.likeCount || 0) - (isAttending ? 1 : 0);
  const likeCount = isAttending
    ? likeCountWithoutSelf + 1
    : likeCountWithoutSelf;

  return (
    <Box p="sm">
      <Header con={con} post={post} />

      <Box mt="sm">
        <Text size="md" fw={500}>
          <Trans>Attendees</Trans>{" "}
          <Text size="sm" span>
            {isAttending ? (
              <Trans context="attendee count, including you">
                {likeCount} including you
              </Trans>
            ) : (
              <Trans context="attendee count">{likeCount}</Trans>
            )}{" "}
            {selfFollowsIsLoading ? <Loader size={10} color="dimmed" /> : null}
          </Text>
        </Text>
        <Box mt="xs">
          <SimpleErrorBoundary>
            <Suspense
              fallback={
                <SimpleGrid cols={{ base: 1, sm: 2, lg: 5 }} mt="xs">
                  {range(Math.max(likeCount, 1)).map((i) => (
                    <ActorSkeleton key={i} />
                  ))}
                </SimpleGrid>
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
