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
  Title,
} from "@mantine/core";
import { Suspense, useEffect, useState } from "react";
import Calendar from "~/components/Calendar";
import Flag from "~/components/Flag";
import SimpleErrorBoundary from "~/components/SimpleErrorBoundary";
import { reinterpretAsLocalDate } from "~/date";
import { useConsWithPosts } from "~/hooks";

export default function Index() {
  const { i18n, t } = useLingui();

  useEffect(() => {
    document.title = t`Calendar`;
  }, [t]);

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
              start: con.start,
              end: con.end,
            }))}
          />
        </Suspense>
      </SimpleErrorBoundary>
    </>
  );
}
