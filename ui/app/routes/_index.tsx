import { useController, useLoading, useSuspense } from "@data-client/react";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import {
  Alert,
  Anchor,
  Box,
  Button,
  Center,
  Collapse,
  Group,
  Loader,
  Menu,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import type { MetaFunction } from "@remix-run/node";
import { Link } from "@remix-run/react";
import {
  IconAlertTriangle,
  IconBrandBluesky,
  IconCalendar,
  IconCalendarWeek,
  IconCheck,
  IconChevronDown,
  IconHeartFilled,
  IconMapPin,
  IconMinus,
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
import { groupBy, isEqual, sortBy } from "lodash-es";
import { Fragment, Suspense, useMemo } from "react";
import LikeButton from "~/components/LikeButton";
import SimpleErrorBoundary from "~/components/SimpleErrorBoundary";
import { LABELER_DID } from "~/config";
import { Continent, getContinentForCountry } from "~/continents";
import { useGetPreferences, usePutPreferences } from "~/endpoints";
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

function ConRow({
  con,
  showMonthInIcon,
}: {
  con: Con;
  showMonthInIcon: boolean;
}) {
  const isAttending = con.post.viewer?.like != null;

  const likeCountWithoutSelf =
    (con.post.likeCount || 0) - (isAttending ? 1 : 0);

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
    <Group gap="xs" wrap="nowrap" mb="xs" px="xs">
      <Anchor<typeof Link> component={Link} to={`/cons/${con.identifier}`}>
        <ThemeIcon
          size="xl"
          variant="light"
          color={
            ["red", "orange", "yellow", "green", "blue", "indigo", "violet"][
              getDay(con.start)
            ]
          }
        >
          <Stack gap={0}>
            <Text size="md" ta="center" fw={500}>
              {showMonthInIcon
                ? i18n.date(con.start, { month: "short" })
                : i18n.date(con.start, { weekday: "short" })}
            </Text>
            <Text size="xs" ta="center" fw={500}>
              {i18n.date(con.start, {
                day: "numeric",
              })}
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
          {showMonthInIcon ? (
            <>
              <IconCalendar title={t`Date`} size={12} />{" "}
              <Trans context="[start date]-[end date] ([duration] days)">
                {dateTimeFormat.formatRange(con.start, con.end)} (
                <Plural
                  value={differenceInDays(con.end, con.start) + 1}
                  one="# day"
                  other="# days"
                />
                )
              </Trans>
            </>
          ) : (
            <>
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
              </Trans>
            </>
          )}{" "}
          • <IconMapPin title={t`Location`} size={12} />{" "}
          <Anchor
            href={`https://www.google.com/maps?q=${con.location}`}
            target="_blank"
            rel="noreferrer"
            c="var(--mantine-color-text)"
          >
            {con.location}
          </Anchor>
        </Text>
      </Box>
    </Group>
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
  hideEmptyGroups,
  sortDesc,
}: {
  cons: Con[];
  hideEmptyGroups: boolean;
  sortDesc: boolean;
}) {
  const { i18n } = useLingui();

  const consByMonth = useMemo(() => {
    const groups = groupBy(cons, (con) => {
      return yearMonthKey(con.start);
    });
    if (sortDesc) {
      for (const k in groups) {
        groups[k].reverse();
      }
    }
    return groups;
  }, [cons, sortDesc]);

  const months = useMemo(() => {
    if (cons.length == 0) {
      return [];
    }
    const months = [];
    for (const d of monthRange(
      setDate(cons![0].start, 1),
      addMonths(setDate(cons![cons!.length - 1].start, 1), 1)
    )) {
      if (hideEmptyGroups && (consByMonth[yearMonthKey(d)] ?? []).length == 0) {
        continue;
      }
      months.push(d);
    }

    if (sortDesc) {
      months.reverse();
    }
    return months;
  }, [cons, hideEmptyGroups, consByMonth, sortDesc]);

  return months.map((date) => {
    const groupKey = yearMonthKey(date);
    return (
      <Fragment key={groupKey}>
        <Title
          mb="xs"
          mx={{ base: 0, lg: "xs" }}
          px={{ base: "xs", lg: 0 }}
          mt={{ base: -4, lg: -8 }}
          pt={{ base: 4, lg: 8 }}
          pb={4}
          order={2}
          size="h5"
          fw={500}
          pos="sticky"
          top={50}
          bg="var(--mantine-color-body)"
          style={{
            zIndex: 3,
            borderBottom:
              "calc(0.0625rem * var(--mantine-scale)) solid var(--mantine-color-default-border)",
          }}
        >
          {i18n.date(date, {
            month: "long",
            year: "numeric",
          })}
        </Title>
        {(consByMonth[groupKey] ?? []).map((con) => {
          return (
            <ConRow key={con.identifier} con={con} showMonthInIcon={false} />
          );
        })}
      </Fragment>
    );
  });
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

  return sortedCons.map((con) => {
    return <ConRow key={con.identifier} con={con} showMonthInIcon={true} />;
  });
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
  filter: FilterOptions;
  sort: SortOptions;
}

interface FilterOptions {
  attending: boolean;
  continents: Continent[];
}

interface SortOptions {
  by: SortBy;
  desc: boolean;
}

interface SortByStrings {
  name: string;
  asc: string;
  desc: string;
}

const DEFAULT_FILTER: FilterOptions = {
  attending: false,
  continents: ["AF", "AS", "EU", "NA", "OC", "SA", "XX"],
};

const DEFAULT_SORT: SortOptions = {
  by: SortBy.Date,
  desc: false,
};

function ConsList() {
  const cons = useCons();

  const { t } = useLingui();

  const isLoggedIn = useIsLoggedIn();
  const [viewOptions, setViewOptions] = useLocalStorage<TableViewOptions>({
    key: "fbl:_index:viewOptions3",
    getInitialValueInEffect: false,
    defaultValue: {
      filter: DEFAULT_FILTER,
      sort: DEFAULT_SORT,
    },
  });

  const actuallyShowOnlyAttending = isLoggedIn && viewOptions.filter.attending;

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

  const currentSortByStrings = sortByStrings[viewOptions.sort.by];

  const continentCount = useMemo(() => {
    const counts: Partial<Record<Continent, number>> = {};
    for (const con of cons) {
      const continent =
        con.geocoded != null
          ? getContinentForCountry(con.geocoded.country)
          : "XX";
      counts[continent] = (counts[continent] || 0) + 1;
    }
    return counts;
  }, [cons]);

  const continentStrings: Record<Continent, string> = {
    NA: t`North America`,
    EU: t`Europe`,
    AN: t`Antarctica`,
    AS: t`Asia`,
    SA: t`South America`,
    OC: t`Oceania`,
    AF: t`Africa`,
    XX: t`Unknown`,
  };

  const continentsFiltered = !isEqual(
    viewOptions.filter.continents,
    DEFAULT_FILTER.continents
  );

  const filteredCons = cons.filter(
    (con) =>
      // Attending filter
      (!actuallyShowOnlyAttending || con.post.viewer?.like != null) &&
      // Continents filter
      viewOptions.filter.continents.includes(
        con.geocoded != null
          ? getContinentForCountry(con.geocoded.country)
          : "XX"
      )
  );

  return (
    <>
      <Group wrap="nowrap" my="xs" justify="space-between" gap="0">
        <Group
          wrap="nowrap"
          style={{
            flexGrow: 1,
            zIndex: 4,
            overflowX: "scroll",
          }}
          ml="xs"
          gap="xs"
        >
          {isLoggedIn ? (
            <Button
              radius="lg"
              size="xs"
              style={{ flexShrink: 0 }}
              onClick={() => {
                setViewOptions({
                  ...viewOptions,
                  filter: {
                    ...viewOptions.filter,
                    attending: !viewOptions.filter.attending,
                  },
                });
              }}
              {...(actuallyShowOnlyAttending
                ? {
                    color: "red",
                    variant: "light",
                    leftSection: <IconHeartFilled size={14} />,
                  }
                : {
                    c: "dimmed",
                    color: "var(--mantine-color-dimmed)",
                    variant: "outline",
                  })}
            >
              <Text span size="sm" fw={500}>
                <Trans>Attending only</Trans>
              </Text>
            </Button>
          ) : null}
          <Menu
            position="bottom-start"
            withArrow
            withinPortal={false}
            closeOnItemClick={false}
          >
            <Menu.Target>
              <Button
                radius="lg"
                size="xs"
                style={{ flexShrink: 0 }}
                rightSection={<IconChevronDown size={14} />}
                {...(continentsFiltered
                  ? {
                      variant: "light",
                    }
                  : {
                      c: "dimmed",
                      color: "var(--mantine-color-dimmed)",
                      variant: "outline",
                    })}
              >
                <Text span size="sm" fw={500}>
                  {continentsFiltered ? (
                    viewOptions.filter.continents.length == 1 ? (
                      continentStrings[viewOptions.filter.continents[0]]
                    ) : (
                      <Plural
                        value={viewOptions.filter.continents.length}
                        one="# region"
                        other="# regions"
                      />
                    )
                  ) : (
                    <Trans>Regions</Trans>
                  )}
                </Text>
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                leftSection={
                  viewOptions.filter.continents.length > 0 ? (
                    continentsFiltered ? (
                      <IconMinus size={14} />
                    ) : (
                      <IconCheck size={14} />
                    )
                  ) : (
                    <EmptyIcon size={14} />
                  )
                }
                onClick={() => {
                  setViewOptions({
                    ...viewOptions,
                    filter: {
                      ...viewOptions.filter,
                      continents: continentsFiltered
                        ? DEFAULT_FILTER.continents
                        : [],
                    },
                  });
                }}
                fw={500}
              >
                <Plural
                  value={viewOptions.filter.continents.length}
                  one="# selected"
                  other="# selected"
                />
              </Menu.Item>
              <Menu.Divider />
              {sortBy(
                DEFAULT_FILTER.continents,
                (code) => -(continentCount[code] ?? 0)
              ).map((code) => (
                <Menu.Item
                  key={code}
                  leftSection={
                    viewOptions.filter.continents.includes(code) ? (
                      <IconCheck size={14} />
                    ) : (
                      <EmptyIcon size={14} />
                    )
                  }
                  onClick={() => {
                    setViewOptions({
                      ...viewOptions,
                      filter: {
                        ...viewOptions.filter,
                        continents: !viewOptions.filter.continents.includes(
                          code
                        )
                          ? sortBy([...viewOptions.filter.continents, code])
                          : viewOptions.filter.continents.filter(
                              (c) => c != code
                            ),
                      },
                    });
                  }}
                >
                  {continentStrings[code]}{" "}
                  <Text span size="xs" color="dimmed">
                    {continentCount[code] ?? 0}
                  </Text>
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
        </Group>
        <Menu position="bottom-end" withArrow withinPortal={false}>
          <Menu.Target>
            <Button
              variant="subtle"
              size="xs"
              c="dimmed"
              color="dimmed"
              style={{ zIndex: 4, flexShrink: 0 }}
              leftSection={
                viewOptions.sort.desc ? (
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
            >
              <Text span size="sm" fw={500}>
                {currentSortByStrings.name}
              </Text>
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
                      sort: {
                        by: sortBy,
                        desc: DEFAULT_SORT_DESC_OPTIONS[sortBy],
                      },
                    }));
                  }}
                  key={k}
                  leftSection={
                    viewOptions.sort.by == sortBy ? (
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
                setViewOptions((vo) => ({
                  ...vo,
                  sort: { ...vo.sort, desc: false },
                }));
              }}
              leftSection={
                <>
                  {!viewOptions.sort.desc ? (
                    <IconCheck size={14} style={{ marginRight: "6px" }} />
                  ) : (
                    <EmptyIcon size={14} style={{ marginRight: "6px" }} />
                  )}
                  <IconSortAscending size={14} />
                </>
              }
            >
              {sortByStrings[viewOptions.sort.by].asc}
            </Menu.Item>
            <Menu.Item
              onClick={() => {
                setViewOptions((vo) => ({
                  ...vo,
                  sort: { ...vo.sort, desc: true },
                }));
              }}
              leftSection={
                <>
                  {viewOptions.sort.desc ? (
                    <IconCheck size={14} style={{ marginRight: "6px" }} />
                  ) : (
                    <EmptyIcon size={14} style={{ marginRight: "6px" }} />
                  )}
                  <IconSortDescending size={14} />
                </>
              }
            >
              {sortByStrings[viewOptions.sort.by].desc}
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>

      {filteredCons.length > 0 ? (
        viewOptions.sort.by == SortBy.Attendees ? (
          <ConsByAttendees
            cons={filteredCons}
            sortDesc={viewOptions.sort.desc}
          />
        ) : viewOptions.sort.by == SortBy.Date ? (
          <ConsByDate
            cons={filteredCons}
            sortDesc={viewOptions.sort.desc}
            hideEmptyGroups={actuallyShowOnlyAttending}
          />
        ) : null
      ) : (
        <Box px="sm">
          <Stack ta="center" gap="xs" py="lg">
            <Text h={38} pt={4} fw={500}>
              <Trans>No cons to display.</Trans>
            </Text>

            {!isEqual(viewOptions.filter, DEFAULT_FILTER) ? (
              <Box>
                <Button
                  onClick={() => {
                    setViewOptions({ ...viewOptions, filter: DEFAULT_FILTER });
                  }}
                >
                  <Trans>Clear all filters</Trans>
                </Button>
              </Box>
            ) : null}
          </Stack>
        </Box>
      )}
    </>
  );
}

export default function Index() {
  const isLoggedIn = useIsLoggedIn();

  const getPreferences = useGetPreferences();
  const preferences = useSuspense(getPreferences);

  const putPreferences = usePutPreferences();
  const ctrl = useController();

  const [doSubscribe, loading] = useLoading(async () => {
    // Refetch preferences, just so we don't clobber any preferences that may have changed in the meantime with our old preferences.
    const prefs = (await ctrl.fetch(getPreferences)).preferences!;

    let labelersPref = prefs.find(
      (pref) => pref.$type == "app.bsky.actor.defs#labelersPref"
    );
    if (labelersPref == null) {
      labelersPref = {
        $type: "app.bsky.actor.defs#labelersPref",
        labelers: [],
      };
      prefs.push(labelersPref);
    }
    labelersPref.labelers.push({ did: LABELER_DID });

    await ctrl.fetch(putPreferences, { preferences: prefs });
  }, [ctrl, preferences, putPreferences]);

  const subscribedToLabeler =
    preferences.preferences == null ||
    preferences.preferences.some(
      (preference) =>
        preference.$type == "app.bsky.actor.defs#labelersPref" &&
        preference.labelers.some((labeler) => labeler.did == LABELER_DID)
    );

  return (
    <>
      {!isLoggedIn ? (
        <Alert
          mt={{ lg: "xs" }}
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
            <Text size="sm" mb="xs">
              <strong>Note:</strong> If you’re using a self-hosted PDS, you’ll
              need to use the dropdown next to the Log in button to specify it.
            </Text>
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
      <Collapse in={!subscribedToLabeler}>
        <Alert
          my={{ lg: "xs" }}
          icon={<IconAlertTriangle />}
          title={<Trans>Not subscribed to labeler</Trans>}
          color="yellow"
        >
          <Text size="sm" mb="xs">
            <Trans>
              You are currently not subscribed to the labeler. That means you
              won’t be able to see other people’s con labels on Bluesky.
            </Trans>
          </Text>
          <Button
            size="sm"
            color="yellow"
            loading={loading}
            onClick={() => {
              doSubscribe();
            }}
          >
            <Trans>Fix this for me</Trans>
          </Button>
        </Alert>
      </Collapse>
      <SimpleErrorBoundary>
        <Suspense
          fallback={
            <Center p="lg">
              <Loader />
            </Center>
          }
        >
          <ConsList />
        </Suspense>
      </SimpleErrorBoundary>
    </>
  );
}
