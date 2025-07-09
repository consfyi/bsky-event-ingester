import { Trans, useLingui } from "@lingui/react/macro";
import {
  Box,
  Button,
  Center,
  Group,
  Loader,
  Slider,
  Switch,
  Text,
} from "@mantine/core";
import { Suspense, useEffect, useState } from "react";
import Calendar from "~/components/Calendar";
import Flag from "~/components/Flag";
import SimpleErrorBoundary from "~/components/SimpleErrorBoundary";
import { reinterpretAsLocalDate } from "~/date";
import { useConsWithPosts } from "~/hooks";

export default function Index() {
  const { t } = useLingui();

  useEffect(() => {
    document.title = t`Calendar`;
  }, [t]);

  const [useLocalTime, setUseLocalTime] = useState(false);

  const cons = useConsWithPosts();

  return (
    <>
      <SimpleErrorBoundary>
        <Suspense
          fallback={
            <Center p="lg">
              <Loader />
            </Center>
          }
        >
          <Group wrap="nowrap" m="xs" justify="space-between" gap="0">
            <Box />
            <Switch
              onClick={() => {
                setUseLocalTime(!useLocalTime);
              }}
              checked={useLocalTime}
              labelPosition="left"
              label={<Trans>Use local time</Trans>}
            />
          </Group>
          <Box m="xs">
            <Calendar
              events={cons.map((con) => ({
                label: (
                  <>
                    <Flag country={con.country} size={8} me={4} />
                    {con.name}
                  </>
                ),
                title: con.name,
                link: `/cons/${con.slug}`,
                start: useLocalTime
                  ? con.start
                  : reinterpretAsLocalDate(con.start),
                end: useLocalTime ? con.end : reinterpretAsLocalDate(con.end),
              }))}
            />
          </Box>
        </Suspense>
      </SimpleErrorBoundary>
    </>
  );
}
