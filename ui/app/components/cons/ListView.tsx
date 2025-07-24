import { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  Box,
  Button,
  Center,
  Container,
  Group,
  Loader,
  Menu,
  Text,
  Title,
} from "@mantine/core";
import {
  Icon,
  IconCheck,
  IconChevronDown,
  IconSortAscendingLetters,
  IconSortAscendingNumbers,
  IconSortDescendingLetters,
  IconSortDescendingNumbers,
} from "@tabler/icons-react";
import { addMonths, getMonth, getYear, setDate } from "date-fns";
import { compareMany, comparing, groupBy, sorted } from "iter-fns";
import { ReactNode, Suspense, useMemo, useState } from "react";
import absurd from "~/absurd";
import { reinterpretAsLocalDate } from "~/date";
import {
  ConWithPost,
  useFollowedConAttendees,
  useFollowedConAttendeesDLE,
  useIsLoggedIn,
} from "~/hooks";
import * as qp from "~/qp";
import ConRow from "../ConRow";
import EmptyIcon from "../EmptyIcon";
import EmptyState from "../EmptyState";
import FilterBar, {
  FilterOptions,
  LayoutSwitcher,
  useFilterPredicate,
} from "../FilterBar";

function yearMonthKey(d: Date) {
  return getYear(d) * 12 + getMonth(d);
}

function FlatList({
  title,
  cons,
  sortDesc,
  density,
}: {
  title: ReactNode | null;
  cons: ConWithPost[];
  sortDesc: boolean;
  density: Density;
}) {
  const sortedCons = useMemo(() => {
    const sortedCons = cons.slice();
    if (sortDesc) {
      sortedCons.reverse();
    }
    return sortedCons;
  }, [cons, sortDesc]);

  return (
    <>
      {title != null ? (
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
            {title}
          </Text>
        </Title>
      ) : null}
      <Box px="xs">
        {sortedCons.map((con) => {
          return (
            <Box key={con.identifier} mb={density == "compact" ? "xs" : "sm"}>
              <ConRow
                con={con}
                showMonthInIcon={false}
                showEndDateOnly
                showLocation="inline"
                showFollowed
                showLikeButton
                density={density}
                showDuration
                withId
              />
            </Box>
          );
        })}
      </Box>
    </>
  );
}

function GroupedList({
  groups,
  hideEmptyGroups,
  sortDesc,
  density,
}: {
  groups: { key: string; title: ReactNode; cons: ConWithPost[] }[];
  hideEmptyGroups: boolean;
  sortDesc: boolean;
  density: Density;
}) {
  const sortedGroups = useMemo(() => {
    const sortedGroups = groups.slice();
    if (sortDesc) {
      sortedGroups.reverse();
    }
    return sortedGroups;
  }, [groups, sortDesc]);

  return sortedGroups.flatMap(({ key, title, cons }) => {
    return !hideEmptyGroups || cons.length > 0
      ? [
          <FlatList
            cons={cons}
            key={key}
            title={title}
            sortDesc={sortDesc}
            density={density}
          />,
        ]
      : [];
  });
}

function ConsByDate({
  cons,
  hideEmptyGroups,
  sortDesc,
  density,
}: {
  cons: ConWithPost[];
  hideEmptyGroups: boolean;
  sortDesc: boolean;
  density: Density;
}) {
  const { i18n, t } = useLingui();

  const groups = useMemo(
    () => {
      if (cons.length == 0) {
        return [];
      }

      const grouped = groupBy(cons, (con) => {
        return yearMonthKey(reinterpretAsLocalDate(con.start));
      });

      const groups = [];
      for (
        let d = setDate(reinterpretAsLocalDate(cons![0].start), 1),
          endDate = addMonths(
            setDate(reinterpretAsLocalDate(cons![cons!.length - 1].start), 1),
            1
          );
        d < endDate;
        d = addMonths(d, 1)
      ) {
        const key = yearMonthKey(d);
        groups.push({
          key: key.toString(),
          cons: grouped[key] ?? [],
          title: (
            <>
              {i18n.date(d, {
                month: "long",
                year: "numeric",
              })}
            </>
          ),
        });
      }
      return groups;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cons, t]
  );

  return (
    <GroupedList
      groups={groups}
      hideEmptyGroups={hideEmptyGroups}
      sortDesc={sortDesc}
      density={density}
    />
  );
}

function ConsByAttendees({
  cons,
  sortDesc,
  density,
}: {
  cons: ConWithPost[];
  sortDesc: boolean;
  density: Density;
}) {
  const sortedCons = useMemo(
    () =>
      sorted(
        cons,
        comparing((con) => con.post.likeCount)
      ),
    [cons]
  );

  return (
    <FlatList
      title={null}
      cons={sortedCons}
      density={density}
      sortDesc={sortDesc}
    />
  );
}

function ConsByFollowed({
  cons,
  sortDesc,
  density,
}: {
  cons: ConWithPost[];
  sortDesc: boolean;
  density: Density;
}) {
  const followedConAttendees = useFollowedConAttendees();

  const sortedCons = useMemo(
    () =>
      sorted(
        cons,
        compareMany(
          comparing((con) =>
            followedConAttendees == null
              ? con.post.likeCount
              : (followedConAttendees[con.identifier] ?? []).length
          ),
          comparing((con) => con.post.likeCount)
        )
      ),
    [cons, followedConAttendees]
  );

  return (
    <FlatList
      title={null}
      cons={sortedCons}
      density={density}
      sortDesc={sortDesc}
    />
  );
}

function ConsByName({
  cons,
  sortDesc,
  density,
}: {
  cons: ConWithPost[];
  sortDesc: boolean;
  density: Density;
}) {
  const { i18n, t } = useLingui();

  const sortedCons = useMemo(
    () => {
      const collator = new Intl.Collator(i18n.locale);
      return sorted(cons, (x, y) => collator.compare(x.name, y.name));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cons, t]
  );

  return (
    <FlatList
      title={null}
      cons={sortedCons}
      density={density}
      sortDesc={sortDesc}
    />
  );
}

const SORT_BY = ["date", "name", "attendees", "followed"] as const;
type SortBy = (typeof SORT_BY)[number];

const DENSITY = ["comfortable", "cozy", "compact"] as const;
type Density = (typeof DENSITY)[number];

const DEFAULT_SORT_DESC_OPTIONS: Record<SortBy, boolean> = {
  date: false,
  name: false,
  attendees: true,
  followed: true,
};

export const LayoutOptions = qp.schema({
  sort: qp.default_(qp.literal(SORT_BY), "date"),
  desc: qp.flag,
  density: qp.default_(qp.literal(DENSITY), "comfortable"),
});
export type LayoutOptions = qp.Infer<typeof LayoutOptions>;

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

export default function ListView({
  cons,
  layout,
  setLayout,
  filter,
  setFilter,
}: {
  cons: ConWithPost[];
  layout: LayoutOptions;
  setLayout(layout: LayoutOptions): void;
  filter: FilterOptions;
  setFilter(filter: FilterOptions): void;
}) {
  const { t } = useLingui();

  const pred = useFilterPredicate(filter);
  const filteredCons = cons.filter(pred);

  const isLoggedIn = useIsLoggedIn();
  const [open, setOpen] = useState(false);

  const { data: followedConAttendees } = useFollowedConAttendeesDLE();

  return (
    <Box style={{ position: "relative" }}>
      <Container size="lg" px={0}>
        <FilterBar
          cons={cons}
          filledButton={false}
          filter={filter}
          setFilter={setFilter}
          rightSection={
            <>
              <Menu
                position="bottom-end"
                withArrow
                opened={open}
                onChange={setOpen}
              >
                <Menu.Target>
                  <Button
                    aria-label={t`Settings`}
                    variant="subtle"
                    size="xs"
                    c="dimmed"
                    color="var(--mantine-color-dimmed)"
                    style={{ zIndex: 4, flexShrink: 0 }}
                    leftSection={(() => {
                      const currentSortByDisplay =
                        SORT_BY_DISPLAYS[layout.sort];
                      return layout.desc ? (
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
                    {t(SORT_BY_DISPLAYS[layout.sort].name)}
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

                    const selected = layout.sort == sortBy;

                    return (
                      <Menu.Item
                        disabled={
                          sortBy == "followed" && followedConAttendees == null
                        }
                        aria-selected={selected}
                        onClick={() => {
                          setLayout({
                            ...layout,
                            sort: sortBy,
                            desc: DEFAULT_SORT_DESC_OPTIONS[sortBy],
                          });
                        }}
                        key={sortBy}
                        leftSection={
                          sortBy != "followed" ||
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
                        {t(SORT_BY_DISPLAYS[sortBy].name)}
                      </Menu.Item>
                    );
                  })}
                  <Menu.Label>
                    <Trans>Order</Trans>
                  </Menu.Label>
                  <Menu.Item
                    aria-selected={!layout.desc}
                    onClick={() => {
                      setLayout({
                        ...layout,
                        desc: false,
                      });
                    }}
                    leftSection={
                      <Group gap={6}>
                        {!layout.desc ? (
                          <IconCheck size={14} />
                        ) : (
                          <EmptyIcon size={14} />
                        )}
                        {(() => {
                          const Icon = SORT_BY_DISPLAYS[layout.sort].AscIcon;
                          return <Icon size={14} />;
                        })()}
                      </Group>
                    }
                  >
                    {t(SORT_BY_DISPLAYS[layout.sort].asc)}
                  </Menu.Item>
                  <Menu.Item
                    aria-selected={layout.desc}
                    onClick={() => {
                      setLayout({
                        ...layout,
                        desc: true,
                      });
                    }}
                    leftSection={
                      <Group gap={6}>
                        {layout.desc ? (
                          <IconCheck size={14} />
                        ) : (
                          <EmptyIcon size={14} />
                        )}
                        {(() => {
                          const Icon = SORT_BY_DISPLAYS[layout.sort].DescIcon;
                          return <Icon size={14} />;
                        })()}
                      </Group>
                    }
                  >
                    {t(SORT_BY_DISPLAYS[layout.sort].desc)}
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
              <LayoutSwitcher filter={filter} layoutType="list" />
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
        {filteredCons.length > 0 ? (
          <Container size="lg" px={0}>
            {layout.sort == "attendees" ? (
              <ConsByAttendees
                cons={filteredCons}
                sortDesc={layout.desc}
                density={layout.density}
              />
            ) : layout.sort == "followed" ? (
              <ConsByFollowed
                cons={filteredCons}
                sortDesc={layout.desc}
                density={layout.density}
              />
            ) : layout.sort == "name" ? (
              <ConsByName
                cons={filteredCons}
                sortDesc={layout.desc}
                density={layout.density}
              />
            ) : layout.sort == "date" ? (
              <ConsByDate
                cons={filteredCons}
                sortDesc={layout.desc}
                density={layout.density}
                hideEmptyGroups={filter.attending || filter.q != ""}
              />
            ) : (
              absurd(layout.sort)
            )}
          </Container>
        ) : (
          <EmptyState filter={filter} setFilter={setFilter} />
        )}
      </Suspense>
    </Box>
  );
}
