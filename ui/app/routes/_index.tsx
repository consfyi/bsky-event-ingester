import type { PostView } from "@atcute/bluesky/types/app/feed/defs";
import { Trans, useLingui } from "@lingui/react/macro";
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
} from "@mantine/core";
import type { MetaFunction } from "@remix-run/node";
import { Link } from "@remix-run/react";
import {
  IconBrandBluesky,
  IconCalendarWeek,
  IconMapPin,
  IconPaw,
  IconUsers,
} from "@tabler/icons-react";
import {
  addMonths,
  format as formatDate,
  getDay,
  getYear,
  setDate,
} from "date-fns";
import { groupBy } from "lodash-es";
import { Fragment, useMemo } from "react";
import LikeButton from "~/components/LikeButton";
import LoadErrorAlert from "~/components/LoadErrorAlert";
import { Con, useClient, useConPosts, useCons } from "~/hooks";
import clientMetadata from "../../public/client-metadata.json";
import { useLocalAttending } from "~/components/LocalAttendingContextProvider";

function* monthRange(start: Date, end: Date): Generator<Date> {
  while (start < end) {
    yield start;
    start = addMonths(start, 1);
  }
}

export const meta: MetaFunction = ({ matches }) => [
  ...matches.flatMap((match) => match.meta ?? []),
  { title: clientMetadata.client_name },
];

function ConTableRow({ con, post }: { con: Con; post: PostView }) {
  const { isAttending } = useLocalAttending(con.identifier);

  const likeCountWithoutSelf =
    (post.likeCount || 0) - (post.viewer?.like != null ? 1 : 0);

  const { i18n, t } = useLingui();

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
                  {i18n.date(con.start, { weekday: "short" })}
                </Text>
                <Text size="xs" ta="center" fw={500}>
                  {i18n.date(con.start, { day: "numeric" })}
                </Text>
              </Stack>
            </ThemeIcon>
          </Anchor>
          <Box style={{ minWidth: 0 }}>
            <Group gap={7} wrap="nowrap">
              {post.viewer != null ? (
                <LikeButton size="xs" conId={con.identifier} />
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
              <IconUsers title={t`Attendees`} size={12} />{" "}
              {likeCountWithoutSelf + (isAttending ? 1 : 0)} •{" "}
              <IconCalendarWeek title={t`End date`} size={12} />{" "}
              <Trans>
                ends{" "}
                {i18n.date(con.end, {
                  weekday: "short",
                  day: "numeric",
                  month: "short",
                  year:
                    getYear(con.start) != getYear(con.end)
                      ? "numeric"
                      : undefined,
                })}
              </Trans>{" "}
              • <IconMapPin title={t`Location`} size={12} />{" "}
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
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}

// eslint-disable-next-line no-empty-pattern, @typescript-eslint/ban-types
function ConsTable({}: {}) {
  const { data: cons, error, isLoading } = useCons();
  const { data: conPosts, isLoading: conPostsIsLoading } = useConPosts();

  const { i18n } = useLingui();

  const consByMonth = useMemo(() => {
    if (cons == null) {
      return null;
    }

    return groupBy(cons, (con) => {
      return formatDate(con.start, "yyyy-MM");
    });
  }, [cons]);

  if (error != null) {
    return <LoadErrorAlert error={error} />;
  }

  if (isLoading || conPostsIsLoading) {
    return (
      <Center p="lg">
        <Loader />
      </Center>
    );
  }

  if (cons == null || conPosts == null || consByMonth == null) {
    return <LoadErrorAlert error={null} />;
  }

  return (
    <Table>
      <Table.Tbody>
        {cons.length > 0
          ? Array.from(
              monthRange(
                setDate(cons[0].start, 1),
                addMonths(setDate(cons[cons.length - 1].start, 1), 1)
              )
            ).map((date) => {
              const groupKey = formatDate(date, "yyyy-MM");
              return (
                <Fragment key={groupKey}>
                  <Table.Tr
                    bg="var(--mantine-color-default-hover)"
                    pos="sticky"
                    top={51}
                    style={{
                      zIndex: 3,
                      borderBottom: "none",
                    }}
                  >
                    <Table.Th p={0}>
                      <Box
                        p="var(--table-vertical-spacing) var(--table-horizontal-spacing, var(--mantine-spacing-xs))"
                        style={{
                          borderBottom:
                            "calc(0.0625rem * var(--mantine-scale)) solid var(--table-border-color)",
                        }}
                      >
                        <Text fw={500} size="md">
                          {i18n.date(date, {
                            month: "long",
                            year: "numeric",
                          })}
                        </Text>
                      </Box>
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
            })
          : null}
      </Table.Tbody>
    </Table>
  );
}

export default function Index() {
  const client = useClient();

  return (
    <>
      {client.did == null ? (
        <Alert
          my={{ lg: "xs" }}
          icon={<IconPaw />}
          title={<Trans>Welcome!</Trans>}
        >
          <Trans>
            <Text size="sm" mb="xs">
              This the website for the{" "}
              <Anchor
                href="https://bsky.app/profile/conlabels.furryli.st"
                target="_blank"
                rel="noreferrer"
              >
                <IconBrandBluesky size={12} /> @conlabels.furryli.st
              </Anchor>{" "}
              service. For the full experience, please log in. You’ll be able
              to:
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
          </Trans>
        </Alert>
      ) : null}
      <ConsTable />
    </>
  );
}
