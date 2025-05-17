import {
  Alert,
  Anchor,
  Center,
  Group,
  Loader,
  Table,
  Text,
} from "@mantine/core";
import type { MetaFunction } from "@remix-run/node";
import { Link } from "@remix-run/react";
import { groupBy } from "lodash-es";
import { format as formatDate, addMonths, setDate } from "date-fns";
import { Fragment, useMemo, useState } from "react";
import { Con, useConPosts, useCons } from "~/hooks";
import { IconCalendar, IconMapPin, IconUsers } from "@tabler/icons-react";
import clientMetadata from "../../public/client-metadata.json";
import { LikeButton } from "~/components/LikeButton";
import type { PostView } from "@atcute/bluesky/types/app/feed/defs";

function* monthRange(start: Date, end: Date): Generator<Date> {
  while (start < end) {
    yield start;
    start = addMonths(start, 1);
  }
}

export const meta: MetaFunction = () => {
  return [{ title: clientMetadata.client_name }];
};

function ConTableRow({ con, post }: { con: Con; post: PostView }) {
  const [isSelfAttending, setIsSelfAttending] = useState(
    post.viewer?.like != null
  );

  const likeCountWithoutSelf =
    (post.likeCount || 0) - (post.viewer?.like != null ? 1 : 0);
  return (
    <Table.Tr key={con.identifier}>
      <Table.Td>
        <Group gap={7}>
          {post.viewer != null ? (
            <LikeButton
              uri={post.uri}
              cid={post.cid}
              size="sm"
              initialLike={post.viewer?.like ?? null}
              setLikeState={setIsSelfAttending}
            />
          ) : null}

          <Text size="sm">
            <Anchor<typeof Link>
              fw={500}
              component={Link}
              to={`/cons/${con.identifier}`}
            >
              {con.name}
            </Anchor>
          </Text>
        </Group>
        <Text size="sm">
          <IconUsers size={12} />{" "}
          {likeCountWithoutSelf + (isSelfAttending ? 1 : 0)} •{" "}
          <IconCalendar size={12} /> {WEEKDAY_FORMAT.format(con.start)}{" "}
          {formatDate(con.start, "yyyy-MM-dd")} –{" "}
          {WEEKDAY_FORMAT.format(con.end)} {formatDate(con.end, "yyyy-MM-dd")} •{" "}
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
          </Anchor>{" "}
        </Text>
      </Table.Td>
    </Table.Tr>
  );
}

export default function Index() {
  const { data: cons, error, isLoading } = useCons();
  const { data: conPosts, isLoading: conPostsIsLoading } = useConPosts();

  const consByMonth = useMemo(() => {
    if (cons == null) {
      return null;
    }

    return groupBy(cons, (con) => {
      return formatDate(con.start, "yyyy-MM");
    });
  }, [cons]);

  if (error != null) {
    return (
      <Alert color="red" title="Error">
        <Text size="sm">Couldn’t load con data.</Text>
        <pre>{error.toString()}</pre>
      </Alert>
    );
  }

  if (isLoading || conPostsIsLoading) {
    return (
      <Center p="lg">
        <Loader />
      </Center>
    );
  }

  if (cons == null || conPosts == null || consByMonth == null) {
    return (
      <Alert color="red" title="Error">
        <Text size="sm">Couldn’t load con data.</Text>
      </Alert>
    );
  }

  const firstDate = setDate(cons[0].start, 1);
  const lastDate = addMonths(setDate(cons[cons.length - 1].start, 1), 1);

  return (
    <Table>
      <Table.Tbody>
        {Array.from(monthRange(firstDate, lastDate)).map((date) => {
          const groupKey = formatDate(date, "yyyy-MM");
          return (
            <Fragment key={groupKey}>
              <Table.Tr bg="var(--mantine-color-gray-0)">
                <Table.Th>
                  <Text fw={500} size="md">
                    {MONTH_FORMAT.format(date)} {formatDate(date, "yyyy")}
                  </Text>
                </Table.Th>
              </Table.Tr>
              {(consByMonth[groupKey] ?? []).map((con) => (
                <ConTableRow
                  key={con.identifier}
                  con={con}
                  post={conPosts[con.rkey]}
                />
              ))}
            </Fragment>
          );
        })}
      </Table.Tbody>
    </Table>
  );
}

const MONTH_FORMAT = new Intl.DateTimeFormat("en", { month: "long" });
const WEEKDAY_FORMAT = new Intl.DateTimeFormat("en", { weekday: "short" });
