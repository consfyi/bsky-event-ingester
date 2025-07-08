import { useLingui } from "@lingui/react/macro";
import { Box, Center, Loader } from "@mantine/core";
import { Suspense, useEffect } from "react";
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
          <Box mb="sm" p="xs">
            <Calendar
              events={cons.map((con) => ({
                label: (
                  <>
                    <Flag country={con.country} size={8} me={4} />
                    {con.name}
                  </>
                ),
                link: `/cons/${con.slug}`,
                start: reinterpretAsLocalDate(con.start),
                end: reinterpretAsLocalDate(con.end),
              }))}
            />
          </Box>
        </Suspense>
      </SimpleErrorBoundary>
    </>
  );
}
