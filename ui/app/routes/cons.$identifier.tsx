import {
  IconCalendar,
  IconExternalLink,
  IconMapPin,
} from "@tabler/icons-react";
import { useParams } from "@remix-run/react";
import {
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
import { useCons, useLikes } from "~/hooks";
import { format as formatDate } from "date-fns";
import { Like, Profile } from "~/bluesky";
import { LABELER_DID } from "~/config";
import { useContext, useEffect, useMemo } from "react";
import { UserViewContext } from "~/context";

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
      <Group>
        <Tooltip
          position="right"
          label={
            <div style={{ flex: 1, minWidth: 0 }}>
              <Text size="sm" fw={500} truncate>
                {actor.displayName ? actor.displayName : actor.handle}
              </Text>

              <Text size="xs" truncate>
                {actor.handle}
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
            {actor.handle}
          </Text>
        </div>
      </Group>
    </Anchor>
  );
}

export default function Index() {
  const { cons, error, isLoading } = useCons();
  const { identifier } = useParams();

  const con =
    cons != null ? cons.find((con) => con.identifier == identifier) : null;

  useEffect(() => {
    document.title = con != null ? con.name : "";
  }, [con]);

  const {
    data: likes,
    isLoading: likesIsLoading,
    error: likesError,
  } = useLikes(
    con != null ? `at://${LABELER_DID}/app.bsky.feed.post/${con.rkey}` : null
  );

  const { userView } = useContext(UserViewContext);
  const follows = userView?.follows;

  const [isSelfAttending, knownLikes, unknownLikes] = useMemo(() => {
    if (likes == null) {
      return [false, null, null];
    }

    let isSelfAttending = false;
    const knownLikes: Like[] = [];
    const unknownLikes: Like[] = [];

    for (const like of likes) {
      if (userView != null && like.actor.did == userView.profile.did) {
        isSelfAttending = true;
        continue;
      }
      const out =
        follows == null || follows.has(like.actor.did)
          ? knownLikes
          : unknownLikes;
      out.push(like);
    }

    return [isSelfAttending, knownLikes, unknownLikes];
  }, [userView, likes, follows]);

  if (error != null) {
    return (
      <Alert color="red" title="Error">
        <Text size="sm">Couldn’t load con data.</Text>
        <pre>{error.toString()}</pre>
      </Alert>
    );
  }

  if (isLoading) {
    return (
      <Center p="lg">
        <Loader></Loader>
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

  if (con == null) {
    throw new Response(null, {
      status: 404,
      statusText: "Not Found",
    });
  }

  return (
    <Box px="sm">
      <Box mt="sm">
        <Text size="lg" fw={500}>
          {con.name}{" "}
          <Anchor
            href={`https://bsky.app/profile/${LABELER_DID}/post/${con.rkey}`}
            target="_blank"
            rel="noreferrer"
            size="xs"
          >
            <IconExternalLink size={12} /> View Bluesky Post
          </Anchor>
        </Text>
        <Box mt={4}>
          <Text size="sm" mb={5}>
            <IconCalendar size={12} /> {WEEKDAY_FORMAT.format(con.start)}{" "}
            {formatDate(con.start, "yyyy-MM-dd")} –{" "}
            {WEEKDAY_FORMAT.format(con.end)} {formatDate(con.end, "yyyy-MM-dd")}
          </Text>

          <Text size="sm">
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
        </Box>
      </Box>
      <Box mt="sm">
        <Text size="md" fw={500}>
          Attendees{" "}
          {likes != null ? (
            <small>
              {likes.length}
              {isSelfAttending ? " including you" : ""}
            </small>
          ) : null}
        </Text>
        {likesError != null ? (
          <Alert color="red" title="Error">
            <Text size="sm">Couldn’t load attendees data.</Text>
            <pre>{likesError.toString()}</pre>
          </Alert>
        ) : likesIsLoading ? (
          <Center p="lg">
            <Loader></Loader>
          </Center>
        ) : likes == null ? (
          <Alert color="red" title="Error">
            <Text size="sm">Couldn’t load attendees data.</Text>
          </Alert>
        ) : (
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 5 }} my="xs">
            {isSelfAttending ? (
              <div>
                <Actor actor={userView!.profile} />
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
        )}
      </Box>
    </Box>
  );
}

const WEEKDAY_FORMAT = new Intl.DateTimeFormat("en", { weekday: "short" });
