import { useController, useLoading, useSuspense } from "@data-client/react";
import { plural } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Center,
  Checkbox,
  Collapse,
  Divider,
  Drawer,
  Group,
  Indicator,
  Loader,
  Menu,
  RangeSlider,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import type { MetaFunction } from "@remix-run/node";
import { Link } from "@remix-run/react";
import {
  IconAdjustmentsHorizontal,
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
  addDays,
  addMonths,
  differenceInDays,
  getDay,
  getMonth,
  getYear,
  isAfter,
  setDate,
} from "date-fns";
import { groupBy, isEqual, sortBy } from "lodash-es";
import { Fragment, Suspense, useEffect, useMemo, useState } from "react";
import Avatar from "~/components/Avatar";
import Flag from "~/components/Flag";
import LikeButton from "~/components/LikeButton";
import SimpleErrorBoundary from "~/components/SimpleErrorBoundary";
import { LABELER_DID } from "~/config";
import { Continent, getContinentForCountry } from "~/continents";
import { reinterpretAsLocalDate } from "~/date";
import { useGetPreferences, usePutPreferences } from "~/endpoints";
import {
  Con,
  useCons,
  useFollowedConAttendees,
  useFollowedConAttendeesDLE,
  useIsLoggedIn,
} from "~/hooks";
import clientMetadata from "../../public/client-metadata.json";

const MAX_AVATARS_IN_STACK = 3;

function* monthRange<DateType extends Date>(
  start: DateType,
  end: DateType
): Generator<DateType> {
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
  const { data: followedConAttendees } = useFollowedConAttendeesDLE();

  const likeCountWithoutSelf =
    (con.post.likeCount || 0) - (isAttending ? 1 : 0);

  const likeCount = likeCountWithoutSelf + (isAttending ? 1 : 0);

  const { i18n, t } = useLingui();

  const dateTimeFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.locale, {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
    [i18n.locale]
  );

  const listFormat = useMemo(
    () =>
      new Intl.ListFormat(i18n.locale, {
        type: "conjunction",
        style: "long",
      }),
    [i18n.locale]
  );

  const follows =
    followedConAttendees != null
      ? followedConAttendees[con.identifier] ?? []
      : null;

  const now = new Date();
  const active = isAfter(now, con.start) && !isAfter(now, addDays(con.end, 1));

  return (
    <Group gap="xs" wrap="nowrap" mb="sm" px="xs">
      <Anchor<typeof Link> component={Link} to={`/cons/${con.identifier}`}>
        <Indicator
          position="top-start"
          color="green"
          size={12}
          withBorder
          disabled={!active}
        >
          <ThemeIcon
            size="xl"
            variant="light"
            color={
              ["red", "orange", "yellow", "green", "blue", "indigo", "violet"][
                getDay(reinterpretAsLocalDate(con.start))
              ]
            }
          >
            <Stack gap={0}>
              <Text size="md" ta="center" fw={500}>
                {showMonthInIcon
                  ? i18n.date(reinterpretAsLocalDate(con.start), {
                      month: "short",
                    })
                  : i18n.date(reinterpretAsLocalDate(con.start), {
                      weekday: "short",
                    })}
              </Text>
              <Text size="xs" ta="center" fw={500}>
                {i18n.date(reinterpretAsLocalDate(con.start), {
                  day: "numeric",
                })}
              </Text>
            </Stack>
          </ThemeIcon>
        </Indicator>
      </Anchor>
      <Box style={{ minWidth: 0 }}>
        <Group gap={7} wrap="nowrap">
          {con.post.viewer != null ? (
            <LikeButton size="xs" post={con.post} />
          ) : null}

          <Text size="sm" truncate>
            {con.geocoded != null ? (
              <Flag
                country={con.geocoded.country ?? "XX"}
                display="inline"
                h={10}
                w={20}
                me={6}
                fit="contain"
              />
            ) : null}
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
          <IconUsers
            title={t({ message: "Attendees", context: "number of attendees" })}
            size={12}
          />{" "}
          <Trans context="attendee count">{[likeCount][0]}</Trans>{" "}
          {follows != null && follows.length > 0 ? (
            <Tooltip
              label={listFormat.format(
                follows
                  .slice(0, MAX_AVATARS_IN_STACK)
                  .map((follow) => follow.displayName ?? follow.handle ?? "")
                  .concat(
                    follows.length > MAX_AVATARS_IN_STACK
                      ? [
                          plural(follows.length - MAX_AVATARS_IN_STACK, {
                            one: "# other you follow",
                            other: "# others you follow",
                          }),
                        ]
                      : []
                  )
              )}
            >
              <Avatar.Group
                display="inline-flex"
                spacing="xs"
                style={{ verticalAlign: "bottom" }}
              >
                {follows.slice(0, MAX_AVATARS_IN_STACK).map((follow) => (
                  <Avatar
                    key={follow.did}
                    src={follow.avatar}
                    alt={`@${follow.handle}`}
                    size={22}
                  />
                ))}
                {follows.length > MAX_AVATARS_IN_STACK ? (
                  <Avatar size={22}>
                    +{follows.length - MAX_AVATARS_IN_STACK}
                  </Avatar>
                ) : null}
              </Avatar.Group>
            </Tooltip>
          ) : null}{" "}
          •{" "}
          {showMonthInIcon ? (
            <>
              <IconCalendar title={t`Date`} size={12} />{" "}
              <Trans context="[start date]-[end date] ([duration] days)">
                {dateTimeFormat.formatRange(
                  reinterpretAsLocalDate(con.start),
                  reinterpretAsLocalDate(con.end)
                )}{" "}
                (
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
                {i18n.date(reinterpretAsLocalDate(con.end), {
                  weekday: "short",
                  day: "numeric",
                  month: "short",
                  year:
                    getYear(reinterpretAsLocalDate(con.start)) !=
                    getYear(reinterpretAsLocalDate(con.end))
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
          )}
          <Text span visibleFrom="xs">
            {" "}
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
      return yearMonthKey(reinterpretAsLocalDate(con.start));
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
      setDate(reinterpretAsLocalDate(cons![0].start), 1),
      addMonths(
        setDate(reinterpretAsLocalDate(cons![cons!.length - 1].start), 1),
        1
      )
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
          mb="sm"
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

function ConsByFollowed({
  cons,
  sortDesc,
}: {
  cons: Con[];
  sortDesc: boolean;
}) {
  const followedConAttendees = useFollowedConAttendees();

  const sortedCons = useMemo(() => {
    const sorted = sortBy(cons, (con) =>
      followedConAttendees == null
        ? con.post.likeCount
        : (followedConAttendees[con.identifier] ?? []).length
    );
    if (sortDesc) {
      sorted.reverse();
    }
    return sorted;
  }, [cons, followedConAttendees, sortDesc]);

  return sortedCons.map((con) => {
    return <ConRow key={con.identifier} con={con} showMonthInIcon={true} />;
  });
}

enum SortBy {
  Date = "date",
  Attendees = "attendees",
  Followed = "followed",
}

const DEFAULT_SORT_DESC_OPTIONS = {
  [SortBy.Date]: false,
  [SortBy.Attendees]: true,
  [SortBy.Followed]: true,
};

interface TableViewOptions {
  filter: FilterOptions;
  sort: SortOptions;
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

const DEFAULT_FILTER = {
  attending: false,
  followed: false,
  continents: [
    "AF",
    "AS",
    "EU",
    "NA",
    "OC",
    "SA",
    "XX",
  ] satisfies Continent[] as Continent[],
  duration: [1, 7] satisfies [number, number],
};

type FilterOptions = typeof DEFAULT_FILTER;

const DEFAULT_SORT: SortOptions = {
  by: SortBy.Date,
  desc: false,
};

function ConsList() {
  const cons = useCons();

  const { t } = useLingui();
  const { data: followedConAttendees } = useFollowedConAttendeesDLE();

  const now = new Date();

  const isLoggedIn = useIsLoggedIn();
  const [viewOptions, setViewOptions] = useLocalStorage<TableViewOptions>({
    key: "fbl:_index:viewOptions5",
    getInitialValueInEffect: false,
    defaultValue: {
      filter: DEFAULT_FILTER,
      sort: DEFAULT_SORT,
    },
  });

  useEffect(() => {
    if (isLoggedIn) {
      return;
    }
    setViewOptions((vo) => ({
      ...vo,
      sort: {
        ...vo.sort,
        by: vo.sort.by == SortBy.Followed ? SortBy.Attendees : vo.sort.by,
      },
    }));
  }, [isLoggedIn, setViewOptions]);

  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);

  const actuallyShowOnlyAttending = isLoggedIn && viewOptions.filter.attending;
  const actuallyShowOnlyFollowed = isLoggedIn && viewOptions.filter.followed;

  const sortByStrings: Record<SortBy, SortByStrings> = {
    [SortBy.Date]: {
      name: t`Date`,
      asc: t`Soonest to latest`,
      desc: t`Latest to soonest`,
    },
    [SortBy.Attendees]: {
      name: t({ message: "Attendees", context: "number of attendees" }),
      asc: t`Fewest to most`,
      desc: t`Most to fewest`,
    },
    [SortBy.Followed]: {
      name: t`Followed attendees`,
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
          ? getContinentForCountry(con.geocoded.country ?? "XX")
          : "XX";
      counts[continent] = (counts[continent] || 0) + 1;
    }
    return counts;
  }, [cons]);

  const sortedContinents = useMemo(
    () =>
      sortBy(DEFAULT_FILTER.continents, (code) => -(continentCount[code] ?? 0)),
    [continentCount]
  );

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
  const durationFiltered = !isEqual(
    viewOptions.filter.duration,
    DEFAULT_FILTER.duration
  );

  const numFilters = [
    actuallyShowOnlyFollowed,
    actuallyShowOnlyAttending,
    !isEqual(viewOptions.filter.continents, DEFAULT_FILTER.continents),
    !isEqual(viewOptions.filter.duration, DEFAULT_FILTER.duration),
  ].reduce((acc, v) => acc + (v ? 1 : 0), 0);

  const filteredCons = cons.filter((con) => {
    const duration = differenceInDays(con.end, con.start) + 1;
    const [minDuration, tempMaxDuration] = viewOptions.filter.duration;
    const maxDuration =
      tempMaxDuration >= DEFAULT_FILTER.duration[1]
        ? Infinity
        : tempMaxDuration;

    return (
      // Exclude cons that are too late.
      !isAfter(now, addDays(con.end, 1)) &&
      // Attending filter
      (!actuallyShowOnlyAttending || con.post.viewer?.like != null) &&
      // Continents filter
      viewOptions.filter.continents.includes(
        con.geocoded != null
          ? getContinentForCountry(con.geocoded.country ?? "XX")
          : "XX"
      ) &&
      // Duration filter
      duration >= minDuration &&
      duration <= maxDuration &&
      // Followed filter
      (!actuallyShowOnlyFollowed ||
        followedConAttendees == null ||
        (followedConAttendees[con.identifier] ?? []).length > 0)
    );
  });

  return (
    <>
      <Group wrap="nowrap" m="xs" justify="space-between" gap="0">
        <Button
          size="xs"
          c="dimmed"
          color="dimmed"
          style={{ zIndex: 4, flexShrink: 0 }}
          variant="subtle"
          leftSection={<IconAdjustmentsHorizontal size={14} />}
          hiddenFrom="lg"
          onClick={() => {
            setFilterDrawerOpen(!filterDrawerOpen);
          }}
        >
          <Text span size="sm" fw={500}>
            <Trans>Filters</Trans>{" "}
            {numFilters > 0 ? <Badge ms={6}>{numFilters}</Badge> : null}
          </Text>
        </Button>
        <Group
          wrap="nowrap"
          style={{
            flexGrow: 1,
            zIndex: 4,
            overflowX: "scroll",
          }}
          p="xs"
          mx="calc(var(--mantine-spacing-xs) * -1)"
          my="calc(var(--mantine-spacing-xs) * -1)"
          me="xs"
          gap="xs"
          visibleFrom="lg"
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
          <Menu position="bottom-start" withArrow closeOnItemClick={false}>
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
            <Menu.Dropdown visibleFrom="lg">
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
              {sortedContinents.map((code) => {
                const selected = viewOptions.filter.continents.includes(code);

                return (
                  <Menu.Item
                    aria-selected={selected}
                    key={code}
                    leftSection={
                      selected ? (
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
                          continents: !selected
                            ? sortBy([...viewOptions.filter.continents, code])
                            : viewOptions.filter.continents.filter(
                                (c) => c != code
                              ),
                        },
                      });
                    }}
                  >
                    {continentStrings[code]}{" "}
                    <Text span size="xs" c="dimmed">
                      {continentCount[code] ?? 0}
                    </Text>
                  </Menu.Item>
                );
              })}
            </Menu.Dropdown>
          </Menu>
          <Menu position="bottom-start" withArrow closeOnItemClick={false}>
            <Menu.Target>
              <Button
                radius="lg"
                size="xs"
                style={{ flexShrink: 0 }}
                rightSection={<IconChevronDown size={14} />}
                {...(durationFiltered
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
                  {durationFiltered ? (
                    viewOptions.filter.duration[0] ==
                    viewOptions.filter.duration[1] ? (
                      viewOptions.filter.duration[0] >=
                      DEFAULT_FILTER.duration[1] ? (
                        <Plural
                          value={DEFAULT_FILTER.duration[1]}
                          one="# day or longer"
                          other="# days or longer"
                        />
                      ) : (
                        <Plural
                          value={viewOptions.filter.duration[0]}
                          one="# day"
                          other="# days"
                        />
                      )
                    ) : viewOptions.filter.duration[1] >=
                      DEFAULT_FILTER.duration[1] ? (
                      <Plural
                        value={viewOptions.filter.duration[0]}
                        one="# day or longer"
                        other="# days or longer"
                      />
                    ) : (
                      <Trans>
                        {viewOptions.filter.duration[0]} to{" "}
                        {viewOptions.filter.duration[1]} days
                      </Trans>
                    )
                  ) : (
                    <Trans>Duration</Trans>
                  )}
                </Text>
              </Button>
            </Menu.Target>
            <Menu.Dropdown visibleFrom="lg">
              <Box p="calc(var(--mantine-spacing-xs) / 1.5) var(--mantine-spacing-sm)">
                <RangeSlider
                  w={200}
                  min={1}
                  max={DEFAULT_FILTER.duration[1]}
                  minRange={0}
                  value={viewOptions.filter.duration}
                  onChange={(v) => {
                    setViewOptions({
                      ...viewOptions,
                      filter: { ...viewOptions.filter, duration: v },
                    });
                  }}
                  label={(value) =>
                    value < DEFAULT_FILTER.duration[1] ? (
                      <Plural value={[value][0]} one="# day" other="# days" />
                    ) : (
                      <Plural
                        value={DEFAULT_FILTER.duration[1]}
                        one="# day or longer"
                        other="# days or longer"
                      />
                    )
                  }
                  marks={[...Array(DEFAULT_FILTER.duration[1]).keys()].map(
                    (v) => ({
                      value: v + 1,
                    })
                  )}
                />
              </Box>
            </Menu.Dropdown>
          </Menu>
          {isLoggedIn ? (
            <Button
              radius="lg"
              size="xs"
              style={{ flexShrink: 0 }}
              loading={followedConAttendees == null}
              onClick={() => {
                setViewOptions({
                  ...viewOptions,
                  filter: {
                    ...viewOptions.filter,
                    followed: !viewOptions.filter.followed,
                  },
                });
              }}
              {...(actuallyShowOnlyFollowed
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
                <Trans>With followed only</Trans>
              </Text>
            </Button>
          ) : null}
        </Group>
        <Menu
          position="bottom-end"
          withArrow
          opened={sortMenuOpen}
          onChange={setSortMenuOpen}
        >
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

              if (!isLoggedIn && sortBy == SortBy.Followed) {
                return null;
              }

              const selected = viewOptions.sort.by == sortBy;

              return (
                <Menu.Item
                  disabled={
                    sortBy == SortBy.Followed && followedConAttendees == null
                  }
                  aria-selected={selected}
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
                    sortBy != SortBy.Followed ||
                    followedConAttendees != null ? (
                      selected ? (
                        <IconCheck size={14} />
                      ) : (
                        <EmptyIcon size={14} />
                      )
                    ) : (
                      <Loader color="dimmed" size={14} />
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
              aria-selected={!viewOptions.sort.desc}
              onClick={() => {
                setViewOptions((vo) => ({
                  ...vo,
                  sort: { ...vo.sort, desc: false },
                }));
              }}
              leftSection={
                <Group gap={6}>
                  {!viewOptions.sort.desc ? (
                    <IconCheck size={14} />
                  ) : (
                    <EmptyIcon size={14} />
                  )}
                  <IconSortAscending size={14} />
                </Group>
              }
            >
              {sortByStrings[viewOptions.sort.by].asc}
            </Menu.Item>
            <Menu.Item
              aria-selected={viewOptions.sort.desc}
              onClick={() => {
                setViewOptions((vo) => ({
                  ...vo,
                  sort: { ...vo.sort, desc: true },
                }));
              }}
              leftSection={
                <Group gap={6}>
                  {viewOptions.sort.desc ? (
                    <IconCheck size={14} />
                  ) : (
                    <EmptyIcon size={14} />
                  )}
                  <IconSortDescending size={14} />
                </Group>
              }
            >
              {sortByStrings[viewOptions.sort.by].desc}
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>

      <Drawer
        position="bottom"
        opened={filterDrawerOpen}
        onClose={() => {
          setFilterDrawerOpen(false);
        }}
        hiddenFrom="lg"
        title={<Trans>Filters</Trans>}
      >
        {isLoggedIn ? (
          <>
            <Checkbox
              mb="sm"
              checked={actuallyShowOnlyAttending}
              color="red"
              icon={(props) => <IconHeartFilled {...props} />}
              label={<Trans>Attending only</Trans>}
              onChange={(e) => {
                setViewOptions({
                  ...viewOptions,
                  filter: {
                    ...viewOptions.filter,
                    attending: e.target.checked,
                  },
                });
              }}
            />
            <Checkbox
              mb="sm"
              disabled={followedConAttendees == null}
              checked={actuallyShowOnlyFollowed}
              label={<Trans>With followed only</Trans>}
              onChange={(e) => {
                setViewOptions({
                  ...viewOptions,
                  filter: {
                    ...viewOptions.filter,
                    followed: e.target.checked,
                  },
                });
              }}
            />

            <Divider mb="sm" mx="calc(var(--mantine-spacing-md) * -1)" />
          </>
        ) : null}
        <Title order={2} size="h5" mb="sm">
          <Trans>Regions</Trans>
        </Title>
        <Checkbox
          mb="sm"
          checked={viewOptions.filter.continents.length > 0}
          indeterminate={
            viewOptions.filter.continents.length != 0 && continentsFiltered
          }
          onChange={(e) => {
            setViewOptions({
              ...viewOptions,
              filter: {
                ...viewOptions.filter,
                continents: e.target.checked ? DEFAULT_FILTER.continents : [],
              },
            });
          }}
          fw={500}
          label={
            <Plural
              value={viewOptions.filter.continents.length}
              one="# selected"
              other="# selected"
            />
          }
        />
        {sortedContinents.map((code) => {
          return (
            <Checkbox
              key={code}
              mb="sm"
              checked={viewOptions.filter.continents.includes(code)}
              onChange={(e) => {
                setViewOptions({
                  ...viewOptions,
                  filter: {
                    ...viewOptions.filter,
                    continents: e.target.checked
                      ? sortBy([...viewOptions.filter.continents, code])
                      : viewOptions.filter.continents.filter((c) => c != code),
                  },
                });
              }}
              label={
                <>
                  {continentStrings[code]}{" "}
                  <Text span size="xs" c="dimmed">
                    {continentCount[code] ?? 0}
                  </Text>
                </>
              }
            />
          );
        })}
        <Divider mb="sm" mx="calc(var(--mantine-spacing-md) * -1)" />
        <Title order={2} size="h5" mb="sm">
          <Trans>Duration</Trans>
        </Title>
        <RangeSlider
          w="100%"
          min={1}
          mb="sm"
          max={DEFAULT_FILTER.duration[1]}
          minRange={0}
          value={viewOptions.filter.duration}
          onChange={(v) => {
            setViewOptions({
              ...viewOptions,
              filter: { ...viewOptions.filter, duration: v },
            });
          }}
          label={(value) =>
            value < DEFAULT_FILTER.duration[1] ? (
              <Plural value={[value][0]} one="# day" other="# days" />
            ) : (
              <Plural
                value={DEFAULT_FILTER.duration[1]}
                one="# day or longer"
                other="# days or longer"
              />
            )
          }
          marks={[...Array(DEFAULT_FILTER.duration[1]).keys()].map((v) => ({
            value: v + 1,
          }))}
        />
      </Drawer>

      <Suspense
        fallback={
          <Center p="lg">
            <Loader />
          </Center>
        }
      >
        {filteredCons.length > 0 ? (
          viewOptions.sort.by == SortBy.Attendees ? (
            <ConsByAttendees
              cons={filteredCons}
              sortDesc={viewOptions.sort.desc}
            />
          ) : viewOptions.sort.by == SortBy.Followed ? (
            <ConsByFollowed
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
            <Stack ta="center" gap="xs" py="xl">
              <Text h={38} fw={500}>
                <Trans>No cons to display.</Trans>
              </Text>

              {!isEqual(viewOptions.filter, DEFAULT_FILTER) ? (
                <Box>
                  <Button
                    onClick={() => {
                      setViewOptions({
                        ...viewOptions,
                        filter: DEFAULT_FILTER,
                      });
                    }}
                  >
                    <Trans>Clear all filters</Trans>
                  </Button>
                </Box>
              ) : null}
            </Stack>
          </Box>
        )}
      </Suspense>
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
          mx={{ base: 0, lg: "xs" }}
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
