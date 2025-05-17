import {
  IconCalendar,
  IconExternalLink,
  IconHeart,
  IconHeartFilled,
  IconLink,
  IconMapPin,
} from "@tabler/icons-react";
import { useParams } from "@remix-run/react";
import {
  ActionIcon,
  Alert,
  Anchor,
  Avatar,
  Box,
  Center,
  Group,
  Loader,
  SimpleGrid,
  Text,
  Tooltip,
} from "@mantine/core";
import {
  Con,
  useClient,
  useCons,
  useLikes,
  useSelf,
  useSelfFollows,
  useThread,
} from "~/hooks";
import { format as formatDate } from "date-fns";
import { LABELER_DID } from "~/config";
import { useCallback, useEffect, useMemo, useState } from "react";
import { sortBy } from "lodash-es";
import type { Like } from "@atcute/bluesky/types/app/feed/getLikes";
import type {
  ProfileView,
  ProfileViewDetailed,
} from "@atcute/bluesky/types/app/actor/defs";
import type { ThreadViewPost } from "@atcute/bluesky/types/app/feed/defs";
import type { Cid, ResourceUri } from "@atcute/lexicons";

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
      <Group>
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
            {actor.displayName ? actor.displayName : actor.handle}
          </Text>

          <Text size="xs" truncate>
            @{actor.handle}
          </Text>
        </div>
      </Group>
    </Anchor>
  );
}

function LikeButton({
  uri,
  cid,
  initialLike,
  setLikeState,
}: {
  uri: ResourceUri;
  cid: Cid;
  initialLike: ResourceUri | null;
  setLikeState?: (v: boolean) => void;
}) {
  const client = useClient();

  const [likeUri, setLikeUri] = useState(initialLike);
  const [expectedOn, setExpectedOn] = useState(initialLike != null);
  const [pending, setPending] = useState(false);

  const handleClick = useCallback(() => {
    setExpectedOn(!expectedOn);
    if (setLikeState != null) {
      setLikeState(!expectedOn);
    }
  }, [setLikeState, expectedOn]);

  useEffect(() => {
    if (pending) return;

    (async () => {
      if (expectedOn && likeUri == null) {
        setPending(true);
        try {
          const r = await client!.like(uri, cid);
          setLikeUri(r!);
        } finally {
          setPending(false);
        }
      } else if (!expectedOn && likeUri != null) {
        setPending(true);
        try {
          await client!.unlike(likeUri);
          setLikeUri(null);
        } finally {
          setPending(false);
        }
      }
    })();
  }, [expectedOn, likeUri, client, uri, cid, pending]);

  return (
    <Tooltip label={expectedOn ? "Attending" : "Not attending"}>
      <ActionIcon
        color="red"
        variant="transparent"
        size="sm"
        onClick={handleClick}
      >
        {expectedOn ? <IconHeartFilled size={16} /> : <IconHeart size={16} />}
      </ActionIcon>
    </Tooltip>
  );
}

function Header({
  con,
  thread,
  setLikeState,
}: {
  con: Con;
  thread: ThreadViewPost;
  setLikeState: (v: boolean) => void;
}) {
  return (
    <Box mt="sm">
      <Group gap={7}>
        {thread.post.viewer != null ? (
          <LikeButton
            uri={thread.post.uri}
            cid={thread.post.cid}
            initialLike={thread.post.viewer?.like ?? null}
            setLikeState={setLikeState}
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
          <IconExternalLink size={12} /> View Bluesky Post
        </Anchor>
      </Group>
      <Box mt={4}>
        <Text size="sm" mb={5}>
          <IconCalendar size={12} /> {WEEKDAY_FORMAT.format(con.start)}{" "}
          {formatDate(con.start, "yyyy-MM-dd")} –{" "}
          {WEEKDAY_FORMAT.format(con.end)} {formatDate(con.end, "yyyy-MM-dd")}
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
  const { data: selfFollows } = useSelfFollows();

  const [knownLikes, unknownLikes] = useMemo(() => {
    if (likes == null) {
      return [null, null];
    }

    let knownLikes: Like[] = [];
    let unknownLikes: Like[] = [];

    for (const like of likes) {
      if (self != null && like.actor.did == self.did) {
        continue;
      }
      const out =
        selfFollows == null || selfFollows.has(like.actor.did)
          ? knownLikes
          : unknownLikes;
      out.push(like);
    }

    knownLikes = sortBy(knownLikes, (like) => like.actor.handle);
    unknownLikes = sortBy(unknownLikes, (like) => like.actor.handle);

    return [knownLikes, unknownLikes];
  }, [self, selfFollows, likes]);
  const likeCountWithoutSelf =
    (thread.post.likeCount || 0) - (thread.post.viewer?.like != null ? 1 : 0);

  return (
    <Box mt="sm">
      <Text size="md" fw={500}>
        Attendees{" "}
        {likes != null ? (
          <small>
            {likeCountWithoutSelf + (isSelfAttending ? 1 : 0)}
            {isSelfAttending ? " including you" : ""}
          </small>
        ) : null}
      </Text>
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 5 }} my="xs">
        {isSelfAttending && self != null ? (
          <div>
            <Actor actor={self} />
          </div>
        ) : null}
        {knownLikes!.map((like) => (
          <div key={like.actor.did}>
            <Actor actor={like.actor} />
          </div>
        ))}
        {unknownLikes!.map((like) => (
          <div key={like.actor.did} style={{ opacity: 0.25 }}>
            <Actor actor={like.actor} />
          </div>
        ))}
      </SimpleGrid>
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
    return (
      <Alert color="red" title="Error">
        <Text size="sm">Couldn’t load con data.</Text>
        <pre>{error.toString()}</pre>
      </Alert>
    );
  }

  if (isLoading || threadIsLoading) {
    return (
      <Center p="lg">
        <Loader />
      </Center>
    );
  }

  if (cons == null) {
    return (
      <Alert color="red" title="Error">
        <Text size="sm">Couldn’t load con data.</Text>
      </Alert>
    );
  }

  if (con == null || thread == null) {
    throw new Response(null, {
      status: 404,
      statusText: "Not Found",
    });
  }

  return (
    <Box px="sm">
      <Header con={con} thread={thread} setLikeState={setIsSelfAttending} />
      {likesError != null ? (
        <Alert color="red" title="Error">
          <Text size="sm">Couldn’t load attendees data.</Text>
          <pre>{likesError.toString()}</pre>
        </Alert>
      ) : likesIsLoading ? (
        <Center p="lg">
          <Loader />
        </Center>
      ) : likes == null ? (
        <Alert color="red" title="Error">
          <Text size="sm">Couldn’t load attendees data.</Text>
        </Alert>
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

const WEEKDAY_FORMAT = new Intl.DateTimeFormat("en", { weekday: "short" });
