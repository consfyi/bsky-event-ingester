import type {
  ProfileView,
  ProfileViewDetailed,
} from "@atcute/bluesky/types/app/actor/defs";
import type { PostView } from "@atcute/bluesky/types/app/feed/defs";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  Anchor,
  Avatar,
  Box,
  Center,
  Divider,
  Group,
  Loader,
  SimpleGrid,
  Text,
  Tooltip,
} from "@mantine/core";
import { useParams } from "@remix-run/react";
import {
  IconCalendar,
  IconExternalLink,
  IconLink,
  IconMapPin,
} from "@tabler/icons-react";
import { sortBy } from "lodash-es";
import { Suspense, useEffect, useMemo } from "react";
import LikeButton from "~/components/LikeButton";
import { useLocalAttending } from "~/components/LocalAttendingContextProvider";
import SimpleErrorBoundary from "~/components/SimpleErrorBoundary";
import { LABELER_DID } from "~/config";
import {
  Con,
  useConPosts,
  useCons,
  useLikes,
  useSelf,
  useSelfFollows,
} from "~/hooks";

function Actor({ actor }: { actor: ProfileView | ProfileViewDetailed }) {
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
            <div style={{ flex: 1, minWidth: 0 }}>
              <Text size="sm" fw={500} truncate>
                {actor.displayName ? actor.displayName : actor.handle}
              </Text>

              <Text size="xs" truncate>
                @{actor.handle}
              </Text>
            </div>
          }
        >
          <Avatar src={actor.avatar} alt={`@${actor.handle}`} />
        </Tooltip>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text size="sm" fw={500} truncate>
            {actor.displayName ? actor.displayName : actor.handle}{" "}
          </Text>

          <Text size="xs" truncate>
            @{actor.handle}
          </Text>
        </div>
      </Group>
    </Anchor>
  );
}

function Header({ con, post }: { con: Con; post: PostView }) {
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
    <Box mt="sm">
      <Group gap={7} wrap="nowrap">
        {post.viewer != null ? (
          <LikeButton size="sm" iconSize={24} conId={con.identifier} />
        ) : null}
        <Text size="lg" fw={500}>
          {con.name}
        </Text>
        <Anchor
          href={`https://bsky.app/profile/${LABELER_DID}/post/${con.rkey}`}
          target="_blank"
          rel="noreferrer"
          size="xs"
        >
          <IconExternalLink title={t`View Bluesky Post`} size={12} />{" "}
          <Trans>View Bluesky Post</Trans>
        </Anchor>
      </Group>
      <Box mt={4}>
        <Text size="sm" mb={5}>
          <IconCalendar title={t`Date`} size={12} />{" "}
          {dateTimeFormat.formatRange(con.start, con.end)}
        </Text>

        <Text size="sm" mb={5}>
          <IconMapPin title={t`Location`} size={12} />{" "}
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

        <Text size="sm" mb={5}>
          <IconLink title={t`Link`} size={12} />{" "}
          <Anchor href={con.url} target="_blank" rel="noreferrer">
            {con.url.replace(/https?:\/\//, "")}
          </Anchor>
        </Text>
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
  const { data: self } = useSelf();
  const { data: selfFollows } = useSelfFollows();

  const { data: likes } = useLikes(
    `at://${LABELER_DID}/app.bsky.feed.post/${con.rkey}`
  );

  const [knownLikes, unknownLikes] = useMemo(() => {
    let knownLikes: (ProfileView | ProfileViewDetailed)[] = [];
    let unknownLikes: (ProfileView | ProfileViewDetailed)[] = [];

    for (const like of likes!) {
      if (self != null && like.actor.did == self.did) {
        continue;
      }
      const out =
        selfFollows == null || selfFollows.has(like.actor.did)
          ? knownLikes
          : unknownLikes;
      out.push(like.actor);
    }

    knownLikes = sortBy(knownLikes, (actor) => actor.handle);
    unknownLikes = sortBy(unknownLikes, (actor) => actor.handle);

    if (isSelfAttending && self != null) {
      knownLikes.unshift(self);
    }

    return [knownLikes, unknownLikes];
  }, [isSelfAttending, self, selfFollows, likes]);

  return (
    <Box mt="sm">
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
    </Box>
  );
}

export default function Index() {
  const { data: cons } = useCons();
  const { data: conPosts } = useConPosts();

  const { identifier } = useParams();

  const con =
    cons != null ? cons.find((con) => con.identifier == identifier) : null;

  const { isAttending } = useLocalAttending(
    con != null ? con.identifier : null
  );

  useEffect(() => {
    document.title = con != null ? con.name : "";
  }, [con]);

  if (con == null) {
    throw new Response(null, {
      status: 404,
      statusText: "Not Found",
    });
  }

  const post = conPosts![con.rkey]!;

  const likeCountWithoutSelf =
    (post.likeCount || 0) - (post.viewer?.like != null ? 1 : 0);

  return (
    <Box px="sm">
      <Header con={con} post={post} />

      <Box mt="sm">
        <Text size="md" fw={500}>
          <Trans>Attendees</Trans>{" "}
          <Text size="sm" span>
            {isAttending ? (
              <Trans context="attendee count, including you">
                {likeCountWithoutSelf + 1} including you
              </Trans>
            ) : (
              <Trans context="attendee count">{likeCountWithoutSelf}</Trans>
            )}
          </Text>
        </Text>
        <SimpleErrorBoundary>
          <Suspense
            fallback={
              <Center p="lg">
                <Loader />
              </Center>
            }
          >
            <AttendeesList con={con} isSelfAttending={isAttending} />
          </Suspense>
        </SimpleErrorBoundary>
      </Box>
    </Box>
  );
}
