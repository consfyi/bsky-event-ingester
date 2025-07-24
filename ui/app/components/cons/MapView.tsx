import { Box, Center, Container, Loader } from "@mantine/core";
import { getDay, isAfter } from "date-fns";
import { Suspense, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { ConWithPost, useNow } from "~/hooks";
import * as qp from "~/qp";
import ConRow from "../ConRow";
import EmptyState from "../EmptyState";
import FilterBar, {
  FilterOptions,
  LayoutSwitcher,
  useFilterPredicate,
} from "../FilterBar";
import Map from "../Map";

export const LayoutOptions = qp.schema({
  center: qp.tuple({ lat: qp.float, lng: qp.float, zoom: qp.float }, " "),
});
export type LayoutOptions = qp.Infer<typeof LayoutOptions>;

export default function MapView({
  cons,
  layout,
  setLayout,
  filter,
  setFilter,
}: {
  cons: ConWithPost[];
  layout: LayoutOptions;
  setLayout(layout: LayoutOptions): void;
  filter: FilterOptions;
  setFilter(filter: FilterOptions): void;
}) {
  const location = useLocation();
  const navigate = useNavigate();

  const slug = location.hash != "" ? location.hash.slice(1) : null;

  const selected = useMemo(
    () => (slug != null ? cons.find((con) => con.id == slug) ?? null : null),
    [slug, cons]
  );

  const [center] = useState(() => {
    if (layout.center != null) {
      return layout.center;
    }
    if (selected != null && selected.latLng != null) {
      const [lat, lng] = selected.latLng;
      return { lat, lng, zoom: 17 };
    }
    return null;
  });
  const now = useNow();

  const pred = useFilterPredicate(filter);
  const filteredCons = cons.filter(pred);

  return (
    <Box style={{ position: "relative" }}>
      <Container
        size="lg"
        px={0}
        style={{
          left: 0,
          right: 0,
          top: 50,
          position: "absolute",
          zIndex: 1,
        }}
      >
        <FilterBar
          cons={cons}
          filledButton={true}
          filter={filter}
          setFilter={setFilter}
          rightSection={
            <>
              <LayoutSwitcher filter={filter} layoutType="map" />
            </>
          }
        />
      </Container>

      <Suspense
        fallback={
          <Center p="lg">
            <Loader />
          </Center>
        }
      >
        <Box h="100dvh" mt={-50}>
          <Suspense
            fallback={
              <Center p="lg" h="100%">
                <Loader />
              </Center>
            }
          >
            <Map
              style={{
                position: "absolute",
                height: "100%",
                top: 0,
                left: 0,
              }}
              selected={selected != null ? selected.labelId : null}
              setSelected={(identifier) => {
                const con =
                  identifier != null
                    ? cons.find((con) => con.id == identifier)
                    : null;
                setLayout({
                  ...layout,
                });
                navigate(
                  {
                    pathname: location.pathname,
                    search: location.search,
                    hash: con != null ? con.id : "",
                  },
                  { replace: true }
                );
              }}
              pins={filteredCons.flatMap((con) => {
                if (con.latLng == null) {
                  return [];
                }

                const [lat, lng] = con.latLng;
                const active =
                  isAfter(now, con.start) && !isAfter(now, con.end);

                const color = [
                  "red",
                  "orange",
                  "yellow",
                  "green",
                  "blue",
                  "indigo",
                  "violet",
                ][getDay(con.start)];

                const variant =
                  con.post.viewer != null && con.post.viewer.like != null
                    ? "filled"
                    : "light";

                return [
                  {
                    id: con.id,
                    lat,
                    lng,
                    active,
                    color,
                    variant,
                    zIndex:
                      con.post.viewer != null && con.post.viewer.like != null
                        ? 2
                        : active
                        ? 1
                        : 0,
                    popup: (
                      <ConRow
                        con={con}
                        showMonthInIcon
                        showEndDateOnly={false}
                        showLocation="break"
                        showFollowed
                        showLikeButton
                        density="cozy"
                        showDuration={false}
                        withId={false}
                      />
                    ),
                  },
                ];
              })}
              initialCenter={center}
              setCenter={(center) => setLayout({ ...layout, center })}
            />
            {filteredCons.length == 0 ? (
              <Center
                style={{
                  position: "absolute",
                  height: "100%",
                  top: 0,
                  left: 0,
                  right: 0,
                  background:
                    "color-mix(in srgb, var(--mantine-color-body), transparent 50%)",
                }}
              >
                <EmptyState filter={filter} setFilter={setFilter} />
              </Center>
            ) : null}
          </Suspense>
        </Box>
      </Suspense>
    </Box>
  );
}
