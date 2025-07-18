import { Center, Loader } from "@mantine/core";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import ConsList, {
  CalendarLayoutOptions,
  DEFAULT_CALENDAR_LAYOUT_OPTIONS,
  DEFAULT_FILTER_OPTIONS,
  DEFAULT_LIST_LAYOUT_OPTIONS,
  DEFAULT_MAP_LAYOUT_OPTIONS,
  FilterOptions,
  ListLayoutOptions,
  MapLayoutOptions,
  ViewOptions,
} from "~/components/ConsList";
import SimpleErrorBoundary from "~/components/SimpleErrorBoundary";
import { useConsWithPosts, useIsLoggedIn } from "~/hooks";
import * as qp from "~/qp";

export default function ConsListPage({
  layoutType,
}: {
  layoutType: "calendar" | "map" | "list";
}) {
  const cons = useConsWithPosts();

  const [searchParams] = useSearchParams();

  const isLoggedIn = useIsLoggedIn();

  const [view, setView] = useState<ViewOptions>(() => ({
    filter: qp.parse(FilterOptions, searchParams),
    layout:
      layoutType == "calendar"
        ? {
            type: "calendar",
            options: qp.parse(CalendarLayoutOptions, searchParams),
          }
        : layoutType == "map"
        ? {
            type: "map",
            options: qp.parse(MapLayoutOptions, searchParams),
          }
        : layoutType == "list"
        ? {
            type: "list",
            options: qp.parse(ListLayoutOptions, searchParams),
          }
        : (null as never),
  }));

  useEffect(() => {
    const searchParams = new URLSearchParams();
    qp.serialize(FilterOptions, view.filter, searchParams);
    switch (view.layout.type) {
      case "calendar":
        qp.serialize(CalendarLayoutOptions, view.layout.options, searchParams);
        break;
      case "list":
        qp.serialize(ListLayoutOptions, view.layout.options, searchParams);
        break;
      case "map":
        qp.serialize(MapLayoutOptions, view.layout.options, searchParams);
        break;
    }

    let url =
      view.layout.type == "calendar"
        ? "/calendar"
        : view.layout.type == "map"
        ? "/map"
        : "/";
    if (searchParams.size > 0) {
      url += `?${searchParams.toString()}`;
    }

    window.history.pushState({}, "", url);
  }, [view]);

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
            view={{
              ...view,
              filter: {
                ...view.filter,
                attending: isLoggedIn && view.filter.attending,
                followed: isLoggedIn && view.filter.followed,
              },
            }}
            setView={setView}
          />
        </Suspense>
      </SimpleErrorBoundary>
    </>
  );
}
