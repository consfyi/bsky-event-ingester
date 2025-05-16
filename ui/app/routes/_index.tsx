import { Alert, Anchor, Center, Loader, Table, Text } from "@mantine/core";
import type { MetaFunction } from "@remix-run/node";
import { Link } from "@remix-run/react";
import { groupBy } from "lodash-es";
import { format as formatDate, addMonths, setDate } from "date-fns";
import { Fragment, useMemo } from "react";
import { useCons } from "~/hooks";
import { IconCalendar, IconMapPin } from "@tabler/icons-react";

function* monthRange(start: Date, end: Date): Generator<Date> {
  while (start < end) {
    yield start;
    start = addMonths(start, 1);
  }
}

export const meta: MetaFunction = () => {
  return [{ title: "conlabels.furryli.st" }];
};

export default function Index() {
  const { cons, error, isLoading } = useCons();

  const consByMonth = useMemo(() => {
    if (cons == null) {
      return null;
    }

    return groupBy(cons, (con) => {
      return formatDate(con.start, "yyyy-MM");
    });
  }, [cons]);

  if (error != null) {
    return (
      <Alert color="red" title="Error">
        <Text size="sm">Couldn’t load con data.</Text>
        <pre>{error.toString()}</pre>
      </Alert>
    );
  }

  if (isLoading) {
    return (
      <Center p="lg">
        <Loader></Loader>
      </Center>
    );
  }

  if (cons == null || consByMonth == null) {
    return (
      <Alert color="red" title="Error">
        <Text size="sm">Couldn’t load con data.</Text>
      </Alert>
    );
  }

  const firstDate = setDate(cons[0].start, 1);
  const lastDate = addMonths(setDate(cons[cons.length - 1].start, 1), 1);

  return (
    <Table>
      <Table.Tbody>
        {Array.from(monthRange(firstDate, lastDate)).map((date) => {
          const groupKey = formatDate(date, "yyyy-MM");
          return (
            <Fragment key={groupKey}>
              <Table.Tr bg="var(--mantine-color-gray-0)">
                <Table.Th>
                  <Text fw={500} size="md">
                    {MONTH_FORMAT.format(date)} {formatDate(date, "yyyy")}
                  </Text>
                </Table.Th>
              </Table.Tr>
              {(consByMonth[groupKey] ?? []).map((con) => (
                <Table.Tr key={con.identifier}>
                  <Table.Td>
                    <Text size="sm">
                      <Anchor<typeof Link>
                        fw={500}
                        component={Link}
                        to={`/cons/${con.identifier}`}
                      >
                        {con.name}
                      </Anchor>
                    </Text>
                    <Text size="sm">
                      <IconCalendar size={12} />{" "}
                      {WEEKDAY_FORMAT.format(con.start)}{" "}
                      {formatDate(con.start, "yyyy-MM-dd")} –{" "}
                      {WEEKDAY_FORMAT.format(con.end)}{" "}
                      {formatDate(con.end, "yyyy-MM-dd")} •{" "}
                      <IconMapPin size={12} />{" "}
                      <Anchor
                        href={`https://www.google.com/maps?q=${con.location}`}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          color: "unset",
                        }}
                      >
                        {con.location}
                      </Anchor>
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Fragment>
          );
        })}
      </Table.Tbody>
    </Table>
  );
}

const MONTH_FORMAT = new Intl.DateTimeFormat("en", { month: "long" });
const WEEKDAY_FORMAT = new Intl.DateTimeFormat("en", { weekday: "short" });
