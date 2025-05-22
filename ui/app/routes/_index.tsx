import { Plural, Trans, useLingui } from "@lingui/react/macro";
import {
  Alert,
  Anchor,
  Box,
  Button,
  Center,
  Group,
  Loader,
  Menu,
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
  IconCheck,
  IconChevronDown,
  IconHeart,
  IconHeartFilled,
  IconMapPin,
  IconPaw,
  IconSortAscending,
  IconSortDescending,
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
import { groupBy, sortBy } from "lodash-es";
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

function EmptyIcon({
  size,
  ...svgProps
}: { size?: number | string } & React.ComponentPropsWithoutRef<"svg">) {
  return <svg {...svgProps} width={size} height={size}></svg>;
}

function ConsByDate({
  cons,
  conPosts,
  sortDesc,
}: {
  cons: Con[];
  conPosts: Record<string, Post>;
  sortDesc: boolean;
}) {
  const { i18n } = useLingui();

  const consByMonth = useMemo(() => {
    return groupBy(cons, (con) => {
      return yearMonthKey(con.start);
    });
  }, [cons]);

  const months = useMemo(() => {
    const months = Array.from(
      monthRange(
        setDate(cons![0].start, 1),
        addMonths(setDate(cons![cons!.length - 1].start, 1), 1)
      )
    );
    if (sortDesc) {
      months.reverse();
    }
    return months;
  }, [cons, sortDesc]);

  return (
    <Table.Tbody>
      {cons!.length > 0
        ? months.map((date) => {
            const groupKey = yearMonthKey(date);
            return (
              <Fragment key={groupKey}>
                <Table.Tr
                  bg="var(--mantine-color-default-hover)"
                  pos="sticky"
                  top={51 + 50}
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
                  const post = conPosts[con.rkey];

                  return (
                    <ConTableRow key={con.identifier} con={con} post={post} />
                  );
                })}
              </Fragment>
            );
          })
        : null}
    </Table.Tbody>
  );
}

function ConsByAttending({
  cons,
  conPosts,
  sortDesc,
}: {
  cons: Con[];
  conPosts: Record<string, Post>;
  sortDesc: boolean;
}) {
  const sortedCons = useMemo(() => {
    const sorted = sortBy(cons, (con) => conPosts[con.rkey].likeCount);
    if (sortDesc) {
      sorted.reverse();
    }
    return sorted;
  }, [cons, conPosts, sortDesc]);

  return (
    <Table.Tbody>
      {sortedCons.map((con) => {
        const post = conPosts[con.rkey];

        return <ConTableRow key={con.identifier} con={con} post={post} />;
      })}
    </Table.Tbody>
  );
}

enum SortBy {
  Date = "date",
  Attending = "attending",
}

const DEFAULT_SORT_DESC_OPTIONS = {
  [SortBy.Date]: false,
  [SortBy.Attending]: true,
};

interface TableViewOptions {
  showOnlyAttending: boolean;
  sortBy: SortBy;
  sortDesc: boolean;
}

function ConsTable() {
  const cons = useCons();
  const conPosts = useConPosts();

  const { t } = useLingui();

  const isLoggedIn = useIsLoggedIn();
  const [viewOptions, setViewOptions] = useLocalStorage<TableViewOptions>({
    key: "fbl:_index:viewOptions",
    defaultValue: {
      showOnlyAttending: false,
      sortBy: SortBy.Date,
      sortDesc: false,
    },
  });

  const sortByNames: Record<SortBy, string> = {
    date: t`Date`,
    attending: t`Attending`,
  };

  const filteredCons = cons.filter(
    (con) =>
      !isLoggedIn ||
      !viewOptions.showOnlyAttending ||
      conPosts[con.rkey]!.viewer?.like != null
  );

  return (
    <>
      <Group
        p="xs"
        wrap="nowrap"
        justify="space-between"
        pos="sticky"
        top={51}
        h={50}
        bg="var(--mantine-color-default-hover)"
        style={{ zIndex: 4 }}
      >
        {isLoggedIn ? (
          <Switch
            mx="xs"
            color="red"
            thumbIcon={
              viewOptions.showOnlyAttending ? (
                <IconHeartFilled size={10} color="var(--switch-bg)" />
              ) : (
                <IconHeart size={10} color="var(--switch-bg)" />
              )
            }
            checked={viewOptions.showOnlyAttending}
            onChange={(e) => {
              setViewOptions((vo) => ({
                ...vo,
                showOnlyAttending: e.target.checked,
              }));
            }}
            label={<Trans>Show only cons I’m attending</Trans>}
          />
        ) : (
          <div></div>
        )}
        <Menu position="bottom-end" withArrow withinPortal={false}>
          <Menu.Target>
            <Button
              variant="subtle"
              size="xs"
              style={{ alignSelf: "flex-end" }}
              leftSection={
                viewOptions.sortDesc ? (
                  <IconSortDescending title={`Descending`} size={14} />
                ) : (
                  <IconSortAscending title={t`Ascending`} size={14} />
                )
              }
              rightSection={<IconChevronDown size={14} />}
              color="gray"
            >
              {sortByNames[viewOptions.sortBy]}
            </Button>
          </Menu.Target>

          <Menu.Dropdown>
            <Menu.Label>
              <Trans>Sort by</Trans>
            </Menu.Label>
            {Object.keys(SortBy).map((k) => {
              const sortBy = SortBy[k as keyof typeof SortBy];

              return (
                <Menu.Item
                  onClick={() => {
                    setViewOptions((vo) => ({
                      ...vo,
                      sortBy,
                      sortDesc: DEFAULT_SORT_DESC_OPTIONS[sortBy],
                    }));
                  }}
                  key={k}
                  leftSection={
                    viewOptions.sortBy == sortBy ? (
                      <IconCheck size={14} />
                    ) : (
                      <EmptyIcon size={14} />
                    )
                  }
                >
                  {sortByNames[sortBy]}
                </Menu.Item>
              );
            })}
            <Menu.Label>
              <Trans>Order</Trans>
            </Menu.Label>
            <Menu.Item
              onClick={() => {
                setViewOptions((vo) => ({ ...vo, sortDesc: false }));
              }}
              leftSection={
                <>
                  {!viewOptions.sortDesc ? (
                    <IconCheck size={14} style={{ marginRight: "6px" }} />
                  ) : (
                    <EmptyIcon size={14} style={{ marginRight: "6px" }} />
                  )}
                  <IconSortAscending size={14} />
                </>
              }
            >
              {viewOptions.sortBy == SortBy.Date ? (
                <Trans>Soonest</Trans>
              ) : (
                <Trans>Fewest</Trans>
              )}
            </Menu.Item>
            <Menu.Item
              onClick={() => {
                setViewOptions((vo) => ({ ...vo, sortDesc: true }));
              }}
              leftSection={
                <>
                  {viewOptions.sortDesc ? (
                    <IconCheck size={14} style={{ marginRight: "6px" }} />
                  ) : (
                    <EmptyIcon size={14} style={{ marginRight: "6px" }} />
                  )}
                  <IconSortDescending size={14} />
                </>
              }
            >
              {viewOptions.sortBy == SortBy.Date ? (
                <Trans>Latest</Trans>
              ) : (
                <Trans>Most</Trans>
              )}
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>
      <Table>
        {viewOptions.sortBy == SortBy.Attending ? (
          <ConsByAttending
            cons={filteredCons}
            conPosts={conPosts}
            sortDesc={viewOptions.sortDesc}
          />
        ) : viewOptions.sortBy == SortBy.Date ? (
          <ConsByDate
            cons={filteredCons}
            conPosts={conPosts}
            sortDesc={viewOptions.sortDesc}
          />
        ) : null}
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
