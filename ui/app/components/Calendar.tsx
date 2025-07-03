import { useLingui } from "@lingui/react/macro";
import { Grid, Title } from "@mantine/core";
import { getDate, getDay, getDaysInMonth } from "date-fns";
import { Range, rotateLeft, toArray } from "iter-fns";
import { useMemo } from "react";

function weekdayNames(
  locale: string,
  format: Intl.DateTimeFormatOptions["weekday"]
): string[] {
  const dateTimeFormat = new Intl.DateTimeFormat(locale, { weekday: format });
  return Array.from({ length: 7 }, (_, i) =>
    dateTimeFormat.format(new Date(Date.UTC(2021, 5, i)))
  );
}

export default function Calendar({
  month,
  year,
}: {
  month: number;
  year: number;
}) {
  const { t, i18n } = useLingui();

  const names = useMemo(() => weekdayNames(i18n.locale, "short"), [t]);

  const weekdayOrder = useMemo(() => {
    const firstDay = 7; // TODO: Should be from locale.

    const weekdayOrder = toArray(Range.to(7));
    rotateLeft(weekdayOrder, firstDay);
    return weekdayOrder;
  }, [t]);

  const firstDate = new Date(year, month, 1);
  const daysInMonth = getDaysInMonth(firstDate);
  const firstDayWeekday = getDay(firstDate);

  return (
    <Grid columns={7}>
      {weekdayOrder.map((d) => (
        <Grid.Col span={1} key={d}>
          <Title order={2} size="h5" fw={500}>
            {names[d]}
          </Title>
        </Grid.Col>
      ))}
    </Grid>
  );
}
