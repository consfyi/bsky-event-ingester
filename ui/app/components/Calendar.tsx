import { Trans, useLingui } from "@lingui/react/macro";
import {
  Anchor,
  Box,
  Group,
  Switch,
  Table,
  Text,
  Title,
  useMantineTheme,
} from "@mantine/core";
import {
  addDays,
  addWeeks,
  Day,
  differenceInCalendarDays,
  endOfWeek,
  getDate,
  getDay,
  getMonth,
  getYear,
  isAfter,
  isBefore,
  isSameDay,
  startOfDay,
  startOfWeek,
} from "date-fns";
import { comparing, map, max, min, Range, sorted, toArray } from "iter-fns";
import {
  Fragment,
  ReactNode,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router";
import { reinterpretAsLocalDate } from "~/date";
import { useNow } from "~/hooks";

export interface Event {
  link: string;
  title: string;
  label: React.ReactNode;
  start: Date;
  end: Date;
}

interface Segment {
  event: Event;
  start: Date;
  end: Date;
  hasStart: boolean;
  hasEnd: boolean;
}

function segment(event: Event, weekStartsOn: Day): Segment[] {
  const segments: Segment[] = [];

  let segmentStart = startOfDay(new Date(event.start));
  const eventEnd = startOfDay(new Date(event.end));

  while (isBefore(segmentStart, eventEnd)) {
    const weekStart = startOfWeek(segmentStart, { weekStartsOn });
    const weekEnd = startOfDay(
      addDays(endOfWeek(segmentStart, { weekStartsOn }), 1)
    );

    const segment: Segment = {
      event,
      start: isAfter(segmentStart, weekStart) ? segmentStart : weekStart,
      end: isBefore(eventEnd, weekEnd) ? eventEnd : weekEnd,
      hasStart: false,
      hasEnd: false,
    };

    segments.push(segment);

    segmentStart = addWeeks(weekStart, 1);
  }

  segments[0].hasStart = true;
  segments[segments.length - 1].hasEnd = true;

  return segments;
}

function packLanes(
  events: Event[],
  calendarStartDate: Date,
  numWeeks: number,
  weekStartsOn: Day
): (Segment | null)[][][] {
  const weeks = Array.from({ length: numWeeks }, () =>
    Array.from({ length: 7 }, () => [] as (Segment | null)[])
  );

  for (const event of sorted(
    events,
    comparing((event) => startOfDay(new Date(event.start)))
  )) {
    for (const seg of segment(event, weekStartsOn)) {
      const weekStart = startOfWeek(seg.start, { weekStartsOn });

      const week =
        weeks[
          Math.floor(differenceInCalendarDays(weekStart, calendarStartDate) / 7)
        ];

      const dayIndex = differenceInCalendarDays(seg.start, weekStart);
      const length = differenceInCalendarDays(seg.end, seg.start);

      let laneIndex = 0;
      findLane: while (true) {
        for (
          let offset = 0;
          offset < length && dayIndex + offset < 7;
          ++offset
        ) {
          if (week[dayIndex + offset][laneIndex] !== undefined) {
            ++laneIndex;
            continue findLane;
          }
        }
        week[dayIndex][laneIndex] = seg;
        break;
      }

      for (let offset = 1; offset < length && dayIndex + offset < 7; ++offset) {
        week[dayIndex + offset][laneIndex] = null;
      }
    }
  }

  for (const week of weeks) {
    for (const day of week) {
      let lastFilled = day.length - 1;
      while (lastFilled >= 0 && day[lastFilled] == null) {
        --lastFilled;
      }
      day.length = lastFilled + 1;
    }
  }

  return weeks;
}

function EventSegment({ segment }: { segment: Segment }) {
  const theme = useMantineTheme();

  const length = differenceInCalendarDays(segment.end, segment.start);

  const color = [
    "red",
    "orange",
    "yellow",
    "green",
    "blue",
    "indigo",
    "violet",
  ][getDay(segment.event.start)];

  const colors = theme.variantColorResolver({
    theme,
    color,
    variant: "light",
  });

  return (
    <Anchor
      title={segment.event.title}
      underline="never"
      to={segment.event.link}
      component={Link}
    >
      <Text
        mb={2}
        px="xs"
        pos="relative"
        size="sm"
        c={colors.color}
        bg={`color-mix(in srgb, var(--mantine-color-${color}-filled), var(--mantine-color-body) 90%)`}
        w={`calc(${length} * (100% + 1px) - 1px)`}
        left={0}
        truncate
        style={{
          borderColor: colors.color,
          borderStyle: "solid",
          borderTopWidth: "1px",
          borderBottomWidth: "1px",
          borderLeftWidth: segment.hasStart ? "1px" : 0,
          borderRightWidth: segment.hasEnd ? "1px" : 0,
          borderTopLeftRadius: segment.hasStart ? "100px" : 0,
          borderBottomLeftRadius: segment.hasStart ? "100px" : 0,
          borderTopRightRadius: segment.hasEnd ? "100px" : 0,
          borderBottomRightRadius: segment.hasEnd ? "100px" : 0,
          zIndex: 1,
        }}
      >
        {segment.event.label}
      </Text>
    </Anchor>
  );
}

export default function Calendar({ events }: { events: Event[] }) {
  const { t, i18n } = useLingui();

  const [useLocalTime, setUseLocalTime] = useState(false);
  if (!useLocalTime) {
    events = events.map((e) => ({
      ...e,
      start: reinterpretAsLocalDate(e.start),
      end: reinterpretAsLocalDate(e.end),
    }));
  }

  const weekInfo = useMemo(() => {
    const locale = new Intl.Locale(i18n.locale);
    const weekInfo = (
      locale as {
        getWeekInfo?(): { firstDay: number; weekend: number[] };
      }
    ).getWeekInfo?.() ?? { firstDay: 7, weekend: [6, 7] };

    return {
      firstDay: (weekInfo.firstDay % 7) as Day,
      weekend: weekInfo.weekend.map((d) => (d % 7) as Day),
    };
  }, [t]);

  const checkpointRefs = useRef<Record<number, HTMLDivElement>>({});
  checkpointRefs.current = {};

  const observerRef = useRef<IntersectionObserver | null>(null);

  const [visibleMonths, setVisibleMonths] = useState<number[]>([]);

  useLayoutEffect(() => {
    if (observerRef.current != null) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }

    observerRef.current = new IntersectionObserver(
      (entries) => {
        setVisibleMonths((visibleMonths) => {
          const set = new Set<number>(visibleMonths);
          for (const entry of entries) {
            const k = parseInt(
              (entry.target as HTMLElement).dataset.month!,
              10
            );
            if (entry.isIntersecting) {
              set.add(k);
            } else {
              set.delete(k);
            }
          }
          return toArray(set);
        });
      },
      { rootMargin: "-50px 0px 0px 0px" }
    );

    for (const el of Object.values(checkpointRefs.current)) {
      observerRef.current.observe(el);
    }

    return () => {
      if (observerRef.current != null) {
        observerRef.current.disconnect();
      }
    };
  }, [events]);

  const now = useNow();
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null);

  const startDate = useMemo(() => {
    const d = min(map(events, (con) => new Date(con.start)))!;
    return startOfDay(isBefore(now, d) ? now : d);
  }, [events, now]);

  const firstDayWeekday = getDay(startDate);
  const daysToPad = (firstDayWeekday - weekInfo.firstDay + 7) % 7;

  const calendarStartDate = addDays(startDate, -daysToPad);

  const numWeeks = useMemo(
    () =>
      Math.floor(
        differenceInCalendarDays(
          max(map(events, (con) => addDays(con.end, 6)))!,
          calendarStartDate
        ) / 7
      ),
    [events, calendarStartDate]
  );

  const packed = useMemo(
    () => packLanes(events, calendarStartDate, numWeeks, weekInfo.firstDay),
    [events]
  );

  const highlightedMonthIndex =
    min(visibleMonths) ??
    getYear(calendarStartDate) * 12 + getMonth(calendarStartDate);

  return (
    <>
      <Title
        mb={-1}
        mx={{ base: 0, lg: "xs" }}
        px={{ base: "xs", lg: 0 }}
        mt={{ base: -4, lg: -8 }}
        order={2}
        size="h5"
        fw={500}
        pos="sticky"
        top={50}
        style={{
          zIndex: 3,
          borderBottom:
            "calc(0.0625rem * var(--mantine-scale)) solid var(--mantine-color-default-border)",
        }}
      >
        <Box
          mx="calc(var(--mantine-spacing-xs) * -1)"
          px="xs"
          pt={{ base: 4, lg: 8 }}
          pb={4}
          bg="var(--mantine-color-body)"
        >
          {i18n.date(
            new Date(
              Math.floor(highlightedMonthIndex / 12),
              highlightedMonthIndex % 12,
              1
            ),
            {
              month: "long",
              year: "numeric",
            }
          )}
        </Box>
      </Title>
      <Box mx={{ base: 0, lg: "xs" }} mb={{ base: -1, lg: "xs" }}>
        <Table layout="fixed" withColumnBorders withRowBorders withTableBorder>
          <Table.Thead>
            <Table.Tr>
              {toArray(
                map(Range.to(7), (i) => {
                  const d = addDays(calendarStartDate, i);
                  return (
                    <Table.Th
                      key={i}
                      bg={
                        weekInfo.weekend.includes(getDay(d) as Day)
                          ? "var(--mantine-color-gray-light)"
                          : ""
                      }
                    >
                      <Text size="md">
                        {i18n.date(d, {
                          weekday: "short",
                        })}
                      </Text>
                    </Table.Th>
                  );
                })
              )}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {toArray(
              map(Range.to(numWeeks), (week) => {
                const weekStart = addDays(calendarStartDate, week * 7);
                const lanes = packed[week];

                return (
                  <Table.Tr
                    key={week}
                    data-month={getYear(weekStart) * 12 + getMonth(weekStart)}
                    ref={(el) => {
                      if (
                        el == null ||
                        Math.ceil(
                          (getDate(weekStart) + getDay(weekStart)) / 7
                        ) != 1
                      ) {
                        return;
                      }

                      checkpointRefs.current[
                        getYear(weekStart) * 12 + getMonth(weekStart)
                      ] = el;
                    }}
                  >
                    {toArray(
                      map(Range.to(7), (offset) => {
                        const d = addDays(weekStart, offset);
                        const segments = lanes[offset];

                        return (
                          <Table.Td
                            p={0}
                            h={100}
                            key={offset}
                            align="left"
                            valign="top"
                            pos="relative"
                            bg={
                              weekInfo.weekend.includes(getDay(d) as Day)
                                ? "var(--mantine-color-gray-light)"
                                : ""
                            }
                          >
                            <Text
                              m="xs"
                              mb={2}
                              size="sm"
                              fw={500}
                              truncate
                              {...(isSameDay(d, now)
                                ? {
                                    color: "red",
                                  }
                                : {
                                    color:
                                      getYear(d) * 12 + getMonth(d) ==
                                      highlightedMonthIndex
                                        ? ""
                                        : "var(--mantine-color-disabled-color)",
                                  })}
                            >
                              {getDate(d) == 1
                                ? i18n.date(d, {
                                    month: "short",
                                  })
                                : getDate(d)}
                            </Text>
                            {segments.map((seg, i) =>
                              seg != null ? (
                                <EventSegment segment={seg} key={i} />
                              ) : (
                                <Text
                                  mb={2}
                                  px="xs"
                                  pos="relative"
                                  size="sm"
                                  bd="1px solid transparent"
                                >
                                  &nbsp;
                                </Text>
                              )
                            )}
                          </Table.Td>
                        );
                      })
                    )}
                  </Table.Tr>
                );
              })
            )}
          </Table.Tbody>
        </Table>
      </Box>
    </>
  );
}
