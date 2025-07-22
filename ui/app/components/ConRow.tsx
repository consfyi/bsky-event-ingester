import { plural } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import {
  Anchor,
  Box,
  Group,
  Indicator,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from "@mantine/core";
import {
  IconCalendar,
  IconCalendarWeek,
  IconMapPin,
  IconUsers,
} from "@tabler/icons-react";
import { differenceInDays, getDay, getYear, isAfter, subDays } from "date-fns";
import { sample } from "iter-fns";
import { useMemo } from "react";
import { Link } from "react-router";

import Avatar from "~/components/Avatar";
import Flag from "~/components/Flag";
import LikeButton from "~/components/LikeButton";
import { reinterpretAsLocalDate } from "~/date";
import { ConWithPost, useFollowedConAttendeesDLE, useNow } from "~/hooks";
import classes from "./ConRow.module.css";

const MAX_AVATARS_IN_STACK = 3;

export default function ConRow({
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
