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
import { Fragment, Suspense, useMemo, useState } from "react";
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
                  showLocation="inline"
                  showFollowed
                  showLikeButton
                  showBigIcon
                  showDuration
                  withId
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
              showLocation="inline"
              showFollowed
              showLikeButton
              showBigIcon
              showDuration
              withId
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

export const LayoutOptions = qp.schema({
  sort: qp.scalar(qp.enum_(SORT_BY), "date"),
  desc: qp.scalar(qp.boolean, false),
});
export type LayoutOptions = qp.InferSchema<typeof LayoutOptions>;

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

  const compact = filter.attending || filter.q != "";

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
              <ConsByAttendees cons={filteredCons} sortDesc={layout.desc} />
            ) : layout.sort == "followed" ? (
              <ConsByFollowed cons={filteredCons} sortDesc={layout.desc} />
            ) : layout.sort == "name" ? (
              <ConsByName cons={filteredCons} sortDesc={layout.desc} />
            ) : layout.sort == "date" ? (
              <ConsByDate
                cons={filteredCons}
                sortDesc={layout.desc}
                hideEmptyGroups={compact}
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
