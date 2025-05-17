import {
  Alert,
  Anchor,
  Box,
  Center,
  Group,
  Loader,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Tooltip,
} from "@mantine/core";
import type { MetaFunction } from "@remix-run/node";
import { Link } from "@remix-run/react";
import { groupBy } from "lodash-es";
import {
  format as formatDate,
  addMonths,
  setDate,
  getDate,
  getDay,
} from "date-fns";
import { Fragment, useMemo, useState } from "react";
import { Con, useClient, useConPosts, useCons } from "~/hooks";
import {
  IconBrandBluesky,
  IconCalendarMonth,
  IconMapPin,
  IconPaw,
  IconUsers,
} from "@tabler/icons-react";
import clientMetadata from "../../public/client-metadata.json";
import { LikeButton } from "~/components/LikeButton";
import type { PostView } from "@atcute/bluesky/types/app/feed/defs";
import { differenceInDays } from "date-fns/fp";

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
  const duration = differenceInDays(con.start, con.end);

  return (
    <Table.Tr key={con.identifier}>
      <Table.Td
        style={{
          maxWidth: 0,
          textOverflow: "ellipsis",
          overflow: "hidden",
          whiteSpace: "nowrap",
        }}
      >
        <Group gap="xs" wrap="nowrap">
          <Anchor<typeof Link> component={Link} to={`/cons/${con.identifier}`}>
            <ThemeIcon
              size="xl"
              variant="light"
              color={
                [
                  "red",
                  "orange",
                  "yellow",
                  "green",
                  "blue",
                  "indigo",
                  "violet",
                ][getDay(con.start)]
              }
            >
              <Stack gap={0}>
                <Text size="md" ta="center" fw={500}>
                  {WEEKDAY_FORMAT.format(con.start)}
                </Text>
                <Text size="xs" ta="center" fw={500}>
                  {getDate(con.start)}
                </Text>
              </Stack>
            </ThemeIcon>
          </Anchor>
          <Box style={{ minWidth: 0 }}>
            <Group gap={7} wrap="nowrap">
              {post.viewer != null ? (
                <LikeButton
                  uri={post.uri}
                  cid={post.cid}
                  size="xs"
                  initialLike={post.viewer?.like ?? null}
                  setLikeState={setIsSelfAttending}
                />
              ) : null}

              <Text size="sm" truncate>
                <Anchor<typeof Link>
                  fw={500}
                  component={Link}
                  to={`/cons/${con.identifier}`}
                >
                  {con.name}
                </Anchor>
              </Text>
            </Group>
            <Text size="sm" truncate>
              <IconUsers size={12} />{" "}
              {likeCountWithoutSelf + (isSelfAttending ? 1 : 0)} •{" "}
              <Tooltip
                label={`${WEEKDAY_FORMAT.format(con.start)} ${formatDate(
                  con.start,
                  "yyyy-MM-dd"
                )} – ${WEEKDAY_FORMAT.format(con.end)} ${formatDate(
                  con.end,
                  "yyyy-MM-dd"
                )}`}
              >
                <span>
                  <IconCalendarMonth size={12} /> {duration}{" "}
                  {duration != 1 ? "days" : "day"}
                </span>
              </Tooltip>{" "}
              • <IconMapPin size={12} />{" "}
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
          </Box>
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}

// eslint-disable-next-line no-empty-pattern, @typescript-eslint/ban-types
function ConsTable({}: {}) {
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
    <>
      <Table>
        <Table.Tbody>
          {Array.from(monthRange(firstDate, lastDate)).map((date) => {
            const groupKey = formatDate(date, "yyyy-MM");
            return (
              <Fragment key={groupKey}>
                <Table.Tr bg="var(--mantine-color-default-hover)">
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
    </>
  );
}

export default function Index() {
  const client = useClient();

  return (
    <>
      {client.did == null ? (
        <Alert my={{ lg: "xs" }} icon={<IconPaw />} title="Welcome!">
          <Text size="sm" mb="xs">
            This the website for the{" "}
            <Anchor
              href="https://bsky.app/profile/conlabels.furryli.st"
              target="_blank"
              rel="noreferrer"
            >
              <IconBrandBluesky size={12} /> @conlabels.furryli.st
            </Anchor>{" "}
            service. For the full experience, please log in. You’ll be able to:
          </Text>
          {/* Using the List component here is wacky, so we don't use it */}
          <ul
            style={{
              marginTop: 0,
              marginBottom: "var(--mantine-spacing-xs)",
              paddingLeft: "var(--mantine-spacing-xl)",
            }}
          >
            <li>
              Tell people which cons you’re going to (you can also do this by
              liking the con post on Bluesky).
            </li>
            <li>See who you follow is going to a con.</li>
          </ul>
          <Text size="sm">
            A huge thank you to{" "}
            <Anchor
              href="https://furrycons.com"
              target="_blank"
              rel="noreferrer"
            >
              furrycons.com
            </Anchor>{" "}
            who provides all the data on conventions!
          </Text>
        </Alert>
      ) : null}
      <ConsTable />
    </>
  );
}

const MONTH_FORMAT = new Intl.DateTimeFormat("en", { month: "long" });
const WEEKDAY_FORMAT = new Intl.DateTimeFormat("en", { weekday: "short" });
