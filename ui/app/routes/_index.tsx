import { Center, Loader } from "@mantine/core";
import type { MetaFunction } from "@remix-run/node";
import { Suspense } from "react";
import ConsList from "~/components/ConsList";
import SimpleErrorBoundary from "~/components/SimpleErrorBoundary";
import { useConsWithPosts } from "~/hooks";
import clientMetadata from "../../public/client-metadata.json";

export const meta: MetaFunction = ({ matches }) => [
  ...matches.flatMap((match) => match.meta ?? []),
  { title: clientMetadata.client_name },
];

export default function Index() {
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
          <ConsList cons={cons} />
        </Suspense>
      </SimpleErrorBoundary>
    </>
  );
}
