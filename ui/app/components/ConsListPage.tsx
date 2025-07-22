import { Center, Loader } from "@mantine/core";
import { ReactNode, Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import SimpleErrorBoundary from "~/components/SimpleErrorBoundary";
import { ConWithPost, useConsWithPosts, useIsLoggedIn } from "~/hooks";
import * as qp from "~/qp";
import { FilterOptions } from "./FilterBar";

export default function ConsListPage<T extends qp.Schema>({
  LayoutOptions,
  Component,
}: {
  LayoutOptions: T;
  Component(props: {
    cons: ConWithPost[];
    layout: qp.InferSchema<typeof LayoutOptions>;
    setLayout(layout: qp.InferSchema<typeof LayoutOptions>): void;
    filter: FilterOptions;
    setFilter(filter: FilterOptions): void;
  }): ReactNode;
}) {
  const cons = useConsWithPosts();

  const isLoggedIn = useIsLoggedIn();

  const [searchParams, setSearchParams] = useSearchParams();
  const [view, setView] = useState<{
    filter: FilterOptions;
    layout: qp.InferSchema<typeof LayoutOptions>;
  }>(() => ({
    filter: qp.parse(FilterOptions, searchParams),
    layout: qp.parse(LayoutOptions, searchParams),
  }));

  const updatingFromSearchParams = useRef(false);

  useEffect(() => {
    updatingFromSearchParams.current = true;
    setView({
      filter: qp.parse(FilterOptions, searchParams),
      layout: qp.parse(LayoutOptions, searchParams),
    });
    updatingFromSearchParams.current = false;
  }, [searchParams, LayoutOptions]);

  useEffect(() => {
    if (updatingFromSearchParams.current) {
      return;
    }

    const searchParams = new URLSearchParams();

    qp.serialize(FilterOptions, view.filter, searchParams);
    qp.serialize(LayoutOptions, view.layout, searchParams);

    setSearchParams(searchParams, { replace: true });
  }, [searchParams, view, setSearchParams, LayoutOptions]);

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
          <Component
            cons={cons}
            filter={{
              ...view.filter,
              attending: isLoggedIn && view.filter.attending,
              followed: isLoggedIn && view.filter.followed,
            }}
            setFilter={(filter) => {
              setView({ ...view, filter });
            }}
            layout={view.layout}
            setLayout={(layout) => {
              setView({ ...view, layout });
            }}
          />
        </Suspense>
      </SimpleErrorBoundary>
    </>
  );
}
