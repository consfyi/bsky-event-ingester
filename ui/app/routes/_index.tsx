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
import { Con, useCons, useIsLoggedIn } from "~/hooks";
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

function ConTableRow({ con }: { con: Con }) {
  const isAttending = con.post.viewer?.like != null;

  const likeCountWithoutSelf =
    (con.post.likeCount || 0) - (isAttending ? 1 : 0);

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
              {con.post.viewer != null ? (
                <LikeButton size="xs" post={con.post} />
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

function ConsByDate({ cons, sortDesc }: { cons: Con[]; sortDesc: boolean }) {
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
                  top={51 + 40}
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
                  return <ConTableRow key={con.identifier} con={con} />;
                })}
              </Fragment>
            );
          })
        : null}
    </Table.Tbody>
  );
}

function ConsByAttendees({
  cons,
  sortDesc,
}: {
  cons: Con[];
  sortDesc: boolean;
}) {
  const sortedCons = useMemo(() => {
    const sorted = sortBy(cons, (con) => con.post.likeCount);
    if (sortDesc) {
      sorted.reverse();
    }
    return sorted;
  }, [cons, sortDesc]);

  return (
    <Table.Tbody>
      {sortedCons.map((con) => {
        return <ConTableRow key={con.identifier} con={con} />;
      })}
    </Table.Tbody>
  );
}

enum SortBy {
  Date = "date",
  Attendees = "attendees",
}

const DEFAULT_SORT_DESC_OPTIONS = {
  [SortBy.Date]: false,
  [SortBy.Attendees]: true,
};

interface TableViewOptions {
  showOnlyAttending: boolean;
  sortBy: SortBy;
  sortDesc: boolean;
}

interface SortByStrings {
  name: string;
  asc: string;
  desc: string;
}

function ConsTable() {
  const cons = useCons();

  const { t } = useLingui();

  const isLoggedIn = useIsLoggedIn();
  const [viewOptions, setViewOptions] = useLocalStorage<TableViewOptions>({
    key: "fbl:_index:viewOptions",
    getInitialValueInEffect: false,
    defaultValue: {
      showOnlyAttending: false,
      sortBy: SortBy.Date,
      sortDesc: false,
    },
  });

  const sortByStrings: Record<SortBy, SortByStrings> = {
    [SortBy.Date]: {
      name: t`Date`,
      asc: t`Soonest to latest`,
      desc: t`Latest to soonest`,
    },
    [SortBy.Attendees]: {
      name: t`Attendees`,
      asc: t`Fewest to most`,
      desc: t`Most to fewest`,
    },
  };

  const currentSortByStrings = sortByStrings[viewOptions.sortBy];

  const filteredCons = cons.filter(
    (con) =>
      !isLoggedIn ||
      !viewOptions.showOnlyAttending ||
      con.post.viewer?.like != null
  );

  return (
    <>
      <Table
        bg="var(--mantine-color-default-hover)"
        top={51}
        h={40}
        pos="sticky"
        style={{
          zIndex: 4,
          borderBottom:
            viewOptions.sortBy != SortBy.Date
              ? "calc(0.0625rem * var(--mantine-scale)) solid var(--table-border-color)"
              : "",
        }}
      >
        <Table.Tbody>
          <Table.Tr>
            <Table.Td p={0}>
              <Group wrap="nowrap" justify="space-between" px="xs">
                {isLoggedIn ? (
                  <Switch
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
                      size="sm"
                      leftSection={
                        viewOptions.sortDesc ? (
                          <IconSortDescending
                            title={currentSortByStrings.desc}
                            size={14}
                          />
                        ) : (
                          <IconSortAscending
                            title={currentSortByStrings.asc}
                            size={14}
                          />
                        )
                      }
                      rightSection={<IconChevronDown size={14} />}
                      color="gray"
                    >
                      {currentSortByStrings.name}
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
                          {sortByStrings[sortBy].name}
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
                            <IconCheck
                              size={14}
                              style={{ marginRight: "6px" }}
                            />
                          ) : (
                            <EmptyIcon
                              size={14}
                              style={{ marginRight: "6px" }}
                            />
                          )}
                          <IconSortAscending size={14} />
                        </>
                      }
                    >
                      {sortByStrings[viewOptions.sortBy].asc}
                    </Menu.Item>
                    <Menu.Item
                      onClick={() => {
                        setViewOptions((vo) => ({ ...vo, sortDesc: true }));
                      }}
                      leftSection={
                        <>
                          {viewOptions.sortDesc ? (
                            <IconCheck
                              size={14}
                              style={{ marginRight: "6px" }}
                            />
                          ) : (
                            <EmptyIcon
                              size={14}
                              style={{ marginRight: "6px" }}
                            />
                          )}
                          <IconSortDescending size={14} />
                        </>
                      }
                    >
                      {sortByStrings[viewOptions.sortBy].desc}
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              </Group>
            </Table.Td>
          </Table.Tr>
        </Table.Tbody>
      </Table>
      <Table>
        {viewOptions.sortBy == SortBy.Attendees ? (
          <ConsByAttendees
            cons={filteredCons}
            sortDesc={viewOptions.sortDesc}
          />
        ) : viewOptions.sortBy == SortBy.Date ? (
          <ConsByDate cons={filteredCons} sortDesc={viewOptions.sortDesc} />
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
                href="https://bsky.app/profile/cons.furryli.st"
                target="_blank"
                rel="noreferrer"
              >
                <IconBrandBluesky size={12} /> @cons.furryli.st
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
