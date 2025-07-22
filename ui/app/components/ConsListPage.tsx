import { Center, Loader } from "@mantine/core";
import { Fragment, Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import absurd from "~/absurd";
import ConsList, {
  CalendarLayoutOptions,
  FilterOptions,
  ListLayoutOptions,
  MapLayoutOptions,
  ViewOptions,
} from "~/components/ConsList";
import SimpleErrorBoundary from "~/components/SimpleErrorBoundary";
import { useConsWithPosts, useIsLoggedIn } from "~/hooks";
import * as qp from "~/qp";

function parseSearchParams(
  layoutType: "calendar" | "map" | "list",
  searchParams: URLSearchParams
): ViewOptions {
  return {
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
        : absurd(layoutType),
  };
}

export default function ConsListPage({
  layoutType,
}: {
  layoutType: "calendar" | "map" | "list";
}) {
  const cons = useConsWithPosts();

  const isLoggedIn = useIsLoggedIn();

  const [searchParams, setSearchParams] = useSearchParams();
  const [view, setView] = useState<ViewOptions>(() =>
    parseSearchParams(layoutType, searchParams)
  );

  const updatingFromSearchParams = useRef(false);

  useEffect(() => {
    updatingFromSearchParams.current = true;
    setView(parseSearchParams(view.layout.type, searchParams));
    updatingFromSearchParams.current = false;
  }, [searchParams, view.layout.type]);

  useEffect(() => {
    if (updatingFromSearchParams.current) {
      return;
    }

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
      default:
        absurd(view.layout);
        break;
    }

    setSearchParams(searchParams, { replace: true });
  }, [searchParams, view, setSearchParams]);

  return (
    <Fragment key={view.layout.type}>
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
    </Fragment>
  );
}
