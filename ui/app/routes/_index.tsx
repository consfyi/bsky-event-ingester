import { Plural, Trans, useLingui } from "@lingui/react/macro";
import {
  Alert,
  Anchor,
  Box,
  Center,
  Group,
  Loader,
  Stack,
  Switch,
  Table,
  Text,
  ThemeIcon,
} from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import type { MetaFunction } from "@remix-run/node";
import { Link } from "@remix-run/react";
import {
  IconBrandBluesky,
  IconCalendarWeek,
  IconHeart,
  IconHeartFilled,
  IconMapPin,
  IconPaw,
  IconUsers,
} from "@tabler/icons-react";
import {
  addMonths,
  differenceInDays,
  getDay,
  getMonth,
  getYear,
  setDate,
} from "date-fns";
import { groupBy } from "lodash-es";
import { Fragment, Suspense, useMemo } from "react";
import LikeButton from "~/components/LikeButton";
import SimpleErrorBoundary from "~/components/SimpleErrorBoundary";
import { Post } from "~/endpoints";
import { Con, useConPosts, useCons, useIsLoggedIn } from "~/hooks";
import clientMetadata from "../../public/client-metadata.json";

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

function ConTableRow({ con, post }: { con: Con; post: Post }) {
  const isAttending = post.viewer?.like != null;

  const likeCountWithoutSelf = (post.likeCount || 0) - (isAttending ? 1 : 0);

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
                <LikeButton size="xs" post={post} />
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
              <Trans context="ends [date] ([duration] days)">
                ends{" "}
                {i18n.date(con.end, {
                  weekday: "short",
                  day: "numeric",
                  month: "short",
                  year:
                    getYear(con.start) != getYear(con.end)
                      ? "numeric"
                      : undefined,
                })}{" "}
                (
                <Plural
                  value={differenceInDays(con.end, con.start) + 1}
                  one="# day"
                  other="# days"
                />
                )
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

function yearMonthKey(d: Date) {
  return getYear(d) * 12 + getMonth(d);
}

function ConsTable() {
  const cons = useCons();
  const conPosts = useConPosts();

  const { i18n } = useLingui();

  const consByMonth = useMemo(() => {
    return groupBy(cons, (con) => {
      return yearMonthKey(con.start);
    });
  }, [cons]);

  const isLoggedIn = useIsLoggedIn();
  const [showOnlyAttending, setShowOnlyAttending] = useLocalStorage({
    key: "fbl:_index:showOnlyAttending",
    defaultValue: false,
  });

  return (
    <>
      {isLoggedIn ? (
        <Box
          py="xs"
          pos="sticky"
          top={51}
          h={40}
          bg="var(--mantine-color-default-hover)"
          style={{ zIndex: 3 }}
        >
          <Switch
            mx="xs"
            color="red"
            thumbIcon={
              showOnlyAttending ? (
                <IconHeartFilled size={10} color="var(--switch-bg)" />
              ) : (
                <IconHeart size={10} color="var(--switch-bg)" />
              )
            }
            checked={showOnlyAttending}
            onChange={(e) => {
              setShowOnlyAttending(e.target.checked);
            }}
            label={<Trans>Show only cons I’m attending</Trans>}
          />
          )
        </Box>
      ) : null}
      <Table>
        <Table.Tbody>
          {cons!.length > 0
            ? Array.from(
                monthRange(
                  setDate(cons![0].start, 1),
                  addMonths(setDate(cons![cons!.length - 1].start, 1), 1)
                )
              ).map((date) => {
                const groupKey = yearMonthKey(date);
                return (
                  <Fragment key={groupKey}>
                    <Table.Tr
                      bg="var(--mantine-color-default-hover)"
                      pos="sticky"
                      top={51 + (isLoggedIn ? 40 : 0)}
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
                    {(consByMonth[groupKey] ?? []).map((con) => {
                      const post = conPosts![con.rkey];

                      if (
                        isLoggedIn &&
                        showOnlyAttending &&
                        post.viewer?.like == null
                      ) {
                        return null;
                      }

                      return (
                        <ConTableRow
                          key={con.identifier}
                          con={con}
                          post={post}
                        />
                      );
                    })}
                  </Fragment>
                );
              })
            : null}
        </Table.Tbody>
      </Table>
    </>
  );
}

export default function Index() {
  const isLoggedIn = useIsLoggedIn();

  return (
    <>
      {!isLoggedIn ? (
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
                FurryCons.com
              </Anchor>{" "}
              who provides all the data on conventions!
            </Text>
          </Trans>
        </Alert>
      ) : null}
      <SimpleErrorBoundary>
        <Suspense
          fallback={
            <Center p="lg">
              <Loader />
            </Center>
          }
        >
          <ConsTable />
        </Suspense>
      </SimpleErrorBoundary>
    </>
  );
}
