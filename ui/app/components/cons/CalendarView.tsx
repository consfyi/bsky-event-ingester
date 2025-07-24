import { Trans, useLingui } from "@lingui/react/macro";
import {
  Box,
  Button,
  Center,
  Container,
  Loader,
  Menu,
  Text,
} from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import { IconCheck, IconChevronDown, IconSettings } from "@tabler/icons-react";
import { Day, getDay } from "date-fns";
import { Suspense, useState } from "react";
import Flag from "~/components/Flag";
import { ConWithPost } from "~/hooks";
import * as qp from "~/qp";
import Calendar from "../Calendar";
import EmptyIcon from "../EmptyIcon";
import EmptyState from "../EmptyState";
import FilterBar, {
  FilterOptions,
  LayoutSwitcher,
  useFilterPredicate,
} from "../FilterBar";

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

export const LayoutOptions = qp.schema({
  timezone: qp.default_(qp.literal(["theirs", "yours"]), "theirs"),
});
export type LayoutOptions = qp.Infer<typeof LayoutOptions>;

const FIRST_DAYS_OF_WEEK: Day[] = [0, 1, 6];

export default function CalendarView({
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
  const pred = useFilterPredicate(filter);
  const filteredCons = cons.filter(pred);

  const { i18n, t } = useLingui();

  const compact = filter.attending || filter.q != "";
  const [firstDayOfWeek, setFirstDayOfWeek] = useFirstDayOfWeek();
  const [open, setOpen] = useState(false);

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
                      layout.timezone == "theirs" ? (
                        <IconCheck size={14} />
                      ) : (
                        <EmptyIcon size={14} />
                      )
                    }
                    onClick={() => {
                      setLayout({
                        ...layout,
                        timezone: "theirs",
                      });
                    }}
                  >
                    <Trans>Theirs</Trans>
                  </Menu.Item>
                  <Menu.Item
                    leftSection={
                      layout.timezone == "yours" ? (
                        <IconCheck size={14} />
                      ) : (
                        <EmptyIcon size={14} />
                      )
                    }
                    onClick={() => {
                      setLayout({
                        ...layout,
                        timezone: "yours",
                      });
                    }}
                  >
                    <Trans>Yours</Trans>
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
              <LayoutSwitcher filter={filter} layoutType="calendar" />
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
            <Calendar
              firstDay={firstDayOfWeek}
              inYourTimeZone={layout.timezone == "yours"}
              includeToday={!compact}
              events={filteredCons.map((con) => ({
                id: con.identifier,
                anchor: con.slug,
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
        ) : (
          <EmptyState filter={filter} setFilter={setFilter} />
        )}
      </Suspense>
    </Box>
  );
}
