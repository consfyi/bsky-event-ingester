import { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import {
  Anchor,
  Badge,
  Box,
  Button,
  Center,
  Checkbox,
  CloseButton,
  Divider,
  Drawer,
  Group,
  Menu,
  RangeSlider,
  SegmentedControl,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import {
  Icon,
  IconAdjustmentsHorizontal,
  IconCalendarWeek,
  IconCheck,
  IconChevronDown,
  IconHeartFilled,
  IconList,
  IconMap,
  IconMinus,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import { differenceInDays } from "date-fns";
import { compareDesc, comparing, map, Range, sorted, toArray } from "iter-fns";
import { ReactNode, useCallback, useMemo, useState } from "react";
import { Link } from "react-router";
import regexpEscape from "regexp.escape";
import { Continent, CONTINENTS, getContinentForCountry } from "~/continents";
import {
  ConWithPost,
  useFollowedConAttendeesDLE,
  useIsLoggedIn,
} from "~/hooks";
import * as qp from "~/qp";
import removeDiacritics from "~/removeDiacritics";
import EmptyIcon from "./EmptyIcon";

const LAYOUTS: Record<
  string,
  {
    Icon: Icon;
    label: ReactNode;
    pathname: string;
  }
> = {
  list: {
    Icon: IconList,
    label: <Trans>List</Trans>,
    pathname: "/",
  },
  calendar: {
    Icon: IconCalendarWeek,
    label: <Trans>Calendar</Trans>,
    pathname: "/calendar",
  },
  map: {
    Icon: IconMap,
    label: <Trans>Map</Trans>,
    pathname: "/map",
  },
};

export function LayoutSwitcher({
  layoutType,
  filter,
}: {
  layoutType: keyof typeof LAYOUTS;
  filter: FilterOptions;
}) {
  return (
    <SegmentedControl
      size="xs"
      value={layoutType}
      data={Object.entries(LAYOUTS).map(([value, { label, Icon }]) => {
        const to = new URL(LAYOUTS[value].pathname, window.location.toString());
        qp.serialize(FilterOptions, filter, to.searchParams);

        return {
          value,
          label: (
            <Anchor
              style={{ color: "var(--mantine-color-text)" }}
              component={Link}
              to={to.toString()}
            >
              <Center style={{ gap: 6 }}>
                <Icon size={14} />
                <Text span size="xs" visibleFrom="sm">
                  {label}
                </Text>
              </Center>
            </Anchor>
          ),
        };
      })}
    />
  );
}

export const FilterOptions = qp.schema({
  q: qp.default_(qp.string, ""),
  attending: qp.default_(qp.boolean, false),
  followed: qp.default_(qp.boolean, false),
  continents: qp.default_(qp.array(qp.literal(CONTINENTS), " "), [
    ...CONTINENTS,
  ]),
  minDays: qp.default_(qp.int, 1),
  maxDays: qp.default_(qp.int, 7),
});
export type FilterOptions = qp.Infer<typeof FilterOptions>;
export const DEFAULT_FILTER_OPTIONS = qp.defaults(FilterOptions);

export const CONTINENT_NAMES: Record<Continent, MessageDescriptor> = {
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

export default function FilterBar({
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

export function useFilterPredicate(filter: FilterOptions) {
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
