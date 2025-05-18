import type {
  ProfileView,
  ProfileViewDetailed,
} from "@atcute/bluesky/types/app/actor/defs";
import type { ThreadViewPost } from "@atcute/bluesky/types/app/feed/defs";
import type { Like } from "@atcute/bluesky/types/app/feed/getLikes";
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
import { useEffect, useMemo, useState } from "react";
import LikeButton from "~/components/LikeButton";
import LoadErrorAlert from "~/components/LoadErrorAlert";
import { LABELER_DID } from "~/config";
import {
  Con,
  useCons,
  useLikes,
  useSelf,
  useSelfFollows,
  useThread,
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
          <Avatar src={actor.avatar} />
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

function Header({
  con,
  thread,
  setIsSelfAttending,
  isSelfAttending,
}: {
  con: Con;
  thread: ThreadViewPost;
  setIsSelfAttending: React.Dispatch<React.SetStateAction<boolean>>;
  isSelfAttending: boolean;
}) {
  const { i18n } = useLingui();

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
        {thread.post.viewer != null ? (
          <LikeButton
            uri={thread.post.uri}
            cid={thread.post.cid}
            size="sm"
            iconSize={24}
            initialLike={thread.post.viewer?.like ?? null}
            setIsLiked={setIsSelfAttending}
            isLiked={isSelfAttending}
          />
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
          <IconExternalLink size={12} /> <Trans>View Bluesky Post</Trans>
        </Anchor>
      </Group>
      <Box mt={4}>
        <Text size="sm" mb={5}>
          <IconCalendar size={12} />{" "}
          {dateTimeFormat.formatRange(con.start, con.end)}
        </Text>

        <Text size="sm" mb={5}>
          <IconMapPin size={12} />{" "}
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
          <IconLink size={12} />{" "}
          <Anchor href={con.url} target="_blank" rel="noreferrer">
            {con.url.replace(/https?:\/\//, "")}
          </Anchor>
        </Text>
      </Box>
    </Box>
  );
}

function Attendees({
  isSelfAttending,
  thread,
  likes,
}: {
  isSelfAttending: boolean;
  thread: ThreadViewPost;
  likes: Like[] | null;
}) {
  const { data: self } = useSelf();
  const { data: selfFollows, isLoading: selfFollowsIsLoading } =
    useSelfFollows();

  const [knownLikes, unknownLikes] = useMemo(() => {
    if (likes == null) {
      return [null, null];
    }

    let knownLikes: (ProfileView | ProfileViewDetailed)[] = [];
    if (isSelfAttending && self != null) {
      knownLikes.push(self);
    }
    let unknownLikes: (ProfileView | ProfileViewDetailed)[] = [];

    for (const like of likes) {
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

    return [knownLikes, unknownLikes];
  }, [isSelfAttending, self, selfFollows, likes]);

  const likeCountWithoutSelf =
    (thread.post.likeCount || 0) - (thread.post.viewer?.like != null ? 1 : 0);

  return (
    <Box mt="sm">
      <Text size="md" fw={500}>
        <Trans>Attendees</Trans>{" "}
        {likes != null ? (
          <Text size="sm" span>
            {isSelfAttending ? (
              <Trans context="attendee count, including you">
                {likeCountWithoutSelf + 1} including you
              </Trans>
            ) : (
              <Trans context="attendee count">{likeCountWithoutSelf}</Trans>
            )}
          </Text>
        ) : null}
      </Text>
      {!selfFollowsIsLoading && knownLikes != null && unknownLikes != null ? (
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
        <Center p="lg">
          <Loader />
        </Center>
      )}
    </Box>
  );
}

export default function Index() {
  const { data: cons, error, isLoading } = useCons();
  const { identifier } = useParams();

  const [isSelfAttending, setIsSelfAttending] = useState(false);

  const con =
    cons != null ? cons.find((con) => con.identifier == identifier) : null;

  useEffect(() => {
    document.title = con != null ? con.name : "";
  }, [con]);

  const { data: thread, isLoading: threadIsLoading } = useThread(
    con != null ? `at://${LABELER_DID}/app.bsky.feed.post/${con.rkey}` : null
  );

  useEffect(() => {
    if (thread != null && thread.post.viewer != null) {
      setIsSelfAttending(thread.post.viewer.like != null);
    }
  }, [thread, setIsSelfAttending]);

  const {
    data: likes,
    error: likesError,
    isLoading: likesIsLoading,
  } = useLikes(
    con != null ? `at://${LABELER_DID}/app.bsky.feed.post/${con.rkey}` : null
  );

  if (error != null) {
    return <LoadErrorAlert error={error} />;
  }

  if (isLoading || threadIsLoading) {
    return (
      <Center p="lg">
        <Loader />
      </Center>
    );
  }

  if (cons == null) {
    return <LoadErrorAlert error={null} />;
  }

  if (con == null || thread == null) {
    throw new Response(null, {
      status: 404,
      statusText: "Not Found",
    });
  }

  return (
    <Box px="sm">
      <Header
        con={con}
        thread={thread}
        isSelfAttending={isSelfAttending}
        setIsSelfAttending={setIsSelfAttending}
      />
      {likesError != null ? (
        <LoadErrorAlert error={error} />
      ) : likesIsLoading ? (
        <Center p="lg">
          <Loader />
        </Center>
      ) : likes == null ? (
        <LoadErrorAlert error={null} />
      ) : (
        <Attendees
          thread={thread}
          likes={likes}
          isSelfAttending={isSelfAttending}
        />
      )}
    </Box>
  );
}
