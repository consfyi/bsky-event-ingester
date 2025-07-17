import { Center, Loader } from "@mantine/core";
import deepEqual from "deep-equal";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams, type MetaFunction } from "react-router";
import ConsList, {
  DEFAULT_VIEW_OPTIONS,
  ViewOptions,
} from "~/components/ConsList";
import SimpleErrorBoundary from "~/components/SimpleErrorBoundary";
import { useConsWithPosts, useIsLoggedIn } from "~/hooks";
import clientMetadata from "../../public/client-metadata.json";

export const meta: MetaFunction = ({ matches }) => [
  ...matches.flatMap((match) => match.meta ?? []),
  { title: clientMetadata.client_name },
];

export default function Index() {
  const cons = useConsWithPosts();

  const [searchParams, setSearchParams] = useSearchParams();

  const isLoggedIn = useIsLoggedIn();

  const [viewOptions, setViewOptions] = useState<ViewOptions>(() => {
    if (!searchParams.has("q")) {
      return DEFAULT_VIEW_OPTIONS;
    }

    try {
      return ViewOptions.parse(JSON.parse(searchParams.get("q")!));
    } catch (e) {
      return DEFAULT_VIEW_OPTIONS;
    }
  });

  useEffect(() => {
    if (isLoggedIn) {
      return;
    }
    setViewOptions((vo) => ({
      ...vo,
      sort:
        vo.layout.type == "list"
          ? {
              ...vo.layout,
              sort: vo.layout.sort == "followed" ? "attendees" : vo.layout.sort,
            }
          : vo.layout,
    }));
  }, [isLoggedIn, setViewOptions]);

  useEffect(() => {
    setSearchParams(
      (prev) => {
        if (deepEqual(viewOptions, DEFAULT_VIEW_OPTIONS)) {
          prev.delete("q");
        } else {
          prev.set("q", JSON.stringify(viewOptions));
        }
        return prev;
      },
      {
        replace: true,
        preventScrollReset: true,
      }
    );
  }, [viewOptions]);

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
          <ConsList
            cons={cons}
            viewOptions={{
              ...viewOptions,
              filter: {
                ...viewOptions.filter,
                attending: isLoggedIn && viewOptions.filter.attending,
                followed: isLoggedIn && viewOptions.filter.followed,
              },
            }}
            setViewOptions={setViewOptions}
          />
        </Suspense>
      </SimpleErrorBoundary>
    </>
  );
}
