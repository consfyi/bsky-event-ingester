import { useLingui } from "@lingui/react/macro";
import { Anchor, Table, Text, useMantineTheme } from "@mantine/core";
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
  isBefore,
  isEqual,
  isSameDay,
  startOfWeek,
} from "date-fns";
import { map, max, min, Range, toArray } from "iter-fns";
import { Fragment, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
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
}

function segment(event: Event, weekStartsOn: Day): Segment[] {
  const segments: Segment[] = [];

  let segmentStart = event.start;

  while (isBefore(segmentStart, event.end)) {
    const weekStart = startOfWeek(segmentStart, { weekStartsOn });
    const weekEnd = addDays(endOfWeek(segmentStart, { weekStartsOn }), 1);

    const segment: Segment = {
      event,
      start: segmentStart > weekStart ? segmentStart : weekStart,
      end: event.end < weekEnd ? event.end : weekEnd,
    };

    segments.push(segment);

    segmentStart = addWeeks(weekStart, 1);
  }

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

  for (const event of events) {
    for (const seg of segment(event, weekStartsOn)) {
      const weekStart = startOfWeek(seg.start, { weekStartsOn });

      const week =
        weeks[
          Math.floor(differenceInCalendarDays(weekStart, calendarStartDate) / 7)
        ];

      const dayIndex = differenceInCalendarDays(seg.start, weekStart);

      const span = differenceInCalendarDays(seg.end, seg.start);

      let laneIndex = 0;
      while (true) {
        let fits = true;
        for (let offset = 0; offset < span && dayIndex + offset < 7; ++offset) {
          if (week[dayIndex + offset][laneIndex] !== undefined) {
            fits = false;
            break;
          }
        }
        if (fits) {
          break;
        }
        ++laneIndex;
      }

      for (let offset = 0; offset < span && dayIndex + offset < 7; ++offset) {
        if (week[dayIndex + offset][laneIndex] == null) {
          week[dayIndex + offset][laneIndex] = offset == 0 ? seg : null;
        }
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

export default function Calendar({ events }: { events: Event[] }) {
  const { t, i18n } = useLingui();

  const theme = useMantineTheme();

  const weekInfo = useMemo(() => {
    const locale = new Intl.Locale(i18n.locale);
    const weekInfo = (
      locale as { getWeekInfo?(): { firstDay: number; weekend: number[] } }
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

  const startDate = useMemo(() => {
    const d = min(map(events, (con) => con.start))!;
    return now < d ? now : d;
  }, [events, now]);

  const firstDayWeekday = getDay(startDate);
  const daysToPad = (firstDayWeekday - weekInfo.firstDay + 7) % 7;

  const calendarStartDate = addDays(startDate, -daysToPad);

  const numWeeks = useMemo(
    () =>
      Math.ceil(
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
  console.log(packed);

  const highlightedMonthIndex = min(visibleMonths);

  return (
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
                  {i18n.date(d, {
                    weekday: "short",
                  })}
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
                    Math.ceil((getDate(weekStart) + getDay(weekStart)) / 7) != 1
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
                          {...(isSameDay(d, now)
                            ? { color: "red", fw: 500 }
                            : {
                                color:
                                  getYear(d) * 12 + getMonth(d) ==
                                  highlightedMonthIndex
                                    ? ""
                                    : "var(--mantine-color-dimmed)",
                              })}
                        >
                          {getDate(d) == 1
                            ? i18n.date(d, {
                                month: "short",
                                year: getMonth(d) == 0 ? "numeric" : undefined,
                              })
                            : getDate(d)}
                        </Text>
                        {segments.map((seg, i) => {
                          const length =
                            seg != null
                              ? differenceInCalendarDays(seg.end, seg.start)
                              : 1;

                          const colors =
                            seg != null
                              ? theme.variantColorResolver({
                                  theme,
                                  color: [
                                    "red",
                                    "orange",
                                    "yellow",
                                    "green",
                                    "blue",
                                    "indigo",
                                    "violet",
                                  ][getDay(seg.event.start)],
                                  variant: "light",
                                })
                              : null;

                          return (
                            <Fragment key={i}>
                              {seg != null ? (
                                <Anchor
                                  title={seg.event.title}
                                  underline="never"
                                  to={seg.event.link}
                                  component={Link}
                                >
                                  <Text
                                    h="1lh"
                                    mb={2}
                                    px="xs"
                                    pos="relative"
                                    size="xs"
                                    c={colors != null ? colors.color : ""}
                                    bg={colors != null ? colors.background : ""}
                                    w={`calc(${length} * (100% + 1px) - 1px)`}
                                    left={0}
                                    truncate
                                    style={{
                                      borderTopLeftRadius:
                                        seg != null &&
                                        isSameDay(seg.start, seg.event.start)
                                          ? "100px"
                                          : 0,
                                      borderBottomLeftRadius:
                                        seg != null &&
                                        isSameDay(seg.start, seg.event.start)
                                          ? "100px"
                                          : 0,
                                      borderTopRightRadius:
                                        seg != null &&
                                        isSameDay(seg.end, seg.event.end)
                                          ? "100px"
                                          : 0,
                                      borderBottomRightRadius:
                                        seg != null &&
                                        isSameDay(seg.end, seg.event.end)
                                          ? "100px"
                                          : 0,
                                      zIndex: 1,
                                    }}
                                  >
                                    {seg.event.label}
                                  </Text>
                                </Anchor>
                              ) : (
                                <Text
                                  h="1lh"
                                  mb={2}
                                  px="xs"
                                  pos="relative"
                                  size="xs"
                                />
                              )}
                            </Fragment>
                          );
                        })}
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
  );
}
