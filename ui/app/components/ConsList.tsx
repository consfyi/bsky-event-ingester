import { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import {
  Anchor,
  Badge,
  Box,
  Button,
  Center,
  Checkbox,
  CloseButton,
  Container,
  Divider,
  Drawer,
  Group,
  Indicator,
  Loader,
  Menu,
  RangeSlider,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
  Tooltip,
} from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import {
  Icon,
  IconAdjustmentsHorizontal,
  IconCalendar,
  IconCalendarWeek,
  IconCheck,
  IconChevronDown,
  IconHeartFilled,
  IconList,
  IconMap,
  IconMapPin,
  IconMinus,
  IconSearch,
  IconSettings,
  IconSortAscendingLetters,
  IconSortAscendingNumbers,
  IconSortDescendingLetters,
  IconSortDescendingNumbers,
  IconUsers,
  IconX,
} from "@tabler/icons-react";
import {
  addMonths,
  Day,
  differenceInDays,
  getDay,
  getMonth,
  getYear,
  isAfter,
  setDate,
  subDays,
} from "date-fns";
import {
  compareDesc,
  compareMany,
  comparing,
  groupBy,
  map,
  Range,
  sample,
  sorted,
  toArray,
} from "iter-fns";
import {
  Fragment,
  lazy,
  ReactNode,
  Suspense,
  useCallback,
  useMemo,
  useState,
} from "react";
import { Link, useNavigate } from "react-router";
import regexpEscape from "regexp.escape";

import absurd from "~/absurd";
import Avatar from "~/components/Avatar";
import Flag from "~/components/Flag";
import LikeButton from "~/components/LikeButton";
import { Continent, CONTINENTS, getContinentForCountry } from "~/continents";
import { reinterpretAsLocalDate } from "~/date";
import {
  ConWithPost,
  useFollowedConAttendees,
  useFollowedConAttendeesDLE,
  useIsLoggedIn,
  useNow,
} from "~/hooks";
import * as qp from "~/qp";
import removeDiacritics from "~/removeDiacritics";
import classes from "./ConsList.module.css";

const MAX_AVATARS_IN_STACK = 3;

export function ConRow({
  con,
  showMonthInIcon,
  showEndDateOnly,
  showLocation,
  showFollowed,
  showLikeButton,
  showBigIcon,
  showDuration,
}: {
  con: ConWithPost;
  showMonthInIcon: boolean;
  showEndDateOnly: boolean;
  showLocation: boolean;
  showFollowed: boolean;
  showLikeButton: boolean;
  showBigIcon: boolean;
  showDuration: boolean;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t]
  );

  const listFormat = useMemo(
    () =>
      new Intl.ListFormat(i18n.locale, {
        type: "conjunction",
        style: "long",
      }),
    [t]
  );

  const follows = useMemo(
    () =>
      followedConAttendees != null
        ? followedConAttendees[con.identifier] ?? []
        : null,
    [followedConAttendees, con.identifier]
  );

  const sampledFollows = useMemo(
    () => (follows != null ? sample(follows, MAX_AVATARS_IN_STACK) : null),
    [follows]
  );

  const now = useNow();
  const active = isAfter(now, con.start) && !isAfter(now, con.end);
  const dateRange = dateTimeFormat.formatRange(
    reinterpretAsLocalDate(con.start),
    reinterpretAsLocalDate(subDays(con.end, 1))
  );

  return (
    <Group gap="xs" wrap="nowrap">
      {showBigIcon ? (
        <Anchor component={Link} to={`/${con.slug}`}>
          <Indicator
            position="top-start"
            color="green"
            processing
            size={12}
            withBorder
            disabled={!active}
            zIndex={2}
          >
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
                ][getDay(reinterpretAsLocalDate(con.start))]
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
      ) : null}
      <Box style={{ minWidth: 0 }}>
        <Group gap={7} wrap="nowrap">
          {showLikeButton && con.post.viewer != null ? (
            <LikeButton size="xs" post={con.post} />
          ) : null}

          <Text size="sm" truncate>
            <Flag country={con.country} size={10} me={6} />
            <Anchor fw={500} component={Link} to={`/${con.slug}`}>
              {con.name}
            </Anchor>
          </Text>
        </Group>
        <Text size="sm" truncate className={classes.itemDetails}>
          <Text span>
            <IconUsers
              title={t({
                message: "People going",
                context: "number of people going",
              })}
              size={12}
            />{" "}
            <Trans context="attendee count">{[likeCount][0]}</Trans>
            {showFollowed && follows != null && follows.length > 0 ? (
              <>
                {" "}
                <Tooltip
                  label={listFormat.format(
                    sampledFollows!
                      .map(
                        (follow) => follow.displayName ?? follow.handle ?? ""
                      )
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
                    {sampledFollows!.map((follow) => (
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
              </>
            ) : null}
          </Text>
          {!showEndDateOnly ? (
            <Text span>
              <IconCalendar title={t`Date`} size={12} />{" "}
              {showDuration ? (
                <Trans context="[start date]-[end date] ([duration] days long)">
                  {[dateRange][0]} (
                  <Plural
                    value={differenceInDays(con.end, con.start)}
                    one="# day long"
                    other="# days long"
                  />
                  )
                </Trans>
              ) : (
                dateRange
              )}
            </Text>
          ) : (
            <Text span>
              <IconCalendarWeek title={t`End date`} size={12} />{" "}
              <Trans context="until [date] ([duration] days long)">
                until{" "}
                {i18n.date(reinterpretAsLocalDate(subDays(con.end, 1)), {
                  weekday: "short",
                  day: "numeric",
                  month: "short",
                  year:
                    getYear(reinterpretAsLocalDate(con.start)) !=
                    getYear(reinterpretAsLocalDate(subDays(con.end, 1)))
                      ? "numeric"
                      : undefined,
                })}{" "}
                (
                <Plural
                  value={differenceInDays(con.end, con.start)}
                  one="# day long"
                  other="# days long"
                />
                )
              </Trans>
            </Text>
          )}
          {showLocation ? (
            <Text span visibleFrom="xs">
              <IconMapPin title={t`Location`} size={12} />{" "}
              <Anchor
                href={`https://www.google.com/maps?q=${encodeURIComponent(
                  con.address
                )}`}
                target="_blank"
                rel="noreferrer"
                c="var(--mantine-color-text)"
              >
                {con.address}
              </Anchor>
            </Text>
          ) : null}
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
  cons: ConWithPost[];
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
        groups[k]!.reverse();
      }
    }
    return groups;
  }, [cons, sortDesc]);

  const months = useMemo(() => {
    if (cons.length == 0) {
      return [];
    }
    const months = [];
    for (
      let d = setDate(reinterpretAsLocalDate(cons![0].start), 1),
        endDate = addMonths(
          setDate(reinterpretAsLocalDate(cons![cons!.length - 1].start), 1),
          1
        );
      d < endDate;
      d = addMonths(d, 1)
    ) {
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
          px={{ base: 0, lg: "xs" }}
          mt={{ base: -4, lg: -8 }}
          order={2}
          size="h5"
          fw={500}
          pos="sticky"
          top={50}
          style={{
            zIndex: 3,
            background:
              "color-mix(in srgb, var(--mantine-color-body), transparent 15%)",
            backdropFilter: "blur(5px)",
          }}
        >
          <Text
            fw={500}
            px={{ base: "xs", lg: 0 }}
            pt={{ base: 4, lg: 8 }}
            pb={4}
            style={{
              borderBottom:
                "calc(0.0625rem * var(--mantine-scale)) solid var(--mantine-color-default-border)",
            }}
          >
            {i18n.date(date, {
              month: "long",
              year: "numeric",
            })}
          </Text>
        </Title>
        <Box px="xs">
          {(consByMonth[groupKey] ?? []).map((con) => {
            return (
              <Box key={con.identifier} mb="sm">
                <ConRow
                  con={con}
                  showMonthInIcon={false}
                  showEndDateOnly
                  showLocation
                  showFollowed
                  showLikeButton
                  showBigIcon
                  showDuration
                />
              </Box>
            );
          })}
        </Box>
      </Fragment>
    );
  });
}

function ConsByAttendees({
  cons,
  sortDesc,
}: {
  cons: ConWithPost[];
  sortDesc: boolean;
}) {
  const sortedCons = useMemo(() => {
    const sortedCons = sorted(
      cons,
      comparing((con) => con.post.likeCount)
    );
    if (sortDesc) {
      sortedCons.reverse();
    }
    return sortedCons;
  }, [cons, sortDesc]);

  return <ConsBy cons={sortedCons} />;
}

function ConsByFollowed({
  cons,
  sortDesc,
}: {
  cons: ConWithPost[];
  sortDesc: boolean;
}) {
  const followedConAttendees = useFollowedConAttendees();

  const sortedCons = useMemo(() => {
    const sortedCons = sorted(
      cons,
      compareMany(
        comparing((con) =>
          followedConAttendees == null
            ? con.post.likeCount
            : (followedConAttendees[con.identifier] ?? []).length
        ),
        comparing((con) => con.post.likeCount)
      )
    );
    if (sortDesc) {
      sortedCons.reverse();
    }
    return sortedCons;
  }, [cons, followedConAttendees, sortDesc]);

  return <ConsBy cons={sortedCons} />;
}

function ConsByName({
  cons,
  sortDesc,
}: {
  cons: ConWithPost[];
  sortDesc: boolean;
}) {
  const { i18n, t } = useLingui();
  const collator = useMemo(
    () => new Intl.Collator(i18n.locale),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t]
  );

  const sortedCons = useMemo(() => {
    const sorted = cons.slice();
    sorted.sort((x, y) => collator.compare(x.name, y.name));
    if (sortDesc) {
      sorted.reverse();
    }
    return sorted;
  }, [cons, sortDesc, collator]);

  return <ConsBy cons={sortedCons} />;
}

function ConsBy({ cons }: { cons: ConWithPost[] }) {
  return (
    <Box px="xs">
      {cons.map((con) => {
        return (
          <Box key={con.identifier} mb="sm">
            <ConRow
              con={con}
              showMonthInIcon
              showEndDateOnly={false}
              showLocation
              showFollowed
              showLikeButton
              showBigIcon
              showDuration
            />
          </Box>
        );
      })}
    </Box>
  );
}

const SORT_BY = ["date", "name", "attendees", "followed"] as const;
type SortBy = (typeof SORT_BY)[number];

const DEFAULT_SORT_DESC_OPTIONS: Record<SortBy, boolean> = {
  date: false,
  name: false,
  attendees: true,
  followed: true,
};

export const FilterOptions = qp.schema({
  q: qp.scalar(qp.string, ""),
  attending: qp.scalar(qp.boolean, false),
  followed: qp.scalar(qp.boolean, false),
  continents: qp.scalar(qp.sepBy(qp.enum_(CONTINENTS), " "), [...CONTINENTS]),
  minDays: qp.scalar(qp.int, 1),
  maxDays: qp.scalar(qp.int, 7),
});
export type FilterOptions = qp.InferSchema<typeof FilterOptions>;
export const DEFAULT_FILTER_OPTIONS = qp.defaults(FilterOptions);

export const ListLayoutOptions = qp.schema({
  sort: qp.scalar(qp.enum_(SORT_BY), "date"),
  desc: qp.scalar(qp.boolean, false),
});
export type ListLayoutOptions = qp.InferSchema<typeof ListLayoutOptions>;

export const CalendarLayoutOptions = qp.schema({
  timezone: qp.scalar(qp.enum_(["theirs", "yours"]), "theirs"),
});
export type CalendarLayoutOptions = qp.InferSchema<
  typeof CalendarLayoutOptions
>;

export const MapLayoutOptions = qp.schema({
  center: qp.scalar(
    qp.tuple({ lat: qp.float, lng: qp.float, zoom: qp.float }, " ")
  ),
});
export type MapLayoutOptions = qp.InferSchema<typeof MapLayoutOptions>;

export type LayoutOptions =
  | { type: "list"; options: ListLayoutOptions }
  | { type: "calendar"; options: CalendarLayoutOptions }
  | { type: "map"; options: MapLayoutOptions };

export interface ViewOptions {
  layout: LayoutOptions;
  filter: FilterOptions;
}

const SORT_BY_DISPLAYS: Record<
  SortBy,
  {
    name: MessageDescriptor;
    asc: MessageDescriptor;
    AscIcon: Icon;
    desc: MessageDescriptor;
    DescIcon: Icon;
  }
> = {
  date: {
    name: msg`Date`,
    asc: msg`Soonest to latest`,
    AscIcon: IconSortAscendingNumbers,
    desc: msg`Latest to soonest`,
    DescIcon: IconSortDescendingNumbers,
  },
  name: {
    name: msg`Name`,
    asc: msg`A to Z`,
    AscIcon: IconSortAscendingLetters,
    desc: msg`Z to A`,
    DescIcon: IconSortDescendingLetters,
  },
  attendees: {
    name: msg({ message: `People going`, context: "number of people going" }),
    asc: msg`Fewest to most`,
    AscIcon: IconSortAscendingNumbers,
    desc: msg`Most to fewest`,
    DescIcon: IconSortDescendingNumbers,
  },
  followed: {
    name: msg`People you follow going`,
    asc: msg`Fewest to most`,
    AscIcon: IconSortAscendingNumbers,
    desc: msg`Most to fewest`,
    DescIcon: IconSortDescendingNumbers,
  },
};

const CONTINENT_NAMES: Record<Continent, MessageDescriptor> = {
  NA: msg`North America`,
  EU: msg`Europe`,
  AS: msg`Asia`,
  SA: msg`South America`,
  OC: msg`Oceania`,
  AF: msg`Africa`,
  XX: msg`Unknown`,
};

function DayText({ minDays, maxDays }: { minDays: number; maxDays: number }) {
  return (
    <Text size="sm">
      {minDays == maxDays ? (
        minDays >= DEFAULT_FILTER_OPTIONS.maxDays ? (
          <Plural
            value={DEFAULT_FILTER_OPTIONS.maxDays}
            one="# day or more"
            other="# days or more"
          />
        ) : (
          <Plural value={[minDays][0]} one="# day" other="# days" />
        )
      ) : maxDays >= DEFAULT_FILTER_OPTIONS.maxDays ? (
        <Plural
          value={[minDays][0]}
          one="# day or more"
          other="# days or more"
        />
      ) : (
        <Trans>
          {[minDays][0]} to {[maxDays][0]} days
        </Trans>
      )}
    </Text>
  );
}

function Filters({
  cons,
  filter,
  setFilter,
  rightSection,
  filledButton,
}: {
  cons: ConWithPost[];
  filter: FilterOptions;
  setFilter(filter: FilterOptions): void;
  rightSection: ReactNode;
  filledButton: boolean;
}) {
  const { t } = useLingui();
  const { data: followedConAttendees } = useFollowedConAttendeesDLE();

  const isLoggedIn = useIsLoggedIn();

  const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);

  const attendingFiltered = isLoggedIn && filter.attending;
  const followedFiltered = isLoggedIn && filter.followed;

  const continentCount = useMemo(() => {
    const counts: Partial<Record<Continent, number>> = {};
    for (const con of cons) {
      const continent = getContinentForCountry(con.country);
      counts[continent] = (counts[continent] || 0) + 1;
    }
    return counts;
  }, [cons]);

  const sortedContinents = useMemo(
    () =>
      sorted(
        [...DEFAULT_FILTER_OPTIONS.continents],
        compareDesc(comparing((code) => continentCount[code] ?? 0))
      ),
    [continentCount]
  );

  const continentsFiltered =
    filter.continents.length != DEFAULT_FILTER_OPTIONS.continents.length ||
    !filter.continents.every(
      (c, i) => DEFAULT_FILTER_OPTIONS.continents[i] == c
    );
  const durationFiltered =
    filter.minDays != DEFAULT_FILTER_OPTIONS.minDays ||
    filter.maxDays != DEFAULT_FILTER_OPTIONS.maxDays;

  const numFilters = [
    followedFiltered,
    attendingFiltered,
    continentsFiltered,
    durationFiltered,
  ].reduce((acc, v) => acc + (v ? 1 : 0), 0);

  return (
    <>
      <TextInput
        name="q"
        m="xs"
        leftSection={<IconSearch size={16} />}
        rightSection={
          <CloseButton
            icon={<IconX size={16} />}
            onClick={() => {
              setFilter({
                ...filter,
                q: "",
              });
            }}
            style={{
              display: filter.q != "" ? undefined : "none",
            }}
          />
        }
        placeholder={t`Search`}
        value={filter.q}
        onChange={(e) => {
          setFilter({
            ...filter,
            q: e.target.value,
          });
        }}
      />

      <Group wrap="nowrap" m="xs" justify="space-between" gap="0">
        <Button
          size="xs"
          c="dimmed"
          color="var(--mantine-color-dimmed)"
          style={{ zIndex: 4, flexShrink: 0 }}
          variant={filledButton ? "default" : "subtle"}
          leftSection={<IconAdjustmentsHorizontal size={14} />}
          hiddenFrom="lg"
          onClick={() => {
            setFilterDrawerOpen(!filterDrawerOpen);
          }}
        >
          <Trans>Filters</Trans>{" "}
          {numFilters > 0 ? <Badge ms={6}>{numFilters}</Badge> : null}
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
                setFilter({
                  ...filter,
                  attending: !filter.attending,
                });
              }}
              {...(attendingFiltered
                ? {
                    color: "red",
                    variant: "filled",
                  }
                : {
                    c: "dimmed",
                    color: "var(--mantine-color-dimmed)",
                    variant: "default",
                  })}
            >
              <Trans>Going only</Trans>
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
                      variant: "filled",
                    }
                  : {
                      c: "dimmed",
                      color: "var(--mantine-color-dimmed)",
                      variant: "default",
                    })}
              >
                {continentsFiltered ? (
                  filter.continents.length == 1 ? (
                    t(CONTINENT_NAMES[filter.continents[0]])
                  ) : (
                    <Plural
                      value={filter.continents.length}
                      one="# region"
                      other="# regions"
                    />
                  )
                ) : (
                  <Trans>Regions</Trans>
                )}
              </Button>
            </Menu.Target>
            <Menu.Dropdown visibleFrom="lg">
              <Menu.Item
                leftSection={
                  filter.continents.length > 0 ? (
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
                  setFilter({
                    ...filter,
                    continents: continentsFiltered
                      ? DEFAULT_FILTER_OPTIONS.continents
                      : [],
                  });
                }}
                fw="bold"
              >
                <Plural
                  value={filter.continents.length}
                  one="# selected"
                  other="# selected"
                />
              </Menu.Item>
              <Menu.Divider />
              {sortedContinents.map((code) => {
                const selected = filter.continents.includes(code);

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
                      setFilter({
                        ...filter,
                        continents: !selected
                          ? sorted([...filter.continents, code])
                          : filter.continents.filter((c) => c != code),
                      });
                    }}
                  >
                    {t(CONTINENT_NAMES[code])}{" "}
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
                      variant: "filled",
                    }
                  : {
                      c: "dimmed",
                      color: "var(--mantine-color-dimmed)",
                      variant: "default",
                    })}
              >
                {durationFiltered ? (
                  <DayText minDays={filter.minDays} maxDays={filter.maxDays} />
                ) : (
                  <Trans>Number of days</Trans>
                )}
              </Button>
            </Menu.Target>
            <Menu.Dropdown visibleFrom="lg">
              <Box p="calc(var(--mantine-spacing-xs) / 1.5) var(--mantine-spacing-sm)">
                <RangeSlider
                  w={200}
                  min={1}
                  max={DEFAULT_FILTER_OPTIONS.maxDays}
                  minRange={0}
                  value={[filter.minDays, filter.maxDays]}
                  onChange={([minDays, maxDays]) => {
                    setFilter({
                      ...filter,
                      minDays,
                      maxDays,
                    });
                  }}
                  label={(value) =>
                    value < DEFAULT_FILTER_OPTIONS.maxDays ? (
                      <Plural value={[value][0]} one="# day" other="# days" />
                    ) : (
                      <Plural
                        value={DEFAULT_FILTER_OPTIONS.maxDays}
                        one="# day or more"
                        other="# days or more"
                      />
                    )
                  }
                  marks={[...Array(DEFAULT_FILTER_OPTIONS.maxDays).keys()].map(
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
                setFilter({
                  ...filter,
                  followed: !filter.followed,
                });
              }}
              {...(followedFiltered
                ? {
                    variant: "filled",
                  }
                : {
                    c: "dimmed",
                    color: "var(--mantine-color-dimmed)",
                    variant: "default",
                  })}
            >
              <Trans>With followed only</Trans>
            </Button>
          ) : null}
        </Group>
        <Group gap="xs">{rightSection}</Group>
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
              checked={attendingFiltered}
              color="red"
              icon={(props) => <IconHeartFilled {...props} />}
              label={<Trans>Going only</Trans>}
              onChange={(e) => {
                setFilter({
                  ...filter,
                  attending: e.target.checked,
                });
              }}
            />
            <Checkbox
              mb="sm"
              disabled={followedConAttendees == null}
              checked={followedFiltered}
              label={<Trans>With followed only</Trans>}
              onChange={(e) => {
                setFilter({
                  ...filter,
                  followed: e.target.checked,
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
          checked={filter.continents.length > 0}
          indeterminate={filter.continents.length != 0 && continentsFiltered}
          onChange={(e) => {
            setFilter({
              ...filter,
              continents: e.target.checked
                ? DEFAULT_FILTER_OPTIONS.continents
                : [],
            });
          }}
          fw="bold"
          label={
            <Plural
              value={filter.continents.length}
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
              checked={filter.continents.includes(code)}
              onChange={(e) => {
                setFilter({
                  ...filter,
                  continents: e.target.checked
                    ? sorted([...filter.continents, code])
                    : filter.continents.filter((c) => c != code),
                });
              }}
              label={
                <>
                  {t(CONTINENT_NAMES[code])}{" "}
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
          <Trans>Number of days</Trans>
        </Title>
        <RangeSlider
          w="100%"
          min={1}
          mb="sm"
          max={DEFAULT_FILTER_OPTIONS.maxDays}
          minRange={0}
          value={[filter.minDays, filter.maxDays]}
          onChange={([minDays, maxDays]) => {
            setFilter({ ...filter, minDays, maxDays });
          }}
          label={(value) =>
            value < DEFAULT_FILTER_OPTIONS.maxDays ? (
              <Plural value={[value][0]} one="# day" other="# days" />
            ) : (
              <Plural
                value={DEFAULT_FILTER_OPTIONS.maxDays}
                one="# day or more"
                other="# days or more"
              />
            )
          }
          marks={toArray(
            map(
              Range.from(DEFAULT_FILTER_OPTIONS.minDays).toInclusive(
                DEFAULT_FILTER_OPTIONS.maxDays
              ),
              (value) => ({ value })
            )
          )}
        />
        <Text size="sm">
          <DayText minDays={filter.minDays} maxDays={filter.maxDays} />
        </Text>
      </Drawer>
    </>
  );
}

function ListLayout({
  cons,
  options,
  hideEmptyGroups,
}: {
  cons: ConWithPost[];
  options: ListLayoutOptions;
  hideEmptyGroups: boolean;
}) {
  return (
    <Container size="lg" px={0}>
      {options.sort == "attendees" ? (
        <ConsByAttendees cons={cons} sortDesc={options.desc} />
      ) : options.sort == "followed" ? (
        <ConsByFollowed cons={cons} sortDesc={options.desc} />
      ) : options.sort == "name" ? (
        <ConsByName cons={cons} sortDesc={options.desc} />
      ) : options.sort == "date" ? (
        <ConsByDate
          cons={cons}
          sortDesc={options.desc}
          hideEmptyGroups={hideEmptyGroups}
        />
      ) : null}
    </Container>
  );
}

function ListSettingsMenu({
  options,
  setOptions,
}: {
  options: ListLayoutOptions;
  setOptions(options: ListLayoutOptions): void;
}) {
  const { t } = useLingui();

  const isLoggedIn = useIsLoggedIn();
  const [open, setOpen] = useState(false);

  const { data: followedConAttendees } = useFollowedConAttendeesDLE();

  return (
    <Menu position="bottom-end" withArrow opened={open} onChange={setOpen}>
      <Menu.Target>
        <Button
          aria-label={t`Settings`}
          variant="subtle"
          size="xs"
          c="dimmed"
          color="var(--mantine-color-dimmed)"
          style={{ zIndex: 4, flexShrink: 0 }}
          leftSection={(() => {
            const currentSortByDisplay = SORT_BY_DISPLAYS[options.sort];
            return options.desc ? (
              <currentSortByDisplay.DescIcon
                title={t(currentSortByDisplay.desc)}
                size={14}
              />
            ) : (
              <currentSortByDisplay.AscIcon
                title={t(currentSortByDisplay.asc)}
                size={14}
              />
            );
          })()}
          rightSection={<IconChevronDown size={14} />}
        >
          {t(SORT_BY_DISPLAYS[options.sort].name)}
        </Button>
      </Menu.Target>

      <Menu.Dropdown>
        <Menu.Label>
          <Trans>Sort by</Trans>
        </Menu.Label>
        {SORT_BY.map((sortBy) => {
          if (!isLoggedIn && sortBy == "followed") {
            return null;
          }

          const selected = options.sort == sortBy;

          return (
            <Menu.Item
              disabled={sortBy == "followed" && followedConAttendees == null}
              aria-selected={selected}
              onClick={() => {
                setOptions({
                  sort: sortBy,
                  desc: DEFAULT_SORT_DESC_OPTIONS[sortBy],
                });
              }}
              key={sortBy}
              leftSection={
                sortBy != "followed" || followedConAttendees != null ? (
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
              {t(SORT_BY_DISPLAYS[sortBy].name)}
            </Menu.Item>
          );
        })}
        <Menu.Label>
          <Trans>Order</Trans>
        </Menu.Label>
        <Menu.Item
          aria-selected={!options.desc}
          onClick={() => {
            setOptions({
              ...options,
              desc: false,
            });
          }}
          leftSection={
            <Group gap={6}>
              {!options.desc ? (
                <IconCheck size={14} />
              ) : (
                <EmptyIcon size={14} />
              )}
              {(() => {
                const Icon = SORT_BY_DISPLAYS[options.sort].AscIcon;
                return <Icon size={14} />;
              })()}
            </Group>
          }
        >
          {t(SORT_BY_DISPLAYS[options.sort].asc)}
        </Menu.Item>
        <Menu.Item
          aria-selected={options.desc}
          onClick={() => {
            setOptions({
              ...options,
              desc: true,
            });
          }}
          leftSection={
            <Group gap={6}>
              {options.desc ? <IconCheck size={14} /> : <EmptyIcon size={14} />}
              {(() => {
                const Icon = SORT_BY_DISPLAYS[options.sort].DescIcon;
                return <Icon size={14} />;
              })()}
            </Group>
          }
        >
          {t(SORT_BY_DISPLAYS[options.sort].desc)}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

const DEFAULT_FIRST_DAY_OF_WEEK = (() => {
  // Use the locale of the browser rather than the set locale.
  const locale = new Intl.Locale(navigator.language);
  const weekInfo = (
    locale as {
      getWeekInfo?(): { firstDay: number };
    }
  ).getWeekInfo?.() ?? { firstDay: 7 };

  return (weekInfo.firstDay % 7) as Day;
})();

function useFirstDayOfWeek() {
  return useLocalStorage({
    key: "fbl:firstDayOfWeek",
    defaultValue: DEFAULT_FIRST_DAY_OF_WEEK,
    getInitialValueInEffect: false,
    deserialize(value) {
      if (value == undefined) {
        return DEFAULT_FIRST_DAY_OF_WEEK;
      }

      try {
        const day = JSON.parse(value);
        if (!FIRST_DAYS_OF_WEEK.includes(day)) {
          return DEFAULT_FIRST_DAY_OF_WEEK;
        }
        return day;
      } catch (e) {
        return DEFAULT_FIRST_DAY_OF_WEEK;
      }
    },
  });
}

const Calendar = lazy(() => import("./Calendar"));

function CalendarLayout({
  cons,
  options,
  includeToday,
}: {
  cons: ConWithPost[];
  options: CalendarLayoutOptions;
  includeToday: boolean;
}) {
  const [firstDayOfWeek] = useFirstDayOfWeek();
  return (
    <Container size="lg" px={0}>
      <Calendar
        firstDay={firstDayOfWeek}
        inYourTimeZone={options.timezone == "yours"}
        includeToday={includeToday}
        events={cons.map((con) => ({
          id: con.identifier,
          label: (
            <>
              <Flag country={con.country} size={8} me={4} />
              <Text span>{con.name}</Text>
            </>
          ),
          color: [
            "red",
            "orange",
            "yellow",
            "green",
            "blue",
            "indigo",
            "violet",
          ][getDay(con.start)],
          variant:
            con.post.viewer != null && con.post.viewer.like != null
              ? "filled"
              : "light",
          title: con.name,
          link: `/${con.slug}`,
          start: con.start,
          end: con.end,
        }))}
      />
    </Container>
  );
}

function CalendarSettingsMenu({
  options,
  setOptions,
}: {
  options: CalendarLayoutOptions;
  setOptions(options: CalendarLayoutOptions): void;
}) {
  const { i18n, t } = useLingui();

  const [open, setOpen] = useState(false);

  const [firstDayOfWeek, setFirstDayOfWeek] = useFirstDayOfWeek();

  return (
    <Menu position="bottom-end" withArrow opened={open} onChange={setOpen}>
      <Menu.Target>
        <Button
          aria-label={t`Settings`}
          variant="subtle"
          size="xs"
          c="dimmed"
          color="var(--mantine-color-dimmed)"
          style={{ zIndex: 4, flexShrink: 0 }}
          rightSection={<IconChevronDown size={14} />}
        >
          <IconSettings size={14} />
        </Button>
      </Menu.Target>

      <Menu.Dropdown>
        <Menu.Label>
          <Trans>Week starts on</Trans>
        </Menu.Label>
        {FIRST_DAYS_OF_WEEK.map((day) => (
          <Menu.Item
            key={day as Day}
            leftSection={
              firstDayOfWeek == day ? (
                <IconCheck size={14} />
              ) : (
                <EmptyIcon size={14} />
              )
            }
            onClick={() => {
              setFirstDayOfWeek(day as Day);
            }}
          >
            {i18n.date(new Date(2006, 0, (day as number) + 1), {
              weekday: "long",
            })}
          </Menu.Item>
        ))}
        <Menu.Label>
          <Trans>Use time zone</Trans>
        </Menu.Label>
        <Menu.Item
          leftSection={
            options.timezone == "theirs" ? (
              <IconCheck size={14} />
            ) : (
              <EmptyIcon size={14} />
            )
          }
          onClick={() => {
            setOptions({
              ...options,
              timezone: "theirs",
            });
          }}
        >
          <Trans>Theirs</Trans>
        </Menu.Item>
        <Menu.Item
          leftSection={
            options.timezone == "yours" ? (
              <IconCheck size={14} />
            ) : (
              <EmptyIcon size={14} />
            )
          }
          onClick={() => {
            setOptions({
              ...options,
              timezone: "yours",
            });
          }}
        >
          <Trans>Yours</Trans>
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

const Map = lazy(() => import("./Map"));

function MapLayout({
  cons,
  options,
  setCenter,
}: {
  cons: ConWithPost[];
  options: MapLayoutOptions;
  setCenter(center: { lat: number; lng: number; zoom: number }): void;
}) {
  const [center] = useState(options.center ?? null);
  return (
    <Box h="100dvh" mt={-50}>
      <Suspense
        fallback={
          <Center p="lg" h="100%">
            <Loader />
          </Center>
        }
      >
        <Map cons={cons} initialCenter={center} setCenter={setCenter} />
      </Suspense>
    </Box>
  );
}

const FIRST_DAYS_OF_WEEK: Day[] = [0, 1, 6];

const LAYOUTS: { Icon: Icon; label: ReactNode; options: LayoutOptions }[] = [
  {
    Icon: IconList,
    label: <Trans>List</Trans>,
    options: {
      type: "list",
      options: qp.defaults(ListLayoutOptions),
    },
  },
  {
    Icon: IconCalendarWeek,
    label: <Trans>Calendar</Trans>,
    options: {
      type: "calendar",
      options: qp.defaults(CalendarLayoutOptions),
    },
  },
  {
    Icon: IconMap,
    label: <Trans>Map</Trans>,
    options: {
      type: "map",
      options: qp.defaults(MapLayoutOptions),
    },
  },
];

function LayoutSwitcher({
  layout,
  setLayout,
}: {
  layout: LayoutOptions;
  setLayout(options: LayoutOptions): void;
}) {
  const layoutsByName = useMemo(() => {
    const layoutsByName: Partial<Record<LayoutOptions["type"], LayoutOptions>> =
      {};
    for (const layout of LAYOUTS) {
      layoutsByName[layout.options.type] = layout.options;
    }
    return layoutsByName as Record<LayoutOptions["type"], LayoutOptions>;
  }, []);
  return (
    <SegmentedControl
      size="xs"
      value={layout.type}
      onChange={(value) => {
        setLayout(layoutsByName[value as LayoutOptions["type"]]);
      }}
      data={LAYOUTS.map(({ options, label, Icon }) => ({
        value: options.type,
        label: (
          <Center style={{ gap: 6 }}>
            <Icon size={14} />
            <Text span size="xs" visibleFrom="sm">
              {label}
            </Text>
          </Center>
        ),
      }))}
    />
  );
}

function useFilterPredicate(filter: FilterOptions) {
  const { i18n, t } = useLingui();
  const { data: followedConAttendees } = useFollowedConAttendeesDLE();

  const queryRe = useMemo(
    () =>
      new RegExp(
        `^${Array.prototype.map
          .call(
            removeDiacritics(filter.q.toLocaleLowerCase(i18n.locale)),
            (c) => `${regexpEscape(c)}.*`
          )
          .join("")}`
      ),
    [t, filter]
  );

  return useCallback(
    (con: ConWithPost) => {
      const days = differenceInDays(con.end, con.start);

      return (
        // Query
        removeDiacritics(con.name.toLocaleLowerCase(i18n.locale)).match(
          queryRe
        ) != null &&
        // Attending filter
        (!filter.attending || con.post.viewer?.like != null) &&
        // Continents filter
        filter.continents.includes(getContinentForCountry(con.country)) &&
        // Duration filter
        days >= filter.minDays &&
        (filter.maxDays >= DEFAULT_FILTER_OPTIONS.maxDays ||
          days <= filter.maxDays) &&
        // Followed filter
        (!filter.followed ||
          followedConAttendees == null ||
          (followedConAttendees[con.identifier] ?? []).length > 0)
      );
    },
    [t, filter, followedConAttendees, queryRe]
  );
}

function EmptyState({
  filter,
  setFilter,
}: {
  filter: FilterOptions;
  setFilter(filter: FilterOptions): void;
}) {
  return (
    <Box px="sm">
      <Stack ta="center" gap="xs" py="xl">
        <Text h={38} fw={500}>
          <Trans>No cons to display.</Trans>
        </Text>

        {!qp.equals(FilterOptions, filter, DEFAULT_FILTER_OPTIONS) ? (
          <Box>
            <Button
              onClick={() => {
                setFilter(DEFAULT_FILTER_OPTIONS);
              }}
            >
              <Trans>Clear all filters</Trans>
            </Button>
          </Box>
        ) : null}
      </Stack>
    </Box>
  );
}

export default function ConsList({
  cons,
  view,
  setView,
}: {
  cons: ConWithPost[];
  view: ViewOptions;
  setView(view: ViewOptions): void;
}) {
  const pred = useFilterPredicate(view.filter);
  const filteredCons = cons.filter(pred);

  const compact = view.filter.attending || view.filter.q != "";
  const navigate = useNavigate();

  return (
    <Box style={{ position: "relative" }}>
      <Container
        size="lg"
        px={0}
        style={
          view.layout.type == "map"
            ? {
                left: 0,
                right: 0,
                top: 50,
                position: "absolute",
                zIndex: 1,
              }
            : {}
        }
      >
        <Filters
          cons={cons}
          filledButton={view.layout.type == "map"}
          filter={view.filter}
          setFilter={(filter) => {
            setView({ ...view, filter });
          }}
          rightSection={
            <>
              {view.layout.type == "list" ? (
                <ListSettingsMenu
                  options={view.layout.options}
                  setOptions={(options) => {
                    setView({
                      ...view,
                      layout: {
                        type: "list",
                        options,
                      },
                    });
                  }}
                />
              ) : view.layout.type == "calendar" ? (
                <CalendarSettingsMenu
                  options={view.layout.options}
                  setOptions={(options) => {
                    setView({
                      ...view,
                      layout: {
                        type: "calendar",
                        options,
                      },
                    });
                  }}
                />
              ) : null}
              <LayoutSwitcher
                layout={view.layout}
                setLayout={(layout) => {
                  const searchParams = new URLSearchParams();

                  qp.serialize(FilterOptions, view.filter, searchParams);
                  switch (layout.type) {
                    case "calendar":
                      qp.serialize(
                        CalendarLayoutOptions,
                        layout.options,
                        searchParams
                      );
                      break;
                    case "list":
                      qp.serialize(
                        ListLayoutOptions,
                        layout.options,
                        searchParams
                      );
                      break;
                    case "map":
                      qp.serialize(
                        MapLayoutOptions,
                        layout.options,
                        searchParams
                      );
                      break;
                  }

                  const pathname =
                    layout.type == "calendar"
                      ? "/calendar"
                      : layout.type == "map"
                      ? "/map"
                      : layout.type == "list"
                      ? "/"
                      : absurd<string>(layout);

                  navigate({ pathname, search: searchParams.toString() });
                }}
              />
            </>
          }
        />
      </Container>

      <Suspense
        fallback={
          <Center p="lg">
            <Loader />
          </Center>
        }
      >
        {filteredCons.length > 0 || view.layout.type == "map" ? (
          view.layout.type == "calendar" ? (
            <CalendarLayout
              cons={filteredCons}
              options={view.layout.options}
              includeToday={!compact}
            />
          ) : view.layout.type == "map" ? (
            <MapLayout
              cons={filteredCons}
              options={view.layout.options}
              setCenter={(center) => {
                setView({
                  ...view,
                  layout: {
                    ...view.layout,
                    type: "map",
                    options: {
                      center,
                    } satisfies MapLayoutOptions,
                  },
                });
              }}
            />
          ) : view.layout.type == "list" ? (
            <ListLayout
              cons={filteredCons}
              options={view.layout.options}
              hideEmptyGroups={compact}
            />
          ) : (
            absurd(view.layout)
          )
        ) : (
          <EmptyState
            filter={view.filter}
            setFilter={(filter) => {
              setView({ ...view, filter });
            }}
          />
        )}
      </Suspense>
    </Box>
  );
}
